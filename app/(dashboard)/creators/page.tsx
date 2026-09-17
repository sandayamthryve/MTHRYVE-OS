import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, rowClass, Badge } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { CreatorsCsvButton } from "./CreatorsCsvButton";
import { ImportCreatorsControl, type ImportCreatorsState } from "./ImportCreatorsControl";
import { AddCreatorForm, type AddCreatorState } from "./AddCreatorForm";
import { CREATOR_IMPORT_FIELDS } from "@/lib/snapfill/schema";
import { parseImportFile, parseImportText, isImportError } from "@/lib/snapfill/import";
import { ScanFollowUpsButton } from "@/components/outreach/ScanFollowUpsButton";
import { ScanStandardsButton } from "@/components/affiliate/ScanStandardsButton";
import { StandardsControls } from "@/components/affiliate/StandardsControls";
import { loadStandardsRegistry, type RegistryRow } from "@/lib/affiliate/data";
import { parseWeekSelector, resolveIsoWeek } from "@/lib/metrics/windows";
import {
  VERDICT_LABEL,
  verdictTone,
  verdictSeverity,
  deliveryFlag,
  DELIVERY_LABEL,
  deliveryTone,
  type StandardVerdict,
} from "@/lib/affiliate/standards";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import { campaignTypeLabel } from "@/lib/campaigns/types";

// Creator / Affiliate portal. Track creators through the pipeline
// (prospect → contacted → onboarded → active → inactive) and manage the
// affiliate deals attached to them.

type Brand = { id: string; name: string };
type Creator = {
  id: string;
  name: string;
  handle: string | null;
  platform: string;
  category: string | null;
  follower_count: number | null;
  email: string | null;
  phone: string | null;
  status: string;
  tier: string | null;
  posts_committed: number | null;
  attributed_gmv: number | null;
  notes: string | null;
  created_at: string;
  archived_at: string | null;
};
type Deal = {
  id: string;
  creator_id: string | null;
  brand_id: string | null;
  commission_rate: number | null;
  deliverables: string | null;
  status: string;
  gmv_attributed: number | null;
  orders_attributed: number | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  created_at: string;
  archived_at: string | null;
};

const STATUSES = ["prospect", "contacted", "onboarded", "active", "inactive"] as const;
const STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect",
  contacted: "Contacted",
  onboarded: "Onboarded",
  active: "Active",
  inactive: "Inactive",
};

const PLATFORMS = ["tiktok", "shopee", "instagram", "facebook", "youtube", "other"] as const;
const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  shopee: "Shopee",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  other: "Other",
};

const DEAL_STATUSES = ["proposed", "active", "paused", "ended"] as const;
const DEAL_STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed",
  active: "Active",
  paused: "Paused",
  ended: "Ended",
};
const DEAL_STATUS_STYLE: Record<string, string> = {
  proposed: "text-ink-muted ring-charcoal-600",
  active: "text-teal-300 ring-teal-500/40",
  paused: "text-amber-300 ring-amber-500/40",
  ended: "text-ink-muted ring-charcoal-600",
};

type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<unknown>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

// The ONLY path that INSERTs a creator. Before inserting it blocks a second
// creator that shares a normalized email in the org — that is exactly how a
// duplicate-client row is born, and must never happen again. The DB unique index
// on (org_id, lower(email)) is the last-line backstop; this gives a clear inline
// message instead of an opaque constraint error. Editing a creator goes through
// updateCreatorRoster (UPDATE by id) and never reaches here. Shaped for
// useFormState so the block/error surfaces inline. Email is optional — a creator
// with no email is never deduped (the index treats nulls as distinct too).
async function createCreator(
  _prev: AddCreatorState,
  formData: FormData
): Promise<AddCreatorState> {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Creator name is required." };
  const email = String(formData.get("email") ?? "").trim() || null;
  const supabase = createServerSupabaseClient();

  // Duplicate guard: normalized-email match against creators in this org. Only
  // runs when an email is given, mirroring the partial-null semantics of the
  // (org_id, lower(email)) unique index.
  if (email) {
    const normalized = email.toLowerCase();
    const { data: existing } = await supabase
      .from("creators")
      .select("id, email")
      .eq("org_id", profile.org_id);
    const dup = ((existing ?? []) as { email: string | null }[]).find(
      (r) => (r.email ?? "").trim().toLowerCase() === normalized
    );
    if (dup) {
      return {
        error: `A creator with the email "${email}" already exists — open it to edit instead of adding a new one.`,
      };
    }
  }

  // Capture the new id so an optional campaign link can reference it. This is the
  // hardened insert path (dedup above + 23505 backstop below) — unchanged except
  // that we now read back the row id.
  const { data: inserted, error } = (await (supabase as unknown as AnyDb)
    .from("creators")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      owner_id: profile.id,
      name,
      handle: String(formData.get("handle") ?? "") || null,
      platform: String(formData.get("platform") ?? "tiktok") || "tiktok",
      category: String(formData.get("category") ?? "") || null,
      follower_count: toIntOrNull(String(formData.get("follower_count") ?? "")),
      tier: String(formData.get("tier") ?? "") || null,
      posts_committed: toIntOrNull(String(formData.get("posts_committed") ?? "")),
      email,
      phone: String(formData.get("phone") ?? "") || null,
      // SnapFill-fillable columns (Affiliate Leads whitelist). Honest nulls: a blank
      // input stays null, never a fabricated 0 / "". post_rate / viber /
      // facebook_account are free-text; attributed_gmv is a numeric (float) floor.
      attributed_gmv: toNumOrNull(String(formData.get("attributed_gmv") ?? "")),
      post_rate: String(formData.get("post_rate") ?? "") || null,
      viber: String(formData.get("viber") ?? "") || null,
      facebook_account: String(formData.get("facebook_account") ?? "") || null,
      status: "prospect",
    })
    .select("id")
    .single()) as {
    data: { id: string } | null;
    error: { code?: string; message?: string } | null;
  };
  if (error || !inserted) {
    // Backstop: the unique index rejected a race that slipped past the check.
    if (isUniqueViolation(error)) {
      return {
        error: `A creator with the email "${email ?? ""}" already exists — open it to edit instead of adding a new one.`,
      };
    }
    return { error: "Could not add the creator. Please try again." };
  }

  // ── Optional campaign link (ADDITIVE, best-effort) ──────────────────────────
  // The creator already exists at this point and is never rolled back. Linking is
  // a separate step AFTER the fact: any failure is REPORTED, never thrown, and the
  // creator insert stands. One affiliate_campaign_creators row links the creator
  // to the chosen campaign, through the same RLS-scoped client (org_id set from
  // the caller so the row satisfies the with_check policy).
  const linkNote = await maybeLinkCampaign(
    supabase,
    profile,
    formData,
    (inserted as { id: string }).id
  );

  revalidatePath("/creators");
  return linkNote ? { ok: linkNote } : null;
}

// Loose accessor for tables that are (creators) or aren't (affiliate_campaign_creators)
// in the generated Database types — matches the cast shim used across the app.
type AnyDb = { from: (t: string) => any };

// Best-effort: link the freshly-created creator to a chosen campaign. Returns a
// human note describing the outcome, or undefined when no campaign was chosen.
// NEVER throws — a link problem must not fail (or roll back) the creator create.
async function maybeLinkCampaign(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  profile: { id: string; org_id: string },
  formData: FormData,
  creatorId: string
): Promise<string | undefined> {
  const campaignId = String(formData.get("campaign_id") ?? "").trim();
  if (!campaignId) return undefined;

  // Confirm it's a real, non-archived campaign in THIS org before linking (RLS
  // scopes the read to the org, so a foreign / bogus id simply isn't found — we
  // never create a dangling link).
  const { data: camp } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .is("archived_at", null)
    .maybeSingle();
  if (!camp) {
    return "Creator added. The selected campaign was not found, so it was not linked.";
  }

  const { error: linkErr } = await (supabase as unknown as AnyDb)
    .from("affiliate_campaign_creators")
    .insert({
      org_id: profile.org_id,
      campaign_id: campaignId,
      creator_id: creatorId,
      sourcer_id: profile.id,
      recruited_at: new Date().toISOString(),
    });

  if (linkErr) {
    if (isUniqueViolation(linkErr)) {
      return "Creator added. It was already linked to that campaign.";
    }
    return "Creator added, but linking it to the campaign failed — you can link it later from the campaign.";
  }
  return "Creator added and linked to the campaign.";
}

// A Postgres unique-constraint violation (code 23505) — the DB backstop firing.
// Recognised so the UI can show a friendly "already exists" instead of the raw
// constraint error, never a stack trace.
function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("duplicate key") || m.includes("unique constraint");
}

// Parse a follower count to an integer, or null when blank/invalid — an unknown
// count is never fabricated as 0.
function toIntOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Parse a decimal amount (e.g. attributed GMV) to a float, or null when
// blank/invalid — an unknown amount is never fabricated as 0.
function toNumOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Bulk-import partners/creators from a CSV or XLSX. Both formats go through the ONE
// shared server-side parser (lib/snapfill/import) with the same header→field-
// whitelist mapping as the drag/paste + photo fill — so a .csv and an .xlsx of the
// same list import identically. Every cell is DATA (a formula cell imports its
// cached computed value, never the formula; macros are ignored; Excel serial dates
// become real dates). Header row maps to the creators import whitelist; a row
// without a name is reported, never invented. Honest nulls throughout. Shaped for
// useFormState.
async function importCreators(
  _prev: ImportCreatorsState,
  formData: FormData
): Promise<ImportCreatorsState> {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };

  // Prefer an uploaded file (.csv / .xlsx); fall back to the pasted textarea.
  const file = formData.get("file");
  const parsed =
    file instanceof File && file.size > 0
      ? await parseImportFile(file, CREATOR_IMPORT_FIELDS)
      : parseImportText(String(formData.get("csv") ?? ""), CREATOR_IMPORT_FIELDS);

  if (isImportError(parsed)) return { imported: 0, skipped: [parsed.error] };

  const skipped: string[] = [];
  if (parsed.truncated) {
    skipped.push(`Only the first ${parsed.records.length} rows were imported (file exceeded the row cap).`);
  }
  for (const h of parsed.ignoredHeaders) skipped.push(`ignored column "${h}"`);

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  let imported = 0;
  for (const r of parsed.records) {
    if (!r.name) {
      skipped.push("row missing name");
      continue;
    }
    await db.from("creators").insert({
      org_id: profile.org_id,
      created_by: profile.id,
      owner_id: profile.id,
      name: r.name,
      handle: r.handle ?? null,
      platform: r.platform || "tiktok",
      category: r.category ?? null,
      follower_count: toIntOrNull(r.follower_count ?? ""),
      email: r.email ?? null,
      phone: r.phone ?? null,
      status: r.status || "prospect",
      notes: r.notes ?? null,
      attributed_gmv: toNumOrNull(r.attributed_gmv ?? ""),
      post_rate: r.post_rate ?? null,
      viber: r.viber ?? null,
      facebook_account: r.facebook_account ?? null,
    });
    imported += 1;
  }
  revalidatePath("/creators");
  return { imported, skipped };
}

// Roster edit — assign a tier, set the weekly posting commitment, correct the
// follower count and move pipeline status, all from one row. Blank tier clears
// it (falls back to grading by reach); blank commitment/followers write null
// rather than a fabricated 0 so the KPI can show an honest "no commitment".
async function updateCreatorRoster(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head", "team_member"]);
  // Save ALWAYS updates the opened creator by its id — it never inserts. With no
  // id we bail rather than fall through to any create path, so an absent/empty id
  // can never silently mint a duplicate.
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("creators")
    .update({
      tier: String(formData.get("tier") ?? "") || null,
      posts_committed: toIntOrNull(String(formData.get("posts_committed") ?? "")),
      follower_count: toIntOrNull(String(formData.get("follower_count") ?? "")),
      status: String(formData.get("status") ?? "prospect") || "prospect",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/creators");
}

// Log a post → one creator_posts row. This is the delivery input the weekly
// post-rate divides by the commitment: a "posted" row this ISO week counts
// toward the numerator. posted_at defaults to now when the field is left blank.
async function logPost(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };
  const creator_id = String(formData.get("creator_id") ?? "");
  if (!creator_id) return;
  const postedRaw = String(formData.get("posted_at") ?? "").trim();
  const posted_at = postedRaw ? new Date(postedRaw).toISOString() : new Date().toISOString();
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("creator_posts").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    creator_id,
    platform: String(formData.get("platform") ?? "") || null,
    post_url: String(formData.get("post_url") ?? "") || null,
    posted_at,
    status: String(formData.get("status") ?? "posted") || "posted",
  });
  revalidatePath("/creators");
  revalidatePath(`/creators/${creator_id}`);
}

async function createDeal(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };
  const creator_id = String(formData.get("creator_id") ?? "");
  if (!creator_id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("affiliate_deals").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    creator_id,
    brand_id: String(formData.get("brand_id") ?? "") || null,
    commission_rate: Number(formData.get("commission_rate") ?? 0) || 0,
    deliverables: String(formData.get("deliverables") ?? "") || null,
    start_date: String(formData.get("start_date") ?? "") || null,
    end_date: String(formData.get("end_date") ?? "") || null,
    status: "proposed",
  });
  revalidatePath("/creators");
}

async function updateDealStatus(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "proposed");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("affiliate_deals")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/creators");
}

function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

export default async function CreatorsPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const profile = await requireModule("/creators");
  const supabase = createServerSupabaseClient();

  // Only roles RLS lets draft an action_request may run the follow-up / standards scans.
  const canScan = ["ceo", "coo", "department_head"].includes(profile.role);

  const gp = (k: string) =>
    typeof searchParams?.[k] === "string" ? (searchParams[k] as string) : undefined;

  // One archive flag drives BOTH the creators roster and the deals list: the
  // default view shows active rows, the Archived view shows only archived ones.
  const archived = searchParams?.archived === "1";

  const creatorQuery = supabase
    .from("creators")
    .select("id, name, handle, platform, category, follower_count, email, phone, status, tier, posts_committed, attributed_gmv, notes, created_at, archived_at")
    .order("created_at", { ascending: false });
  const dealQuery = supabase
    .from("affiliate_deals")
    .select("id, creator_id, brand_id, commission_rate, deliverables, status, gmv_attributed, orders_attributed, start_date, end_date, notes, created_at, archived_at")
    .order("created_at", { ascending: false });

  // Active (non-archived) campaigns offered as an optional link target on the
  // Add-creator form — independent of the archived toggle above (that governs the
  // creators/deals view, not this picker). RLS scopes rows to the org.
  const campaignQuery = supabase
    .from("campaigns")
    .select("id, name, type, status")
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  const [brandRes, creatorRes, dealRes, campaignRes] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    archived ? creatorQuery.not("archived_at", "is", null) : creatorQuery.is("archived_at", null),
    archived ? dealQuery.not("archived_at", "is", null) : dealQuery.is("archived_at", null),
    campaignQuery,
  ]);

  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const activeCampaigns = (campaignRes.data ?? []) as unknown as {
    id: string;
    name: string;
    type: string | null;
    status: string | null;
  }[];
  // Show the type in the label so the operator sees which kind they're linking to.
  const campaignOptions = activeCampaigns.map((c) => ({
    value: c.id,
    label: `${c.name} · ${campaignTypeLabel(c.type)}`,
  }));
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const creators = (creatorRes.data ?? []) as unknown as Creator[];
  const creatorName = (id: string | null) => creators.find((c) => c.id === id)?.name ?? "—";
  const deals = (dealRes.data ?? []) as unknown as Deal[];

  const byStatus = (s: string) => creators.filter((c) => c.status === s);

  // ── Performance-standard registry (KPI) ─────────────────────────────────────
  // Graded over the selected ISO week (current to-date by default; last completed
  // for the Monday review). Filter/sort come from the URL so the view is shareable.
  const weekSel = parseWeekSelector(gp("week"));
  const week = resolveIsoWeek(weekSel);
  const registry = await loadStandardsRegistry(
    supabase as unknown as { from: (t: string) => any },
    week
  );
  const tierNames = registry.tiers.map((t) => t.tier);
  const tierRank = new Map(registry.tiers.map((t) => [t.tier.toLowerCase(), t.rank]));

  const tierFilter = gp("tier") ?? "all";
  const stdFilter = gp("std") ?? "all";
  const sortKey = gp("sort") ?? "standard";

  const inStdBucket = (v: StandardVerdict): boolean => {
    if (stdFilter === "all") return true;
    if (stdFilter === "ungraded")
      return v === "no_commitment" || v === "no_posts" || v === "untiered";
    return v === stdFilter;
  };

  let standardRows: RegistryRow[] = registry.rows.filter((r) => {
    if (tierFilter !== "all") {
      if (tierFilter === "untiered") {
        if (r.kpi.tierName != null) return false;
      } else if ((r.kpi.tierName ?? "").toLowerCase() !== tierFilter.toLowerCase()) {
        return false;
      }
    }
    return inStdBucket(r.kpi.verdict);
  });

  const rankOf = (r: RegistryRow) =>
    r.kpi.tierName ? tierRank.get(r.kpi.tierName.toLowerCase()) ?? 999 : 1000;
  standardRows = [...standardRows].sort((a, b) => {
    if (sortKey === "post_rate") {
      const ra = a.kpi.postRatePct ?? Number.POSITIVE_INFINITY;
      const rb = b.kpi.postRatePct ?? Number.POSITIVE_INFINITY;
      return ra - rb || a.creator.name.localeCompare(b.creator.name);
    }
    if (sortKey === "tier") {
      return rankOf(a) - rankOf(b) || a.creator.name.localeCompare(b.creator.name);
    }
    // "standard" — worst verdict first, then lowest post rate.
    return (
      verdictSeverity(b.kpi.verdict) - verdictSeverity(a.kpi.verdict) ||
      (a.kpi.postRatePct ?? 100) - (b.kpi.postRatePct ?? 100) ||
      a.creator.name.localeCompare(b.creator.name)
    );
  });

  const stdCount = (bucket: "meets" | "at_risk" | "below") =>
    registry.rows.filter((r) => r.kpi.verdict === bucket).length;
  const ungradedCount = registry.rows.filter(
    (r) =>
      r.kpi.verdict === "no_commitment" ||
      r.kpi.verdict === "no_posts" ||
      r.kpi.verdict === "untiered"
  ).length;

  // Delivery read (post rate vs the tier bar), independent of GMV/followers.
  const onTrackCount = registry.rows.filter((r) => deliveryFlag(r.kpi) === "on_track").length;
  const hoarderCount = registry.rows.filter((r) => deliveryFlag(r.kpi) === "hoarder").length;

  // CSV export rows: every org creator (RLS-scoped). Columns are fixed by the
  // partners export spec; nulls export as empty cells, never fabricated values.
  const exportRows = creators.map((c) => ({
    name: c.name,
    handle: c.handle ?? "",
    platform: c.platform,
    category: c.category ?? "",
    follower_count: c.follower_count != null ? String(c.follower_count) : "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    status: c.status,
    notes: c.notes ?? "",
  }));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Creators / Affiliate"]} profile={profile}>
      <PageHeader
        title="Creators / Affiliate"
        subtitle="Manage your creator roster through the pipeline and track the affiliate deals attached to them."
        action={
          <div className="flex flex-wrap items-start gap-2">
            {canScan && <ScanStandardsButton />}
            {canScan && <ScanFollowUpsButton />}
            <CreatorsCsvButton rows={exportRows} filename="partners.csv" />
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-3 gap-3 sm:grid-cols-5">
        {STATUSES.map((s) => (
          <StatTile key={s} label={STATUS_LABEL[s]} value={byStatus(s).length} />
        ))}
      </div>

      {/* One toggle drives both the roster and the deals list below. */}
      <div className="mb-6 flex justify-end">
        <ArchivedToggle basePath="/creators" archived={archived} />
      </div>

      {/* Performance-standard registry (weekly KPI) */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Performance standards</h2>
            <p className="max-w-xl text-xs text-ink-muted">
              Weekly posting cadence, attributed GMV and follower band vs each creator&apos;s tier.
              Graded for <span className="text-ink">{week.label}</span> ({week.isoWeek} ·{" "}
              {weekSel === "last" ? "last completed week" : "current week to-date"}, Asia/Manila).
            </p>
          </div>
          <StandardsControls
            tiers={tierNames}
            current={{ week: weekSel, tier: tierFilter, std: stdFilter, sort: sortKey }}
          />
        </div>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <StatTile
            label="On track this week"
            value={onTrackCount}
            valueClassName="text-teal-300"
            hint="Post rate ≥ tier bar"
          />
          <StatTile
            label="Hoarders this week"
            value={hoarderCount}
            valueClassName="text-red-300"
            hint="Posting below the committed rate"
          />
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Meets standard" value={stdCount("meets")} valueClassName="text-teal-300" />
          <StatTile label="At risk" value={stdCount("at_risk")} valueClassName="text-amber-300" />
          <StatTile label="Below standard" value={stdCount("below")} valueClassName="text-red-300" />
          <StatTile label="Not graded" value={ungradedCount} />
        </div>

        <TableShell columns={["Creator", "Tier", "Post rate", "Delivery", "GMV vs floor", "Followers", "Standard"]}>
          {standardRows.length === 0 && (
            <tr>
              <td colSpan={7} className="p-4 text-ink-muted">
                No creators match these filters.
              </td>
            </tr>
          )}
          {standardRows.map(({ creator, kpi }) => {
            const delivery = deliveryFlag(kpi);
            const rateTone =
              kpi.postRatePct == null
                ? "text-ink-muted"
                : kpi.postRatePct >= kpi.requiredPostRatePct
                  ? "text-teal-300"
                  : kpi.postRatePct >= 80
                    ? "text-amber-300"
                    : "text-red-300";
            const gmvTone =
              kpi.meetsGmv == null ? "text-ink" : kpi.meetsGmv ? "text-teal-300" : "text-red-300";
            return (
              <tr key={creator.id} className={rowClass}>
                <td className="p-3">
                  <Link
                    href={`/creators/${creator.id}`}
                    className="text-ink hover:text-teal-300 hover:underline"
                  >
                    {creator.name}
                  </Link>
                  {creator.handle ? <span className="text-ink-muted"> · {creator.handle}</span> : ""}
                </td>
                <td className="p-3 text-ink-muted">
                  {kpi.tierName ?? <span className="text-ink-dim">Untiered</span>}
                  {kpi.tierSource === "band" && kpi.tierName ? (
                    <span className="text-ink-dim"> (by reach)</span>
                  ) : (
                    ""
                  )}
                </td>
                <td className="p-3">
                  {kpi.committed == null ? (
                    <span className="text-ink-muted">No commitment</span>
                  ) : (
                    <span className={`font-mono ${rateTone}`}>
                      {kpi.delivered}/{kpi.committed} · {kpi.postRatePct}%
                    </span>
                  )}
                </td>
                <td className="p-3">
                  {delivery === "no_data" ? (
                    <span className="text-ink-dim">—</span>
                  ) : (
                    <Badge tone={deliveryTone(delivery)}>{DELIVERY_LABEL[delivery]}</Badge>
                  )}
                </td>
                <td className="p-3 font-mono">
                  {kpi.attributedGmv == null ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <span className={gmvTone}>
                      {peso(kpi.attributedGmv)}
                      {kpi.minGmv != null ? ` / ${peso(kpi.minGmv)}` : ""}
                    </span>
                  )}
                </td>
                <td className="p-3 font-mono text-ink">
                  {kpi.followerCount != null ? kpi.followerCount.toLocaleString("en-US") : "—"}
                  {kpi.followerInBand === false ? (
                    <span className="ml-1 font-sans text-[10px] text-amber-300">out of band</span>
                  ) : (
                    ""
                  )}
                </td>
                <td className="p-3">
                  <Badge tone={verdictTone(kpi.verdict)}>{VERDICT_LABEL[kpi.verdict]}</Badge>
                </td>
              </tr>
            );
          })}
        </TableShell>
        <p className="mt-2 text-[11px] text-ink-dim">
          Standard: post rate ≥ {registry.tiers[0]?.required_post_rate_pct ?? 95}% · attributed GMV ≥
          tier floor · followers within tier band. <span className="text-red-300">HOARDER</span> = post
          rate below the creator&apos;s tier bar this week (a delivery signal, not a pay decision) — sort
          by “Lowest post rate first” to surface hoarders at the top. Missing inputs show honestly as “no
          commitment”, “no posts yet” or “untiered” — never a fabricated score.
        </p>
      </section>

      <AddCreatorForm
        action={createCreator}
        platforms={PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }))}
        tiers={tierNames}
        campaigns={campaignOptions}
      />

      <SectionCard title="Import Partners (CSV / XLSX)" className="mb-6">
        <p className="mb-3 text-xs text-ink-muted">
          Bulk-add partners from a spreadsheet. Each valid row inserts a new partner. Rows missing a
          name or platform are skipped and reported — nothing is fabricated.
        </p>
        <ImportCreatorsControl action={importCreators} />
      </SectionCard>

      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink">Roster — edit tier &amp; weekly commitment</h2>
        <p className="text-[11px] text-ink-dim">
          Assign a tier, set the weekly posts committed and correct the follower count, then Save.
        </p>
      </div>
      <TableShell className="mb-8" columns={["Creator", "Tier", "Weekly committed", "Followers", "GMV", "Status", "", "Manage"]}>
            {creators.length === 0 && (
              <tr>
                <td colSpan={8} className="p-4 text-ink-muted">
                  {archived ? "No archived creators." : "No creators yet — add your first above."}
                </td>
              </tr>
            )}
            {creators.map((c) => (
              <tr key={c.id} className={rowClass}>
                <td className="p-3">
                  <Link href={`/creators/${c.id}`} className="text-ink hover:text-teal-300 hover:underline">
                    {c.name}
                  </Link>
                  {c.handle ? <span className="text-ink-muted"> · {c.handle}</span> : ""}
                  <div className="text-[11px] text-ink-dim">{PLATFORM_LABEL[c.platform] ?? c.platform}{c.category ? ` · ${c.category}` : ""}</div>
                </td>
                <td className="p-3">
                  <select name="tier" form={`roster-${c.id}`} defaultValue={c.tier ?? ""} aria-label="Tier" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink">
                    <option value="">Auto by reach</option>
                    {tierNames.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3">
                  <input name="posts_committed" form={`roster-${c.id}`} type="number" min="0" defaultValue={c.posts_committed ?? ""} placeholder="—" className="w-20 rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink" />
                  <span className="ml-1 text-[10px] text-ink-dim">/wk</span>
                </td>
                <td className="p-3">
                  <input name="follower_count" form={`roster-${c.id}`} type="number" min="0" defaultValue={c.follower_count ?? ""} placeholder="—" className="w-28 rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs font-mono text-ink" />
                </td>
                <td className="p-3 font-mono text-ink-muted">
                  {c.attributed_gmv != null ? peso(Number(c.attributed_gmv)) : "—"}
                </td>
                <td className="p-3">
                  <select name="status" form={`roster-${c.id}`} defaultValue={c.status} aria-label="Status" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink">
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3">
                  <form id={`roster-${c.id}`} action={updateCreatorRoster}>
                    <input type="hidden" name="id" value={c.id} />
                    <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700">Save</button>
                  </form>
                </td>
                <td className="p-3">
                  <RowActions {...rowActionProps("creators", c as unknown as Record<string, unknown>, profile)} />
                </td>
              </tr>
            ))}
      </TableShell>

      <form action={logPost} className="mb-8 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
        <h2 className="mb-1 text-sm font-semibold text-ink">Log a post</h2>
        <p className="mb-3 text-xs text-ink-muted">
          Records one <span className="font-mono">creator_posts</span> row. A “posted” post dated inside
          the current ISO week counts toward that creator&apos;s weekly post rate.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <select name="creator_id" required aria-label="Creator" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
            <option value="">Creator…</option>
            {creators.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select name="platform" defaultValue="tiktok" aria-label="Platform" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>
            ))}
          </select>
          <select name="status" defaultValue="posted" aria-label="Post status" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
            <option value="posted">Posted</option>
            <option value="pending">Pending</option>
            <option value="rejected">Rejected</option>
          </select>
          <input name="post_url" type="url" placeholder="Post URL (https://…)" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink sm:col-span-2" />
          <label className="text-xs text-ink-muted">
            Posted at
            <input name="posted_at" type="datetime-local" className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
          </label>
        </div>
        <button type="submit" className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
          Log post
        </button>
      </form>

      <form action={createDeal} className="mb-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
        <h2 className="mb-3 text-sm font-semibold text-ink">Create affiliate deal</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <select name="creator_id" required className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
            <option value="">Creator…</option>
            {creators.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select name="brand_id" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
            <option value="">Brand (optional)…</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <input name="commission_rate" type="number" step="0.01" placeholder="Commission rate (%)" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
          <input name="deliverables" placeholder="Deliverables (e.g. 3 videos)" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink sm:col-span-3" />
          <label className="text-xs text-ink-muted">
            Start
            <input name="start_date" type="date" className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
          </label>
          <label className="text-xs text-ink-muted">
            End
            <input name="end_date" type="date" className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
          </label>
        </div>
        <button type="submit" className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
          Create deal
        </button>
      </form>

      <TableShell columns={["Creator", "Brand", "Commission", "GMV", "Status", "Manage"]}>
            {deals.length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-ink-muted">
                  {archived ? "No archived deals." : "No deals yet — create your first above."}
                </td>
              </tr>
            )}
            {deals.map((d) => (
              <tr key={d.id} className={rowClass}>
                <td className="p-3 text-ink">{creatorName(d.creator_id)}</td>
                <td className="p-3 text-ink-muted">{brandName(d.brand_id)}</td>
                <td className="p-3 font-mono text-ink">{Number(d.commission_rate ?? 0)}%</td>
                <td className="p-3 font-mono text-ink">{peso(Number(d.gmv_attributed ?? 0))}</td>
                <td className="p-3">
                  <form action={updateDealStatus} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={d.id} />
                    <select
                      name="status"
                      defaultValue={d.status}
                      className={`rounded-md border-0 bg-charcoal-950 p-1.5 text-xs ring-1 ${DEAL_STATUS_STYLE[d.status] ?? DEAL_STATUS_STYLE.proposed}`}
                    >
                      {DEAL_STATUSES.map((s) => (
                        <option key={s} value={s}>{DEAL_STATUS_LABEL[s]}</option>
                      ))}
                    </select>
                    <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700">Save</button>
                  </form>
                </td>
                <td className="p-3">
                  <RowActions {...rowActionProps("affiliate_deals", d as unknown as Record<string, unknown>, profile)} />
                </td>
              </tr>
            ))}
      </TableShell>
    </AppShell>
  );
}
