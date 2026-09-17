// lib/archive/config.ts — the single source of truth for Edit + Soft-Archive
// across every user-facing cluster. SERVER-ONLY (imported by server components
// and the shared server actions; never by a "use client" module — the gate
// predicates are functions and would not serialize).
//
// The rollout is deliberately generic: one registry maps a stable `cluster` key
// to its table, its EXISTING write-gate (reused verbatim so archive/edit never
// loosen a cluster's authority), the paths to revalidate, an optional per-row
// guard (expenses/outreach/leads/op-records/payroll), and — only for clusters
// that lack a bespoke edit UI — a whitelist of editable scalar fields the shared
// dialog renders. The shared server actions resolve this registry by cluster key
// on the server, so a client can never smuggle in an arbitrary table name or
// field. Each cluster's canWrite is copied from that cluster's existing write
// action (cited per entry) — we reuse, never loosen, its gate. Where an entry is
// intentionally TIGHTER than the existing write path (e.g. documents), that only
// restricts, never widens, and is noted.

import type { SessionProfile } from "@/lib/auth/session";
import { isClientOwner, isWarehouseWriter } from "@/lib/auth/session";
import type { UserRole } from "@/types/database";

// Leadership as the OS defines it everywhere else. Hard-delete is deliberately
// NARROWER than this (ceo/coo only) — see HARD_DELETE_ROLES.
const LEADERSHIP: UserRole[] = ["ceo", "coo", "department_head"];
export const HARD_DELETE_ROLES: UserRole[] = ["ceo", "coo"];

export function isLeadership(role: UserRole): boolean {
  return LEADERSHIP.includes(role);
}
export function canHardDelete(profile: { role: UserRole }): boolean {
  return HARD_DELETE_ROLES.includes(profile.role);
}

// A single editable field the shared edit dialog knows how to render + persist.
// Only scalar, side-effect-free fields belong here — status/stage/workflow enums
// are intentionally excluded from the generic editor so we never fire a status
// transition (with its own side effects) through a plain field save.
export type FieldType = "text" | "textarea" | "number" | "date" | "select";
export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  step?: string; // for number inputs
  options?: { value: string; label: string }[]; // for select
}

// The outcome of a per-row guard: whether the write is allowed and, if not, a
// human message to surface (e.g. "Approved expenses can't be archived").
export interface GuardResult {
  ok: boolean;
  error?: string;
}

export interface ClusterConfig {
  // The Postgres table. Always carries archived_at/archived_by + org_id + id.
  table: string;
  // Singular human label, e.g. "brand", used in confirm copy + audit detail.
  label: string;
  // Column holding the human name of a row (for confirm dialogs + audit).
  labelField: string;
  // The cluster's EXISTING coarse write-gate, reused verbatim. Governs who may
  // edit / archive / restore. Hard-delete ignores this (ceo/coo only).
  canWrite: (p: SessionProfile) => boolean;
  // Optional extra columns to load for the per-row guard below.
  guardColumns?: string;
  // Optional per-row refinement applied to archive AND restore — the row-level
  // half of a cluster's write-gate (lead ownership, op-record workflow stage) or
  // a safety rule (only archive draft/cancelled expenses, non-sent outreach,
  // draft payroll runs).
  rowGuard?: (p: SessionProfile, row: Record<string, unknown>) => GuardResult;
  // Next.js paths to revalidate after any change so every list surface refreshes.
  revalidate: string[];
  // ONLY set for clusters with no bespoke edit UI — the shared dialog renders
  // these. Clusters that already own an edit form leave this undefined and keep
  // editing where it lives today (so we neither duplicate nor loosen it).
  editFields?: FieldSpec[];
  // When set, the raw one-click hard-delete is REPLACED (for every role) by a
  // "Request deletion" control that files a governed 2-approval request (COO →
  // CEO) instead of deleting. The value is the governance entity key (see
  // lib/governance/delete-entities.ts). Only clusters listed there are eligible.
  governedDeleteEntity?: string;
  // Optional role gate on the governed "Request deletion" control. The default
  // governed pattern is "anyone may request; the officers decide", so most
  // clusters leave this unset (control shown to every member). Set it only when a
  // cluster's DELETE must not even be REQUESTABLE below a role — e.g. videos, where
  // the doctrine keeps the whole delete surface (not just execution) leadership-only
  // so a team_member never sees a delete control on the Live & Video Wall. When the
  // gate returns false the governed control is suppressed AND the one-click
  // hard-delete stays off (rowActionProps), so the member has no permanent-delete
  // path at all — matching the leadership-only RLS DELETE.
  governedDeleteGate?: (p: SessionProfile) => boolean;
  // When true, this cluster has NO permanent-delete surface at all — neither the
  // one-click hard-delete NOR the governed "Request deletion". Archive/restore is
  // the only removal path. Used for FINANCIAL-ROOT records (brands, finance
  // entries) that must never be hard-deleted: a brand has 13 blocking inbound FKs
  // (shops, marketplace, TikTok performance, campaigns, contracts, expenses,
  // finance entries…) and a finance entry backs payroll runs, so deleting either
  // is never appropriate — it is archived instead. Overrides governedDeleteEntity
  // and canHardDelete both (see rowActionProps + hardDeleteRow).
  archiveOnly?: boolean;
}

export type ClusterKey =
  | "brands"
  | "campaigns"
  | "client_contracts"
  | "op_records"
  | "leads"
  | "products"
  | "return_cases"
  | "cases"
  | "pods"
  | "projects"
  | "tasks"
  | "brand_initiatives"
  | "content_items"
  | "live_sessions"
  | "videos"
  | "anchors"
  | "creators"
  | "affiliate_deals"
  | "affiliate_content"
  | "affiliate_samples"
  | "outreach_messages"
  | "expenses"
  | "budgets"
  | "finance_entries"
  | "payroll_runs"
  | "vacancies"
  | "candidates"
  | "metric_entries"
  | "daily_reports"
  | "documents";

// --- Gate builders ---------------------------------------------------------
const roleGate =
  (roles: UserRole[]) =>
  (p: SessionProfile): boolean =>
    roles.includes(p.role);
const ALL_ROLES: UserRole[] = ["ceo", "coo", "department_head", "team_member"];
const LEADERSHIP_GATE = roleGate(LEADERSHIP);
const EXEC_GATE = roleGate(["ceo", "coo"]);
const anyAuthed = (_p: SessionProfile): boolean => true; // any signed-in org member

// --- Per-row guards --------------------------------------------------------

// leads: leadership (ceo/coo) OR the lead's owner. Mirrors canEditLead so
// archive/restore obey the same row-level authority as an edit does.
function leadRowGuard(p: SessionProfile, row: Record<string, unknown>): GuardResult {
  if (p.role === "ceo" || p.role === "coo") return { ok: true };
  if (row.owner_id != null && row.owner_id === p.id) return { ok: true };
  return { ok: false, error: "Only the lead owner or leadership can change this lead." };
}

// op_records: once past draft/revision it is leadership-only, matching the
// updateOpRecord workflow gate — archiving a submitted record is a leadership act.
function opRecordRowGuard(p: SessionProfile, row: Record<string, unknown>): GuardResult {
  const status = String(row.status ?? "");
  const open = status === "draft" || status === "revision_requested";
  if (open || isLeadership(p.role)) return { ok: true };
  return { ok: false, error: "Submitted records can only be archived by leadership." };
}

// expenses: archive ONLY on safe states. The draft-equivalent is
// workflow_stage='encoded' (status 'pending'); the cancelled-equivalent is
// status='cancelled'. Everything submitted/approved/paid stays on the ledger so
// finance rollups never lose an approved cost to an archive.
function expenseRowGuard(_p: SessionProfile, row: Record<string, unknown>): GuardResult {
  const status = String(row.status ?? "").toLowerCase();
  const stage = String(row.workflow_stage ?? "").toLowerCase();
  if (status === "cancelled" || stage === "encoded") return { ok: true };
  return {
    ok: false,
    error: "Only draft (encoded) or cancelled expenses can be archived — approved/paid costs stay on the ledger.",
  };
}

// outreach_messages: archive ONLY on non-sent statuses. A message that already
// went out is a permanent record of what we said.
function outreachRowGuard(_p: SessionProfile, row: Record<string, unknown>): GuardResult {
  const status = String(row.status ?? "").toLowerCase();
  if (status === "sent") {
    return { ok: false, error: "A sent message can't be archived — it's a record of what was sent." };
  }
  return { ok: true };
}

// payroll_runs: only draft runs may be archived. A posted run has a Finance
// entry behind it and is a financial record.
function payrollRowGuard(_p: SessionProfile, row: Record<string, unknown>): GuardResult {
  const status = String(row.status ?? "").toLowerCase();
  if (status === "draft") return { ok: true };
  return { ok: false, error: "Only draft payroll runs can be archived — posted runs are financial records." };
}

// --- The registry ----------------------------------------------------------
export const CLUSTERS: Record<ClusterKey, ClusterConfig> = {
  // Business Development owns the client relationship (isClientOwner). Edit UI
  // lives in /clients (updateClient).
  // ARCHIVE-ONLY. A brand is a financial-root record with 13 blocking (NO ACTION)
  // inbound FKs — hard-deleting one throws 23503 and would orphan/destroy shops,
  // marketplace, TikTok performance, contracts, expenses and finance entries. It
  // is never hard-deleted, only archived. No governed request, no one-click.
  brands: {
    table: "brands",
    label: "client",
    labelField: "name",
    canWrite: isClientOwner,
    revalidate: ["/clients", "/brands"],
    archiveOnly: true,
  },
  // campaigns/page.tsx: requireRole(ceo/coo/dept_head/team_member). No full edit
  // UI today → generic edit.
  campaigns: {
    table: "campaigns",
    label: "campaign",
    labelField: "name",
    canWrite: roleGate(ALL_ROLES),
    revalidate: ["/campaigns"],
    editFields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "department", label: "Department", type: "text" },
      { name: "start_date", label: "Start date", type: "date" },
      { name: "end_date", label: "End date", type: "date" },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
    governedDeleteEntity: "campaign",
  },
  // contracts/actions.ts CONTRACT_ROLES = ceo/coo/dept_head. Edit UI exists.
  client_contracts: {
    table: "client_contracts",
    label: "contract",
    labelField: "client_name",
    canWrite: LEADERSHIP_GATE,
    revalidate: ["/contracts", "/clients"],
    governedDeleteEntity: "client_contract",
  },
  // commerce-ops/actions.ts ALL_ROLES + workflow refinement. Edit UI exists.
  op_records: {
    table: "op_records",
    label: "record",
    labelField: "title",
    canWrite: roleGate(ALL_ROLES),
    guardColumns: "id, org_id, status, title",
    rowGuard: opRecordRowGuard,
    revalidate: ["/commerce-ops", "/affiliate", "/affiliate/fulfillment", "/live-ops"],
    governedDeleteEntity: "op_record",
  },
  // outreach/actions.ts OUTREACH_ROLES + canEditLead row gate. Edit UI exists.
  leads: {
    table: "leads",
    label: "lead",
    labelField: "name",
    canWrite: roleGate(ALL_ROLES),
    guardColumns: "id, org_id, owner_id, name",
    rowGuard: leadRowGuard,
    revalidate: ["/outreach", "/leads"],
    governedDeleteEntity: "lead",
  },
  // products/page.tsx isWarehouseWriter. Inline edit UI exists.
  products: {
    table: "products",
    label: "product",
    labelField: "product_name",
    canWrite: isWarehouseWriter,
    revalidate: ["/warehouse/products", "/warehouse"],
    governedDeleteEntity: "product",
  },
  // rts/actions.ts + warehouse/page.tsx: requireProfile (any authenticated
  // warehouse user). Edit UI exists.
  return_cases: {
    table: "return_cases",
    label: "return / RTS record",
    labelField: "rts_number",
    canWrite: anyAuthed,
    revalidate: ["/warehouse/rts", "/warehouse"],
    governedDeleteEntity: "return_case",
  },
  // cases/actions.ts: requireProfile for general edits (terminal transitions are
  // leadership-only, but archive is a general edit). Update paths exist.
  cases: {
    table: "cases",
    label: "case",
    labelField: "case_number",
    canWrite: anyAuthed,
    revalidate: ["/warehouse/cases"],
    governedDeleteEntity: "case",
  },
  // pods/actions.ts LEADERSHIP set. Has updatePod, but no plain field dialog →
  // generic edit for name/target/notes (status stays in updatePod). The raw
  // one-click hard-delete is REPLACED by the governed 2-approval delete gate
  // (COO → CEO) — a pod is a container for brand assignments + P&L, so removing
  // one is a data-loss act that must not sit one-click. Anyone may request; only
  // the officers approve; only the executor deletes (pod_brands then the pod).
  pods: {
    table: "pods",
    label: "pod",
    labelField: "name",
    canWrite: LEADERSHIP_GATE,
    revalidate: ["/pods", "/scoreboard"],
    editFields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "target_brands", label: "Target brands", type: "number", step: "1" },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
    governedDeleteEntity: "pod",
  },
  // projects: RLS-only, org-open (client-island writes, no app role gate). Match
  // the existing inline edit — any authenticated org member. Edit UI exists.
  projects: {
    table: "projects",
    label: "project",
    labelField: "name",
    canWrite: anyAuthed,
    revalidate: ["/tasks", "/projects"],
    governedDeleteEntity: "project",
  },
  // tasks: RLS-only, org-open (same as projects). Edit UI exists (TaskControls).
  // The raw hard-delete is replaced by the governed 2-approval delete gate
  // (COO → CEO) — see PASTE 2 / lib/governance. Anyone may request; only the
  // officers may approve, and only the executor ever deletes.
  tasks: {
    table: "tasks",
    label: "task",
    labelField: "title",
    canWrite: anyAuthed,
    revalidate: ["/tasks"],
    governedDeleteEntity: "task",
  },
  // brands/page.tsx addBrandInitiative: requireRole(4 roles). No edit UI today →
  // generic edit.
  brand_initiatives: {
    table: "brand_initiatives",
    label: "initiative",
    labelField: "name",
    canWrite: roleGate(ALL_ROLES),
    revalidate: ["/brands", "/creative-studio"],
    editFields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "start_date", label: "Start date", type: "date" },
      { name: "end_date", label: "End date", type: "date" },
      { name: "note", label: "Note", type: "textarea" },
    ],
    governedDeleteEntity: "brand_initiative",
  },
  // creative-studio/page.tsx saveContentItem: requireProfile (any authed);
  // delete is leadership. Edit UI exists.
  content_items: {
    table: "content_items",
    label: "content item",
    labelField: "title",
    canWrite: anyAuthed,
    revalidate: ["/creative-studio", "/content-calendar"],
    governedDeleteEntity: "content_item",
  },
  // live_sessions: live-ops edit = 4 roles, live-wall = 3 roles. Use the broader
  // gate that at least one existing edit path already grants (RLS is the real
  // authority; both surfaces write the same table). Edit UI exists.
  live_sessions: {
    table: "live_sessions",
    label: "live session",
    labelField: "title",
    canWrite: roleGate(ALL_ROLES),
    revalidate: ["/live-ops", "/live-ops/schedule", "/live-ops/reports", "/live-wall"],
    governedDeleteEntity: "live_session",
  },
  // videos: org INSERT/UPDATE (mirrors content_items), so any member posts + edits
  // a video — canWrite is anyAuthed, matching the content_items cluster. Edit uses
  // the generic dialog (no bespoke editor). DELETE stays leadership on BOTH sides:
  // RLS keeps videos_write (ALL) leadership-only, and governedDeleteGate hides the
  // "Request deletion" control below leadership so a team_member never sees a video
  // delete control at all (the Live & Video Wall's ✕ hard-delete is likewise gated).
  videos: {
    table: "videos",
    label: "video",
    labelField: "title",
    canWrite: anyAuthed,
    revalidate: ["/live-wall"],
    editFields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "video_url", label: "Video URL", type: "text", required: true },
      { name: "description", label: "Description", type: "textarea" },
    ],
    governedDeleteEntity: "video",
    governedDeleteGate: (p) => isLeadership(p.role),
  },
  // live/actions.ts MANAGE_ROLES = 4 roles. Full edit UI exists (updateAnchor).
  anchors: {
    table: "anchors",
    label: "anchor",
    labelField: "name",
    canWrite: roleGate(ALL_ROLES),
    revalidate: ["/live", "/live-ops", "/live-ops/schedule", "/creative-studio"],
    governedDeleteEntity: "anchor",
  },
  // creators/page.tsx requireRole(4 roles). Roster edit exists (updateCreatorRoster).
  creators: {
    table: "creators",
    label: "creator",
    labelField: "name",
    canWrite: roleGate(ALL_ROLES),
    revalidate: ["/creators", "/affiliate", "/affiliate/engage"],
    governedDeleteEntity: "creator",
  },
  // creators/page.tsx createDeal/updateDealStatus: requireRole(4 roles). Only a
  // status editor today → generic edit for the descriptive fields.
  affiliate_deals: {
    table: "affiliate_deals",
    label: "deal",
    labelField: "id",
    canWrite: roleGate(ALL_ROLES),
    revalidate: ["/creators", "/affiliate"],
    editFields: [
      { name: "commission_rate", label: "Commission %", type: "number", step: "any" },
      { name: "deliverables", label: "Deliverables", type: "textarea" },
      { name: "start_date", label: "Start date", type: "date" },
      { name: "end_date", label: "End date", type: "date" },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
    governedDeleteEntity: "affiliate_deal",
  },
  // affiliate/actions.ts MANAGE_ROLES (via actor()) = 4 roles. Transition UI exists.
  affiliate_content: {
    table: "affiliate_content",
    label: "content",
    labelField: "id",
    canWrite: roleGate(ALL_ROLES),
    revalidate: ["/affiliate", "/affiliate/fulfillment"],
    governedDeleteEntity: "affiliate_content",
  },
  // affiliate/actions.ts MANAGE_ROLES = 4 roles. Transition UI exists.
  affiliate_samples: {
    table: "affiliate_samples",
    label: "sample",
    labelField: "id",
    canWrite: roleGate(ALL_ROLES),
    revalidate: ["/affiliate", "/affiliate/fulfillment"],
    governedDeleteEntity: "affiliate_sample",
  },
  // affiliate/actions.ts MANAGE_ROLES = 4 roles (approve is leadership; edit is
  // MANAGE). Archive ONLY on non-sent statuses.
  outreach_messages: {
    table: "outreach_messages",
    label: "message",
    labelField: "id",
    canWrite: roleGate(ALL_ROLES),
    guardColumns: "id, org_id, status",
    rowGuard: outreachRowGuard,
    revalidate: ["/affiliate", "/affiliate/engage", "/outreach"],
    governedDeleteEntity: "outreach_message",
  },
  // expenses/actions.ts: ceo/coo (canManageExpense). Archive ONLY on safe states.
  expenses: {
    table: "expenses",
    label: "expense",
    labelField: "expense_code",
    canWrite: EXEC_GATE,
    guardColumns: "id, org_id, status, workflow_stage, expense_code",
    rowGuard: expenseRowGuard,
    revalidate: ["/finance/expenses", "/finance/expenses/records", "/finance/expenses/budgets", "/finance"],
    governedDeleteEntity: "expense",
  },
  // budgets/actions.ts setBudget: requireRole(["coo"]) — COO-only, tighter than
  // leadership. Upsert edit exists.
  budgets: {
    table: "budgets",
    label: "budget",
    labelField: "scope",
    canWrite: roleGate(["coo"]),
    revalidate: ["/finance/expenses/budgets", "/finance/expenses"],
    governedDeleteEntity: "budget",
  },
  // finance/page.tsx: requireRole(["ceo","coo"]). Generic edit lets leadership
  // correct an entry (audited). ARCHIVE-ONLY: a finance entry backs payroll runs
  // (payroll_runs.finance_entry_id is NO ACTION) and is a financial-root record —
  // it is never hard-deleted, only archived. No governed request, no one-click.
  finance_entries: {
    table: "finance_entries",
    label: "finance entry",
    labelField: "category",
    canWrite: EXEC_GATE,
    revalidate: ["/finance"],
    editFields: [
      { name: "entry_date", label: "Date", type: "date", required: true },
      { name: "category", label: "Category", type: "text", required: true },
      { name: "amount", label: "Amount", type: "number", step: "any", required: true },
      { name: "note", label: "Note", type: "textarea" },
    ],
    archiveOnly: true,
  },
  // payroll/page.tsx: requireRole(["ceo","coo"]). Archive ONLY on draft runs.
  payroll_runs: {
    table: "payroll_runs",
    label: "payroll run",
    labelField: "id",
    canWrite: EXEC_GATE,
    guardColumns: "id, org_id, status",
    rowGuard: payrollRowGuard,
    revalidate: ["/payroll", "/finance"],
    governedDeleteEntity: "payroll_run",
  },
  // recruitment/page.tsx saveVacancy: requireRole(["ceo","coo","department_head"]).
  // Full edit UI exists.
  vacancies: {
    table: "vacancies",
    label: "vacancy",
    labelField: "title",
    canWrite: LEADERSHIP_GATE,
    revalidate: ["/recruitment"],
    governedDeleteEntity: "vacancy",
  },
  // recruitment/page.tsx: requireRole(["ceo","coo","department_head"]). Only a
  // stage editor today → generic edit for name/contact/notes.
  candidates: {
    table: "candidates",
    label: "candidate",
    labelField: "name",
    canWrite: LEADERSHIP_GATE,
    revalidate: ["/recruitment"],
    editFields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "email", label: "Email", type: "text" },
      { name: "phone", label: "Phone", type: "text" },
      { name: "notes", label: "Notes", type: "textarea" },
    ],
    governedDeleteEntity: "candidate",
  },
  // metric_entries mutations: requireRole(["ceo","coo","department_head"]).
  // Reconcile/approve UI exists; no generic field edit (values flow through
  // reconciliation so we never fork the reconciliation floor).
  metric_entries: {
    table: "metric_entries",
    label: "metric entry",
    labelField: "metric_key",
    canWrite: LEADERSHIP_GATE,
    revalidate: ["/metrics"],
    governedDeleteEntity: "metric_entry",
  },
  // daily-report/actions.ts submit: requireProfile (own row via RLS).
  daily_reports: {
    table: "daily_reports",
    label: "daily report",
    labelField: "work_date",
    canWrite: anyAuthed,
    revalidate: ["/daily-report"],
    governedDeleteEntity: "daily_report",
  },
  // documents (knowledge corpus). Archiving a document also removes its chunks
  // from RAG retrieval, so gate at leadership — this only restricts, never
  // widens, the existing upload path.
  documents: {
    table: "documents",
    label: "document",
    labelField: "title",
    canWrite: LEADERSHIP_GATE,
    revalidate: ["/knowledge"],
    governedDeleteEntity: "document",
  },
};

// The result every shared archive action returns. `nonce` changes on each call
// so a client effect can react even when ok/error repeat identically.
export interface ArchiveActionState {
  ok: boolean;
  error?: string;
  nonce?: number;
}

// The fully-resolved, serializable props the shared <RowActions> control needs.
// No functions — booleans are resolved server-side. Defined here (not in the
// client component) so both the component and rowActionProps() share one shape.
export interface RowActionsProps {
  cluster: ClusterKey;
  id: string;
  label: string;
  archived: boolean;
  canWrite: boolean;
  canHardDelete: boolean;
  editFields?: FieldSpec[] | null;
  editValues?: Record<string, string | number | null>;
  // When set, the row shows a governed "Request deletion" control (to every
  // role) in place of the raw hard-delete. Carries the governance entity key.
  governedDelete?: { entity: string } | null;
  className?: string;
}

// The one-liner every cluster page uses:  <RowActions {...rowActionProps("campaigns", row, profile)} />
// `row` must have been selected WITH id, archived_at, the cluster's labelField,
// and (for generic-edit clusters) its editFields — otherwise those render blank.
export function rowActionProps(
  cluster: ClusterKey,
  row: Record<string, unknown>,
  profile: SessionProfile
): RowActionsProps {
  const c = CLUSTERS[cluster];
  const editValues: Record<string, string | number | null> = {};
  if (c.editFields) {
    for (const f of c.editFields) {
      const v = row[f.name];
      editValues[f.name] = v == null ? null : (v as string | number);
    }
  }
  const labelRaw = row[c.labelField];
  // ARCHIVE-ONLY clusters have NO permanent-delete surface — neither the governed
  // request nor the one-click. A governed cluster replaces the raw hard-delete
  // with a "Request deletion" control, so the one-click is suppressed for EVERYONE
  // (leadership included) — the only path to a permanent delete is the 2-approval
  // chain. Ungoverned, non-archive-only clusters keep the ceo/coo one-click.
  // A governedDeleteGate (only videos today) can suppress the governed "Request
  // deletion" below a role — the member then has no permanent-delete surface, since
  // canHardDelete below also stays false for anyone but ceo/coo. Leadership keeps it.
  const governed =
    !c.archiveOnly &&
    c.governedDeleteEntity &&
    (!c.governedDeleteGate || c.governedDeleteGate(profile))
      ? { entity: c.governedDeleteEntity }
      : null;
  return {
    cluster,
    id: String(row.id ?? ""),
    label: labelRaw != null && String(labelRaw).trim() ? String(labelRaw) : c.label,
    archived: row.archived_at != null,
    canWrite: c.canWrite(profile),
    canHardDelete: c.archiveOnly ? false : governed ? false : canHardDelete(profile),
    editFields: c.editFields ?? null,
    editValues,
    governedDelete: governed,
  };
}
