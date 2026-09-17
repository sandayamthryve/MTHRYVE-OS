// lib/outreach/leads.ts — shared domain model for the BizDev Outreach module.
//
// One home for the outreach pipeline stages, activity types, and the
// leadership-or-owner edit rule, so the board, the lead detail page, and the
// server actions all agree. The leads/outreach_activities tables are org/RLS
// scoped in Postgres; the owner/leadership gate is an application-layer rule
// (RLS only isolates orgs), enforced identically here and in the actions.

import type { UserRole } from "@/types/database";

// Roles allowed to open the module at all (read + create). Editing an existing
// lead is further gated to leadership or the lead owner — see canEditLead.
export const OUTREACH_ROLES = ["ceo", "coo", "department_head", "team_member"] as const;

// The pipeline stages, in board order. `stage` is free text in the DB, so this
// is the canonical set the board renders as columns.
export const STAGES = [
  "new",
  "contacted",
  "replied",
  "meeting",
  "proposal",
  "won",
  "lost",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

// Closed stages don't count toward open pipeline value.
export const CLOSED_STAGES: Stage[] = ["won", "lost"];

// Aliases from the older Leads/CRM stage set (which used "qualified") so a lead
// created there still lands in a sensible board column. Anything otherwise
// unrecognized falls back to "new" so no lead is ever hidden from the board.
const STAGE_ALIAS: Record<string, Stage> = { qualified: "replied" };

export function normalizeStage(raw: string | null | undefined): Stage {
  const s = (raw ?? "").trim().toLowerCase();
  if ((STAGES as readonly string[]).includes(s)) return s as Stage;
  if (s in STAGE_ALIAS) return STAGE_ALIAS[s];
  return "new";
}

export function isStage(raw: string): raw is Stage {
  return (STAGES as readonly string[]).includes(raw);
}

// Activity types logged against a lead, in the order shown in pickers.
export const ACTIVITY_TYPES = [
  "call",
  "email",
  "message",
  "meeting",
  "note",
  "proposal",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  call: "Call",
  email: "Email",
  message: "Message",
  meeting: "Meeting",
  note: "Note",
  proposal: "Proposal",
};

export function isActivityType(raw: string): raw is ActivityType {
  return (ACTIVITY_TYPES as readonly string[]).includes(raw);
}

// Leadership can edit any lead in their org; everyone else may edit only leads
// they own. Used to gate stage moves, lead edits, and activity logging.
export function isLeadership(role: UserRole): boolean {
  return role === "ceo" || role === "coo";
}

export function canEditLead(
  actor: { id: string; role: UserRole },
  lead: { owner_id: string | null }
): boolean {
  return isLeadership(actor.role) || (lead.owner_id != null && lead.owner_id === actor.id);
}

// The row shape the module reads from `leads`.
export type OutreachLead = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  department: string | null;
  stage: string;
  value: number | null;
  notes: string | null;
  owner_id: string | null;
  next_action: string | null;
  next_action_date: string | null;
  last_contacted_at: string | null;
  created_at: string;
  updated_at: string | null;
};

export type OutreachActivity = {
  id: string;
  lead_id: string;
  activity_type: string;
  note: string | null;
  occurred_at: string;
  created_by: string | null;
  created_at: string;
};
