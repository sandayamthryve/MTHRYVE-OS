// lib/snapfill/schema.ts — the SnapFill FIELD-WHITELIST contract.
//
// SnapFill is a reusable, fill-ONLY input layer. A mount hands it a `schema` — the
// list of fields (its "cluster's field whitelist") it is allowed to fill — and a
// `onFill` callback. SnapFill reads structured text (drag/paste) OR a photo (vision)
// and returns { key: value } for ONLY the whitelisted keys, ignoring everything
// else it sees. It NEVER writes to any table: the host's existing, already
// role-gated write path commits the values, so a metric cluster's snap still travels
// the sanctioned manual lane (manual_value / origin='vision') and can never overwrite
// an API-synced value.
//
// Honest nulls by construction: a field SnapFill can't read/parse is simply OMITTED
// from the result — never filled with a fabricated 0 / "" / guess.
//
// Kept dependency-free (no server or React imports) so both the "use client"
// component (paste parsing) and the server vision reader import the same types with
// no bundling surprises.

export type SnapFieldType = "text" | "number" | "email" | "url" | "phone" | "date";

// One fillable field in a cluster's whitelist.
export interface SnapField {
  /** The host's field key — the form input `name` AND the DB column it maps to. */
  key: string;
  /** Human label — shown to the vision model and matched against pasted headers. */
  label: string;
  /** How to coerce a read value. Defaults to "text". Only "number" is coerced to
   *  a numeric string; the rest are trimmed strings (honest, never reformatted). */
  type?: SnapFieldType;
  /** Optional unit hint shown to the vision model (e.g. "PHP", "followers"). */
  unit?: string | null;
  /** Extra header/label synonyms that a paste column may use for this field. */
  aliases?: string[];
}

export type SnapSchema = readonly SnapField[];

// What SnapFill hands back to its host. The host merges `values` into its form
// state; nothing is persisted until the host's own submit runs.
export interface SnapFillResult {
  /** whitelisted key -> filled value (as a string; unread keys are OMITTED). */
  values: Record<string, string>;
  /** The keys that actually got a value (subset of the schema). */
  filledKeys: string[];
  /** Which mode produced this fill. A "photo" fill is an AI reading the host may
   *  flag for review; a "paste" fill is human-supplied structured text. */
  source: "paste" | "photo";
  /** Whitelisted-but-unread keys + any ignored (non-whitelisted) input columns,
   *  so the host can be honest about what was NOT filled. */
  ignored?: string[];
  /** Photo-mode provenance, for hosts that keep an evidence trail (e.g. the metric
   *  grid attaches the snapped image to the metric_entry it read). */
  vision?: { storagePath: string | null; extract: Record<string, unknown>; model: string };
}

export function fieldType(f: SnapField): SnapFieldType {
  return f.type ?? "text";
}

export function isNumericField(f: SnapField): boolean {
  return fieldType(f) === "number";
}

// Sanitize a client-supplied whitelist (JSON) back into real SnapFields. The vision
// + import routes take the schema from the client so the readers stay generic, but
// the server re-clamps: only well-formed {key,label} entries with a known type
// survive (bounded count), and the readers drop any key not in this list. Kept here
// so every route sanitizes identically.
const FIELD_TYPES: ReadonlySet<SnapFieldType> = new Set<SnapFieldType>([
  "text",
  "number",
  "email",
  "url",
  "phone",
  "date",
]);
export function sanitizeClientSchema(raw: string, maxFields = 40): SnapField[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: SnapField[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const o = (item ?? {}) as Record<string, unknown>;
    const key = typeof o.key === "string" ? o.key.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (!key || !label || seen.has(key)) continue;
    const type =
      typeof o.type === "string" && FIELD_TYPES.has(o.type as SnapFieldType)
        ? (o.type as SnapFieldType)
        : "text";
    const unit = typeof o.unit === "string" ? o.unit : null;
    seen.add(key);
    out.push({ key, label, type, unit });
    if (out.length >= maxFields) break;
  }
  return out;
}

// ── Cluster whitelists ────────────────────────────────────────────────────────
// Each mount passes ITS cluster's whitelist. These are the concrete rollouts; a
// new manual-entry cluster just defines its own SnapField[] and mounts <SnapFill>.

// Affiliate Leads (creators table). The 8 photo-vision fields, mapped to the exact
// DB columns confirmed on the live schema. `post_rate` / `viber` / `facebook_account`
// are TEXT columns (free-form), `follower_count` / `attributed_gmv` are numeric.
// Aliases include the sheet's DISPLAY labels (TiktokUsername / PostRate /
// ViberNumber / FacebookAccount …). Matching is case- and space-insensitive
// (match.ts normalizes both sides), so "TiktokUsername", "TikTok Username", and
// "Username" all resolve to `handle`.
export const CREATOR_SNAP_FIELDS: SnapSchema = [
  { key: "handle", label: "TikTok Username", aliases: ["tiktokusername", "tiktok username", "tiktok", "tiktok handle", "username", "handle", "tiktok_username"] },
  { key: "name", label: "Name", aliases: ["creator", "creator name", "full name"] },
  { key: "email", label: "Email", type: "email", aliases: ["e-mail", "email address"] },
  { key: "follower_count", label: "Followers", type: "number", unit: "followers", aliases: ["followers", "follower count", "fans", "follower_count"] },
  { key: "attributed_gmv", label: "GMV", type: "number", unit: "PHP", aliases: ["gmv", "attributed gmv", "attributed_gmv", "sales"] },
  { key: "post_rate", label: "Post Rate", aliases: ["postrate", "post rate", "posting rate", "post_rate", "posts per week"] },
  { key: "viber", label: "Viber Number", type: "phone", aliases: ["vibernumber", "viber", "viber number", "viber no", "viber_number"] },
  { key: "facebook_account", label: "Facebook Account", aliases: ["facebookaccount", "facebook", "fb", "facebook account", "fb account", "facebook_account", "facebook url"] },
];

// BizDev (leads table). Drag/paste primary; photo where a screenshot is a plausible
// source (e.g. a business card, a DM, a spreadsheet cell). `department` is left out
// — it's a two-option host <select>, not worth a fuzzy fill.
export const LEAD_SNAP_FIELDS: SnapSchema = [
  { key: "name", label: "Name", aliases: ["lead", "contact", "contact name", "lead name"] },
  { key: "company", label: "Company", aliases: ["brand", "company name", "organization", "org"] },
  { key: "email", label: "Email", type: "email", aliases: ["e-mail", "email address", "email / handle"] },
  { key: "phone", label: "Phone", type: "phone", aliases: ["mobile", "contact number", "tel", "phone number"] },
  { key: "source", label: "Source", aliases: ["lead source", "channel", "referral"] },
  { key: "value", label: "Estimated Value", type: "number", unit: "PHP", aliases: ["value", "deal value", "est value", "est. value", "amount", "php"] },
  { key: "notes", label: "Notes", aliases: ["note", "remarks", "comments"] },
];

// Bulk-import whitelists (CSV / XLSX). Supersets of the snap whitelists — a
// spreadsheet legitimately carries more columns than a photo can read (platform,
// status, stage, notes…). Same header→field mapping (match.ts), same honest nulls.

// Affiliate creators — importable columns.
export const CREATOR_IMPORT_FIELDS: SnapSchema = [
  ...CREATOR_SNAP_FIELDS,
  { key: "platform", label: "Platform", aliases: ["network", "channel"] },
  { key: "category", label: "Category", aliases: ["niche", "vertical"] },
  { key: "phone", label: "Phone", type: "phone", aliases: ["mobile", "contact number"] },
  { key: "status", label: "Status", aliases: ["pipeline status", "stage"] },
  { key: "notes", label: "Notes", aliases: ["note", "remarks"] },
];

// BizDev leads — importable columns (matches the historical leads CSV header).
export const LEAD_IMPORT_FIELDS: SnapSchema = [
  ...LEAD_SNAP_FIELDS,
  { key: "department", label: "Department", aliases: ["dept", "team"] },
  { key: "stage", label: "Stage", aliases: ["pipeline", "status"] },
];

// Creative Studio · Performance (content_performance, source='manual'). All-numeric
// manual metrics — an ideal vision target (screenshot of a platform insights panel).
// Mirrors PERF_INT_FIELDS / PERF_NUM_FIELDS in creative-studio/page.tsx.
export const CONTENT_PERF_SNAP_FIELDS: SnapSchema = [
  { key: "views", label: "Views", type: "number", aliases: ["view", "plays", "impressions"] },
  { key: "reach", label: "Reach", type: "number", aliases: ["accounts reached", "unique reach"] },
  { key: "likes", label: "Likes", type: "number", aliases: ["like", "hearts"] },
  { key: "comments", label: "Comments", type: "number", aliases: ["comment"] },
  { key: "shares", label: "Shares", type: "number", aliases: ["share", "reposts"] },
  { key: "saves", label: "Saves", type: "number", aliases: ["save", "bookmarks", "favorites"] },
  { key: "clicks", label: "Clicks", type: "number", aliases: ["click", "link clicks"] },
  { key: "watch_time_seconds", label: "Watch Time (seconds)", type: "number", unit: "seconds", aliases: ["watch time", "total watch time", "watch_time"] },
  { key: "conversions", label: "Conversions", type: "number", aliases: ["conversion"] },
  { key: "orders", label: "Orders", type: "number", aliases: ["order", "purchases"] },
  { key: "engagement_rate", label: "Engagement Rate", type: "number", unit: "%", aliases: ["engagement", "eng rate", "engagement_rate"] },
  { key: "ctr", label: "CTR", type: "number", unit: "%", aliases: ["click through rate", "click-through rate"] },
  { key: "avg_view_duration_seconds", label: "Avg View Duration (seconds)", type: "number", unit: "seconds", aliases: ["avg view duration", "average view duration", "avg_view_duration"] },
  { key: "gmv", label: "GMV", type: "number", unit: "PHP", aliases: ["sales", "revenue", "attributed gmv"] },
];
