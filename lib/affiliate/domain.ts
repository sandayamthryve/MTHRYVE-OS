// lib/affiliate/domain.ts — the shared vocabulary for the Affiliate module.
//
// One pure, DB-free home for the module's roles, stage/status taxonomies,
// channel send-gating rules, KPI roll-up, and the form-field coercers. The page,
// the client islands and the server actions all import from here so the three
// sections can never drift on what a stage means, which channels may send, or
// how a blank field is stored (always null — never a fabricated 0 or "").

import type { BadgeTone } from "@/components/ui";

// ── Roles ───────────────────────────────────────────────────────────────────
// Mirrors the Creators / Outreach modules: heads and members run the ops floor;
// leadership additionally clears the human approval gate. The page-level
// requireRole guard + RLS are the real security — these lists just keep the UI
// and the server actions agreeing on who may do what.
export const MANAGE_ROLES = ["ceo", "coo", "department_head", "team_member"] as const;
export const APPROVE_ROLES = ["ceo", "coo", "department_head"] as const;
export type ManageRole = (typeof MANAGE_ROLES)[number];

export function canApprove(role: string): boolean {
  return (APPROVE_ROLES as readonly string[]).includes(role);
}

// ── Metrics-floor department code ─────────────────────────────────────────────
// The Measure panel reads metric_catalog / metric_entries. The metrics floor
// stores the Affiliate department under the CODE 'affiliate' (see the seed in
// 0025_hybrid_metrics_floor.sql and lib/metrics/types.ts), NOT the org display
// name — so we filter by the code, exactly as /analytics/affiliate does.
export const AFFILIATE_METRICS_DEPT = "affiliate";

// ── Qualification pipeline ────────────────────────────────────────────────────
// The pipeline REUSES creators.status — no new DB columns. The four sourcing
// stages map onto the existing status vocabulary one-to-one so the roster and
// the board never disagree:
//   sourced   ← prospect      (freshly linked, not yet contacted)
//   contacted ← contacted
//   qualified ← onboarded     (vetted / fit-confirmed)
//   active    ← active        (producing)
// 'inactive' is an off-ramp shown separately, never counted as active.
export type CreatorStatus =
  | "prospect"
  | "contacted"
  | "onboarded"
  | "active"
  | "inactive";

export type PipelineStage = "sourced" | "contacted" | "qualified" | "active";

export const PIPELINE_STAGES: PipelineStage[] = ["sourced", "contacted", "qualified", "active"];

export const STAGE_LABEL: Record<PipelineStage, string> = {
  sourced: "Sourced",
  contacted: "Contacted",
  qualified: "Qualified",
  active: "Active",
};

const STATUS_TO_STAGE: Record<CreatorStatus, PipelineStage | null> = {
  prospect: "sourced",
  contacted: "contacted",
  onboarded: "qualified",
  active: "active",
  inactive: null, // off-ramp — not on the active pipeline
};

// The creators.status a given pipeline stage writes when a creator is advanced.
const STAGE_TO_STATUS: Record<PipelineStage, CreatorStatus> = {
  sourced: "prospect",
  contacted: "contacted",
  qualified: "onboarded",
  active: "active",
};

export function stageForStatus(status: string | null | undefined): PipelineStage | null {
  if (!status) return null;
  return STATUS_TO_STAGE[status as CreatorStatus] ?? null;
}

export function statusForStage(stage: PipelineStage): CreatorStatus {
  return STAGE_TO_STATUS[stage];
}

// The next stage a creator can advance to (null when already active). Advancing
// only ever moves forward one step — the UI shows a single "→ next" control so
// the ordering can't be skipped by hand.
export function nextStage(stage: PipelineStage): PipelineStage | null {
  const i = PIPELINE_STAGES.indexOf(stage);
  if (i < 0 || i >= PIPELINE_STAGES.length - 1) return null;
  return PIPELINE_STAGES[i + 1];
}

// SLA / aging thresholds (days a creator has waited in a pre-active stage since
// recruited_at). Purely advisory colouring — nothing auto-moves.
export const STAGE_SLA_DAYS: Record<PipelineStage, number | null> = {
  sourced: 3,
  contacted: 7,
  qualified: 14,
  active: null, // no aging pressure once producing
};

export function agingTone(stage: PipelineStage, days: number | null): BadgeTone {
  const sla = STAGE_SLA_DAYS[stage];
  if (days == null || sla == null) return "muted";
  if (days > sla) return "red";
  if (days > sla * 0.66) return "amber";
  return "teal";
}

// ── Outreach channels & the send gate ─────────────────────────────────────────
// The single rule the compose/send UI and the send action both obey:
//   • GATED channels (email, sms) may leave 'draft' only through a human
//     approval, then a human "mark sent" — never auto-send.
//   • COPY channels (viber, whatsapp, tiktok_dm) can NEVER be marked sent from
//     here: the operator copies the body and sends it by hand in that app. The
//     message stays 'draft' forever on our side — we never fake a send.
export type OutreachChannel = "email" | "sms" | "viber" | "whatsapp" | "tiktok_dm";

export const OUTREACH_CHANNELS: OutreachChannel[] = [
  "email",
  "sms",
  "viber",
  "whatsapp",
  "tiktok_dm",
];

export const CHANNEL_LABEL: Record<OutreachChannel, string> = {
  email: "Email",
  sms: "SMS",
  viber: "Viber",
  whatsapp: "WhatsApp",
  tiktok_dm: "TikTok DM",
};

const GATED_CHANNELS = new Set<OutreachChannel>(["email", "sms"]);

export function isChannel(v: string): v is OutreachChannel {
  return (OUTREACH_CHANNELS as string[]).includes(v);
}

// Email / SMS: an approval + human "mark sent" may move it out of draft.
export function isGatedChannel(channel: string): boolean {
  return GATED_CHANNELS.has(channel as OutreachChannel);
}

// Viber / WhatsApp / TikTok DM: copy-to-clipboard only, never a faked send.
export function isCopyOnlyChannel(channel: string): boolean {
  return isChannel(channel) && !GATED_CHANNELS.has(channel);
}

// ── Vesper Reach send model ───────────────────────────────────────────────────
// Vesper Reach unifies the send step around one honest fact: EMAIL is the only
// channel this app can actually deliver on its own (lib/outreach/email.ts). Every
// other channel — TikTok DM, Viber, WhatsApp, SMS, FB/IG — has no send API here,
// so it is COPY-TO-SEND: leadership approves, the message rests as 'ready_to_send'
// with its approved text + a Copy button, and a human confirms the paste to mark
// it sent. We never call a provider we don't have, and never fake a send.
export function hasAppSender(channel: string): boolean {
  return channel === "email";
}

export function isCopyToSend(channel: string): boolean {
  return !hasAppSender(channel);
}

// ── Outreach message workflow status ──────────────────────────────────────────
// draft → approved → sent           (email: approve, then the app sends)
// draft → ready_to_send → sent      (copy channels: approve stages it, a human
//                                     confirms the hand-paste to mark it sent)
// The approval step ALWAYS stamps approved_by/approved_at — 'ready_to_send' is an
// approved state, just one awaiting a manual paste rather than an app send. So
// NOTHING ever reaches 'sent' (or 'ready_to_send') without a real approver.
export type MessageStatus = "draft" | "approved" | "ready_to_send" | "sent";

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  ready_to_send: "Ready to send",
  sent: "Sent",
};

export function messageStatusTone(status: string): BadgeTone {
  switch (status) {
    case "sent":
      return "teal";
    case "approved":
      return "violet";
    case "ready_to_send":
      return "amber";
    default:
      return "muted";
  }
}

// ── Creator outreach_stage (free-text lifecycle on creators.outreach_stage) ────
// The column carries no DB CHECK, so this is the module's agreed vocabulary. A
// SEND is factual proof of ONE thing only — we have now contacted the creator —
// so a send advances the stage to 'contacted' but NEVER past it on its own (it
// won't invent 'replied'/'negotiating', which need real signals). It also never
// regresses a creator who is already further along.
export const OUTREACH_STAGES = [
  "prospect",
  "contacted",
  "replied",
  "negotiating",
  "closed",
] as const;
export type OutreachStage = (typeof OUTREACH_STAGES)[number];

function stageRank(stage: string | null | undefined): number {
  const i = (OUTREACH_STAGES as readonly string[]).indexOf((stage ?? "").trim());
  return i; // -1 for null/unknown → treated as "before prospect"
}

// The outreach_stage a creator should hold after an outbound touch actually goes
// out. Keeps whatever forward stage they already had; otherwise lands on
// 'contacted'. Returns null when the current value is already at/after 'contacted'
// AND unchanged, so the caller can skip a no-op write.
export function stageAfterSend(current: string | null | undefined): string | null {
  if (stageRank(current) >= stageRank("contacted")) return null; // already ≥ contacted
  return "contacted";
}

// ── Sample fulfillment pipeline ───────────────────────────────────────────────
// request → approve → ship → delivered → received, with a reject off-ramp
// reachable while still requested/approved. Each forward step stamps the
// timestamp + acting user the schema actually carries.
export type SampleStatus =
  | "requested"
  | "approved"
  | "shipped"
  | "delivered"
  | "received"
  | "rejected";

export const SAMPLE_STATUSES: SampleStatus[] = [
  "requested",
  "approved",
  "shipped",
  "delivered",
  "received",
  "rejected",
];

export const SAMPLE_STATUS_LABEL: Record<SampleStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  shipped: "Shipped",
  delivered: "Delivered",
  received: "Received",
  rejected: "Rejected",
};

export function sampleStatusTone(status: string): BadgeTone {
  switch (status) {
    case "received":
    case "delivered":
      return "teal";
    case "shipped":
      return "violet";
    case "approved":
      return "amber";
    case "rejected":
      return "red";
    default:
      return "muted"; // requested
  }
}

// Allowed forward/off-ramp transitions for a sample. Guarded on the server so a
// stale button can't skip a step.
export const SAMPLE_TRANSITIONS: Record<SampleStatus, SampleStatus[]> = {
  requested: ["approved", "rejected"],
  approved: ["shipped", "rejected"],
  shipped: ["delivered"],
  delivered: ["received"],
  received: [],
  rejected: [],
};

export function canSampleTransition(from: string, to: string): boolean {
  return (SAMPLE_TRANSITIONS[from as SampleStatus] ?? []).includes(to as SampleStatus);
}

// ── Content pipeline ──────────────────────────────────────────────────────────
// assigned → in_progress → submitted → approved → posted → live, reject off-ramp
// from submitted. approve/reject stamp reviewer_id.
export type ContentStatus =
  | "assigned"
  | "in_progress"
  | "submitted"
  | "approved"
  | "posted"
  | "live"
  | "rejected";

export const CONTENT_STATUSES: ContentStatus[] = [
  "assigned",
  "in_progress",
  "submitted",
  "approved",
  "posted",
  "live",
  "rejected",
];

export const CONTENT_STATUS_LABEL: Record<ContentStatus, string> = {
  assigned: "Assigned",
  in_progress: "In progress",
  submitted: "Submitted",
  approved: "Approved",
  posted: "Posted",
  live: "Live",
  rejected: "Rejected",
};

export function contentStatusTone(status: string): BadgeTone {
  switch (status) {
    case "live":
    case "posted":
      return "teal";
    case "approved":
      return "violet";
    case "submitted":
      return "amber";
    case "rejected":
      return "red";
    default:
      return "muted"; // assigned / in_progress
  }
}

export const CONTENT_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  assigned: ["in_progress", "submitted"],
  in_progress: ["submitted"],
  submitted: ["approved", "rejected"],
  approved: ["posted", "live"],
  posted: ["live"],
  live: [],
  rejected: [],
};

export function canContentTransition(from: string, to: string): boolean {
  return (CONTENT_TRANSITIONS[from as ContentStatus] ?? []).includes(to as ContentStatus);
}

export const CONTENT_TYPES = ["video", "photo", "livestream", "post", "other"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export function isContentType(v: string): v is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(v);
}

// ── KPI roll-up ───────────────────────────────────────────────────────────────
// The per-campaign tracker. Every field is a REAL count/sum derived live from
// the linked creators (+ their attributed content) — never the target echoed
// back as an actual. Unknown sums (no contributing rows) come back null so the
// UI renders "—", never a fabricated 0. Counts are always real counts.
export interface CampaignKpi {
  sourced: number; // total creators linked to the campaign
  qualified: number; // linked creators at 'qualified' stage or beyond
  active: number; // linked creators currently 'active'
  reach: number | null; // Σ follower_count over linked creators (null if none known)
  gmv: number | null; // Σ attributed GMV from the campaign's content (null if none)
}

export interface LinkedCreatorLite {
  status: string | null;
  follower_count: number | null;
}

export function rollUpKpi(
  creators: LinkedCreatorLite[],
  contentGmv: (number | null)[]
): CampaignKpi {
  let qualified = 0;
  let active = 0;
  let reachSum = 0;
  let reachSeen = false;

  for (const c of creators) {
    const stage = stageForStatus(c.status);
    if (stage === "qualified" || stage === "active") qualified += 1;
    if (stage === "active") active += 1;
    if (c.follower_count != null && Number.isFinite(Number(c.follower_count))) {
      reachSum += Number(c.follower_count);
      reachSeen = true;
    }
  }

  let gmvSum = 0;
  let gmvSeen = false;
  for (const g of contentGmv) {
    if (g != null && Number.isFinite(Number(g))) {
      gmvSum += Number(g);
      gmvSeen = true;
    }
  }

  return {
    sourced: creators.length,
    qualified,
    active,
    reach: reachSeen ? reachSum : null,
    gmv: gmvSeen ? gmvSum : null,
  };
}

// ── Form-field coercers ───────────────────────────────────────────────────────
// One home for "blank → null (unknown), never 0 or empty string", shared by
// every server action so the honest-null contract holds identically everywhere.
export function optText(fd: FormData, key: string): string | null {
  const v = String(fd.get(key) ?? "").trim();
  return v || null;
}

export function optNum(fd: FormData, key: string, integer = false): number | null {
  const raw = String(fd.get(key) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return integer ? Math.trunc(n) : n;
}

// An <input type="date"> value ("YYYY-MM-DD") kept as a calendar day, or null.
export function optDate(fd: FormData, key: string): string | null {
  const raw = String(fd.get(key) ?? "").trim();
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

// A datetime-local ("2026-07-12T14:30") → ISO pinned to Asia/Manila (+08:00),
// the company timezone, so the wall-clock the user typed round-trips. null when
// blank/malformed.
export function optTimestamp(fd: FormData, key: string): string | null {
  const raw = String(fd.get(key) ?? "").trim();
  if (!raw) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/);
  if (!m) return null;
  const t = new Date(`${m[1]}T${m[2]}${m[3] ?? ":00"}+08:00`).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Whole days between an ISO timestamp and now (Manila-agnostic — a duration, not
// a calendar diff). null when the input is missing/unparseable.
export function daysSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}
