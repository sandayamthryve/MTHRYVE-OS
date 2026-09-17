// lib/actions/follow-ups.ts — the poly-source follow-up loop's SIGNAL PRODUCER
// logic (pure, no DB). It reads real outreach context from TWO sources — client
// leads (BizDev) and affiliate/KOL creators — and, for each target that is due a
// touch, drafts ONE action_request carrying Tony's reasoning plus a short,
// tone-matched follow-up message a human can edit before approving.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then
// the OS EXECUTES. This module never sends anything and never fabricates a fact:
// every message is built only from fields that actually exist on the row (name /
// company / stage for leads; name / @handle / platform / category for creators).
// Nothing invents a price, a metric, or a date.
//
// The `leads` and `creators` tables carry the outreach columns (next_action_date,
// last_contacted_at, plus outreach_stage on creators) but aren't in the generated
// Database types, so callers read them through the app's cast shim and hand the
// rows to these typed helpers — exactly like the delivery-risk producer does.

import { todayManila } from "@/lib/metrics/windows";
import { normalizeStage, CLOSED_STAGES, STAGE_LABEL } from "@/lib/outreach/leads";
import { peso } from "@/lib/metrics/format";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "./types";

// ── Tunables (one place so UI copy and predicate never drift) ─────────────────

// A lead/creator with no scheduled next action is "due" once it has gone this
// many days without any logged contact (or has never been contacted at all).
export const STALE_DAYS = 7;

// On approval, the executor pushes the next touch out by this many days.
export const RESCHEDULE_DAYS = 3;

// The creator outreach pipeline's terminal stages — a follow-up is never drafted
// for a creator already signed or passed. Everything else with a stage set is in
// flight and eligible.
export const CREATOR_TERMINAL_STAGES = ["signed", "passed"] as const;

// Best-effort labels for the (free-text) creator outreach stages, for display in
// evidence. An unknown stage is shown title-cased rather than hidden.
const CREATOR_STAGE_LABEL: Record<string, string> = {
  sourced: "Sourced",
  contacted: "Contacted",
  negotiating: "Negotiating",
  onboarding: "Onboarding",
  signed: "Signed",
  passed: "Passed",
};

export function creatorStageLabel(stage: string | null | undefined): string {
  const s = (stage ?? "").trim().toLowerCase();
  if (!s) return "—";
  return CREATOR_STAGE_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  shopee: "Shopee",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  other: "their channel",
};

function platformLabel(platform: string | null | undefined): string {
  const p = (platform ?? "").trim().toLowerCase();
  return PLATFORM_LABEL[p] ?? (platform || "their channel");
}

// ── Row shapes (only the columns this producer needs) ─────────────────────────

export interface FollowUpLead {
  id: string;
  name: string;
  company: string | null;
  stage: string;
  value: number | null;
  owner_id: string | null;
  next_action: string | null;
  next_action_date: string | null; // YYYY-MM-DD
  last_contacted_at: string | null; // ISO timestamp
}

export interface FollowUpCreator {
  id: string;
  name: string;
  handle: string | null;
  platform: string;
  follower_count: number | null;
  category: string | null;
  owner_id: string | null;
  outreach_stage: string | null;
  next_action: string | null;
  next_action_date: string | null; // YYYY-MM-DD
  last_contacted_at: string | null; // ISO timestamp
}

// ── Date helpers (calendar-day math in Manila, consistent with windows.ts) ────

const DAY_MS = 86_400_000;

function dateStartUtcMs(d: string): number | null {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

// Whole days from `from` to `to` (both YYYY-MM-DD); null if either is unparseable.
// Positive when `to` is later than `from`.
export function daysBetweenDates(from: string, to: string): number | null {
  const a = dateStartUtcMs(from);
  const b = dateStartUtcMs(to);
  if (a == null || b == null) return null;
  return Math.round((b - a) / DAY_MS);
}

// Whole days since an ISO timestamp, or null when the timestamp is null/invalid.
export function daysSince(iso: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

// A YYYY-MM-DD `n` days after the given calendar day. Used to reschedule the
// next touch on approval.
export function addDays(dateStr: string, n: number): string {
  const base = dateStartUtcMs(dateStr);
  if (base == null) return dateStr;
  const d = new Date(base + n * DAY_MS);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// ── "Due for a follow-up" predicates ──────────────────────────────────────────
// A scheduled next_action_date on/before today makes a target due. When there is
// no scheduled date, the target is due once it has gone stale (> STALE_DAYS with
// no contact, or never contacted). Closed/terminal rows are never due.

export function isLeadDue(
  lead: FollowUpLead,
  today: string = todayManila(),
  nowMs: number = Date.now()
): boolean {
  if (CLOSED_STAGES.includes(normalizeStage(lead.stage))) return false;
  if (lead.next_action_date) return lead.next_action_date <= today;
  const since = daysSince(lead.last_contacted_at, nowMs);
  return since == null || since > STALE_DAYS;
}

export function isCreatorDue(
  creator: FollowUpCreator,
  today: string = todayManila(),
  nowMs: number = Date.now()
): boolean {
  const stage = (creator.outreach_stage ?? "").trim().toLowerCase();
  if (!stage) return false; // an outreach_stage must be set to be in the loop
  if ((CREATOR_TERMINAL_STAGES as readonly string[]).includes(stage)) return false;
  if (creator.next_action_date) return creator.next_action_date <= today;
  const since = daysSince(creator.last_contacted_at, nowMs);
  return since == null || since > STALE_DAYS;
}

// How overdue the touch is, in whole days: the gap past the scheduled date, or —
// when unscheduled — how far the no-contact span runs past the stale threshold.
// null when there is genuinely nothing to measure (unscheduled and never
// contacted), so the card can say "never contacted" instead of inventing a count.
function overdueDays(
  nextActionDate: string | null,
  lastContactedAt: string | null,
  today: string,
  nowMs: number
): number | null {
  if (nextActionDate) {
    const d = daysBetweenDates(nextActionDate, today);
    return d == null ? null : Math.max(0, d);
  }
  const since = daysSince(lastContactedAt, nowMs);
  if (since == null) return null; // never contacted, no schedule → not a number
  return Math.max(0, since - STALE_DAYS);
}

function overdueLabel(days: number | null, lastContactedAt: string | null): string {
  if (days == null) return lastContactedAt ? "overdue" : "no contact logged yet";
  if (days <= 0) return "due today";
  return `${days} day${days === 1 ? "" : "s"} overdue`;
}

// ── Drafted follow-up messages (tone-matched, real fields only) ───────────────

function firstName(name: string): string {
  return (name ?? "").trim().split(/\s+/)[0] || name;
}

// Client leads get a professional, business-development tone tailored to where
// the deal sits in the pipeline. Company name is woven in only when it exists.
export function draftLeadMessage(lead: FollowUpLead): string {
  const who = firstName(lead.name);
  const co = lead.company ? ` at ${lead.company}` : "";
  const stage = normalizeStage(lead.stage);

  let line: string;
  switch (stage) {
    case "replied":
      line = `I wanted to follow up on your last note and see how you're thinking about next steps.`;
      break;
    case "meeting":
      line = `It was great connecting${lead.company ? ` about ${lead.company}` : ""} — I wanted to keep the momentum going and see what would be most useful from our side.`;
      break;
    case "proposal":
      line = `I'm circling back on the proposal we shared to see if you had any questions or feedback I can help with.`;
      break;
    case "contacted":
      line = `I wanted to follow up on my earlier note and see if there's a good time to connect.`;
      break;
    default:
      line = `I wanted to reach out and see if there's a fit worth exploring together.`;
  }

  return (
    `Hi ${who},\n\n` +
    `${line}\n\n` +
    `Happy to work around your schedule${co ? ` — whatever's easiest for the team${lead.company ? ` at ${lead.company}` : ""}` : ""}. ` +
    `Just let me know and I'll set it up.\n\n` +
    `Best,\nMthryve`
  );
}

// Creators get a warmer, more casual DM tone that references their real platform
// and content category — never a follower number we'd be quoting back at them.
export function draftCreatorMessage(creator: FollowUpCreator): string {
  const who = firstName(creator.name);
  const cat = creator.category ? ` your ${creator.category} content` : " your content";
  const plat = platformLabel(creator.platform);

  return (
    `Hey ${who}! 👋\n\n` +
    `We've been loving${cat} on ${plat} and think there's a great fit for a collab with our brands. ` +
    `Just wanted to follow up and see if you're open to chatting about a partnership.\n\n` +
    `No pressure at all — let me know and we'd love to make something happen!\n\n` +
    `– The Mthryve team`
  );
}

// ── The drafted action_request payload (org_id stamped by the caller) ─────────

export interface FollowUpDraft {
  source_module: "bizdev" | "affiliate";
  source_ref: Record<string, unknown>;
  title: string;
  problem: string;
  root_cause: string;
  evidence: EvidenceFact[];
  options: ActionOption[];
  recommendation: string;
  estimated_impact: EstimatedImpact;
  confidence: number;
  risk_tier: number;
  required_role: RequiredRole;
  proposed_action: ProposedAction;
}

// A modest, honest confidence that a follow-up is genuinely due — it rises the
// more overdue the touch is, and is never presented as certain. Bounded to
// [0.55, 0.9].
function dueConfidence(days: number | null): number {
  const d = days ?? STALE_DAYS; // unscheduled-but-stale ≈ at least the threshold
  const raw = 0.55 + Math.min(0.35, d / 60);
  return Math.round(raw * 100) / 100;
}

// The shared "options Tony weighed", specialised only by the close-out verb.
function followUpOptions(closeVerb: "lost" | "passed"): ActionOption[] {
  return [
    {
      label: "Send the drafted follow-up",
      tradeoff:
        "Logs the message now and resets the next touch a few days out — keeps momentum without waiting on a manual nudge.",
    },
    {
      label: "Reschedule the next touch instead",
      tradeoff:
        "Pushes the follow-up out if now isn't the right moment — but it keeps aging in the meantime.",
    },
    {
      label: `Mark as ${closeVerb}`,
      tradeoff: `Takes it out of the active pipeline — only right if there's genuinely no path forward.`,
    },
  ];
}

// Build the draft for one due client lead.
export function buildLeadFollowUpDraft(
  lead: FollowUpLead,
  today: string = todayManila(),
  nowMs: number = Date.now()
): FollowUpDraft {
  const who = lead.company ? `${lead.name} (${lead.company})` : lead.name;
  const stage = normalizeStage(lead.stage);
  const days = overdueDays(lead.next_action_date, lead.last_contacted_at, today, nowMs);
  const overdue = overdueLabel(days, lead.last_contacted_at);

  const evidence: EvidenceFact[] = [
    { label: "Days overdue", value: days == null ? "—" : String(days) },
    {
      label: "Last contacted",
      value: lead.last_contacted_at
        ? `${daysSince(lead.last_contacted_at, nowMs)}d ago`
        : "Never",
    },
    { label: "Stage", value: STAGE_LABEL[stage] },
  ];
  if (lead.value != null) evidence.push({ label: "Est. value", value: peso(Number(lead.value)) });
  if (lead.next_action) evidence.push({ label: "Planned next action", value: lead.next_action });

  const message = draftLeadMessage(lead);

  return {
    source_module: "bizdev",
    source_ref: { lead_id: lead.id, owner_id: lead.owner_id },
    title: `Follow up: ${who}`,
    problem:
      `${who} is in the ${STAGE_LABEL[stage]} stage and ${overdue} for a follow-up. ` +
      `A timely, tone-matched touch keeps the deal warm before it goes cold.`,
    root_cause:
      lead.next_action_date
        ? `The scheduled next action (${lead.next_action_date}) has passed with no logged contact since.`
        : `No next action is scheduled and there's been no recent contact, so the lead is quietly aging in the pipeline.`,
    evidence,
    options: followUpOptions("lost"),
    recommendation: `Send the drafted follow-up to re-engage ${firstName(lead.name)} now, then let the OS reset the next touch ${RESCHEDULE_DAYS} days out.`,
    estimated_impact: {
      summary: `Keeps ${who} active in the pipeline instead of going cold from silence.`,
      gap_value: lead.value != null ? Number(lead.value) : null,
      gap_unit: lead.value != null ? "pipeline value" : null,
      is_money: lead.value != null,
    },
    confidence: dueConfidence(days),
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "log_followup",
      payload: {
        lead_id: lead.id,
        channel: "email",
        drafted_message: message,
      },
    },
  };
}

// Build the draft for one due affiliate/KOL creator.
export function buildCreatorFollowUpDraft(
  creator: FollowUpCreator,
  today: string = todayManila(),
  nowMs: number = Date.now()
): FollowUpDraft {
  const handle = creator.handle ? ` ${creator.handle}` : "";
  const who = `${creator.name}${handle}`;
  const stageLabel = creatorStageLabel(creator.outreach_stage);
  const days = overdueDays(creator.next_action_date, creator.last_contacted_at, today, nowMs);
  const overdue = overdueLabel(days, creator.last_contacted_at);

  const evidence: EvidenceFact[] = [
    { label: "Days overdue", value: days == null ? "—" : String(days) },
    {
      label: "Last contacted",
      value: creator.last_contacted_at
        ? `${daysSince(creator.last_contacted_at, nowMs)}d ago`
        : "Never",
    },
    { label: "Stage", value: stageLabel },
    { label: "Platform", value: platformLabel(creator.platform) },
  ];
  if (creator.follower_count != null)
    evidence.push({ label: "Followers", value: Number(creator.follower_count).toLocaleString("en-US") });
  if (creator.category) evidence.push({ label: "Category", value: creator.category });

  const message = draftCreatorMessage(creator);

  return {
    source_module: "affiliate",
    source_ref: { creator_id: creator.id, owner_id: creator.owner_id },
    title: `Follow up: ${who}`,
    problem:
      `${who} is in the ${stageLabel} outreach stage and ${overdue}. ` +
      `A friendly nudge on ${platformLabel(creator.platform)} keeps the partner conversation alive.`,
    root_cause: creator.next_action_date
      ? `The scheduled next action (${creator.next_action_date}) has passed with no logged contact since.`
      : `No next action is scheduled and there's been no recent contact, so the creator is drifting out of the pipeline.`,
    evidence,
    options: followUpOptions("passed"),
    recommendation: `Send the drafted follow-up to re-engage ${firstName(creator.name)} now, then let the OS reset the next touch ${RESCHEDULE_DAYS} days out.`,
    estimated_impact: {
      summary: `Keeps ${who} warm as an affiliate/KOL prospect instead of losing them to silence.`,
      gap_value: null,
      gap_unit: null,
      is_money: false,
    },
    confidence: dueConfidence(days),
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "log_followup",
      payload: {
        creator_id: creator.id,
        channel: "message",
        drafted_message: message,
      },
    },
  };
}
