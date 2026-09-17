// lib/commerce-ops/records.ts — the shared vocabulary for Operational Records
// (Campaigns, Promotions, Missions, Rewards). One unified record type, one
// standardized approval workflow. Kept pure (no DB) so the page, the forms and
// the server actions never drift on statuses, departments or type-specific
// field shapes.

import type { BadgeTone } from "@/components/ui";

// ── Record types ──────────────────────────────────────────────────────────────
export type RecordType = "campaign" | "promotion" | "mission" | "reward";

export const RECORD_TYPES: RecordType[] = ["campaign", "promotion", "mission", "reward"];

export const RECORD_TYPE_LABEL: Record<RecordType, string> = {
  campaign: "Campaigns",
  promotion: "Promotions",
  mission: "Missions",
  reward: "Rewards",
};

// Singular label for buttons / headings ("New campaign").
export const RECORD_TYPE_SINGULAR: Record<RecordType, string> = {
  campaign: "campaign",
  promotion: "promotion",
  mission: "mission",
  reward: "reward",
};

export function isRecordType(v: string): v is RecordType {
  return (RECORD_TYPES as string[]).includes(v);
}

// ── Workflow status ───────────────────────────────────────────────────────────
export type OpStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "revision_requested"
  | "completed";

export const STATUS_LABEL: Record<OpStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  revision_requested: "Revision requested",
  completed: "Completed",
};

export function statusTone(status: OpStatus): BadgeTone {
  switch (status) {
    case "approved":
      return "teal";
    case "submitted":
      return "amber";
    case "revision_requested":
      return "violet";
    case "rejected":
      return "red";
    case "completed":
      return "teal";
    default:
      return "muted"; // draft
  }
}

// ── Departments a record can be rolled down to ────────────────────────────────
export const DEPARTMENTS = [
  "Marketing",
  "Creatives",
  "Affiliate",
  "Live Ops",
  "Warehouse",
  "Customer Service",
  "Finance",
  "Business Development",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export function isDepartment(v: string): v is Department {
  return (DEPARTMENTS as readonly string[]).includes(v);
}

// ── Type-specific detail fields (stored in op_records.details jsonb) ───────────
// Each record type declares the extra fields its form renders and its table
// summarizes. `money` fields are RECORDED ONLY — never moved automatically.
export type DetailFieldKind = "text" | "number" | "money" | "select" | "textarea";

export interface DetailField {
  key: string;
  label: string;
  kind: DetailFieldKind;
  options?: string[]; // for select
  placeholder?: string;
  help?: string;
}

export const DETAIL_FIELDS: Record<RecordType, DetailField[]> = {
  campaign: [
    { key: "budget", label: "Budget allocation (₱)", kind: "money", help: "Recorded for human action only — never moved automatically." },
    { key: "objective", label: "Objective", kind: "text", placeholder: "e.g. Q3 GMV lift" },
    { key: "channels", label: "Channels", kind: "text", placeholder: "TikTok, Shopee, Live" },
    { key: "kpi_target", label: "KPI target", kind: "text", placeholder: "e.g. ₱2.0M GMV / 5k orders" },
    { key: "kpi_actual", label: "KPI actual", kind: "text", placeholder: "e.g. ₱1.6M GMV / 3.9k orders" },
  ],
  promotion: [
    {
      key: "promo_type",
      label: "Promotion type",
      kind: "select",
      options: ["voucher", "flash_sale", "bundle", "discount", "free_shipping"],
    },
    { key: "platform", label: "Platform", kind: "select", options: ["TikTok", "Shopee", "Lazada", "All"] },
    { key: "discount_value", label: "Discount / value", kind: "text", placeholder: "e.g. 15% or ₱100 off" },
    { key: "budget", label: "Budget / cap (₱)", kind: "money", help: "Recorded for human action only." },
    { key: "mechanics", label: "Mechanics", kind: "textarea", placeholder: "Voucher rules, min spend, cap…" },
  ],
  mission: [
    { key: "personnel", label: "Assigned personnel", kind: "text", placeholder: "Names / handles" },
    { key: "objective", label: "Mission objective", kind: "textarea" },
    { key: "progress", label: "Progress (%)", kind: "number", placeholder: "0–100" },
    {
      key: "completion",
      label: "Completion status",
      kind: "select",
      options: ["not_started", "in_progress", "submitted", "verified"],
    },
    { key: "reward_value", label: "Reward on completion (₱)", kind: "money", help: "Recorded only — paid by humans." },
  ],
  reward: [
    { key: "reward_type", label: "Reward type", kind: "select", options: ["cash", "voucher", "points", "prize", "commission"] },
    { key: "recipient", label: "Recipient", kind: "text", placeholder: "Person / team / affiliate" },
    { key: "value", label: "Reward value (₱)", kind: "money", help: "Recorded for human payout — never auto-paid." },
    { key: "claim_status", label: "Claim status", kind: "select", options: ["pending", "claimed", "paid"] },
    { key: "incentive_ref", label: "Incentive reference", kind: "text", placeholder: "Program / promo tie-in" },
  ],
};

export const SOURCE_MODULE = "commerce_ops";

// Which roles may approve/reject/route (mirrors the op_records guard + the
// action_requests ar_update policy). Everyone in the org can create + submit.
export const LEADERSHIP_ROLES = ["ceo", "coo", "department_head"] as const;

export function isLeadership(role: string): boolean {
  return (LEADERSHIP_ROLES as readonly string[]).includes(role);
}
