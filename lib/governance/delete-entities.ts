// lib/governance/delete-entities.ts — the whitelist of entities the governed
// permanent-delete gate (COO → CEO) is allowed to hard-delete, and the shared
// shapes for that flow. SERVER + CLIENT safe (pure data + types; no secrets, no
// db handles) so both the executor and the request/decision server actions read
// one source of truth.
//
// This is the generic-dispatch table the brief asks for: 'task' ships now;
// brands / finance / etc. are added here later with NO change to the executor or
// the approval surface. A proposed_action whose `entity` is not in this registry
// is refused BEFORE any delete — a request can never point the service-role
// delete at an arbitrary table.

// The machine-executable instruction carried on a governed-delete request. The
// executor runs it ONLY on the approved→executed transition, ONLY for
// type='hard_delete', and ONLY for a whitelisted `entity`.
export interface HardDeleteAction {
  type: "hard_delete";
  entity: string;
  id: string;
}

// One deletable entity: the Postgres table, a singular human label, and the
// column holding the row's human title (for the request card + notifications).
export interface GovernedDeleteEntity {
  table: string;
  label: string; // singular, e.g. "task"
  titleField: string; // column with the row's human name/title
  // Child rows to remove FIRST (FK order), before the parent. Omitted for a true
  // leaf — one whose every inbound FK is ON DELETE CASCADE / SET NULL, VERIFIED
  // against the live catalog (pg_constraint.confdeltype), not the migration text.
  // A NO ACTION / RESTRICT inbound FK BLOCKS the parent delete (23503), so its
  // child table MUST be listed here. The executor clears these in order, then the
  // parent — see delete-executor.ts.
  dependents?: DependentTable[];
  // Next.js paths to revalidate after the row is finally deleted, so every list
  // surface drops it.
  revalidate: string[];
}

// A dependent table cleared before its parent in a governed hard-delete. Supports
// NESTED chains: when this table is ITSELF blocked by a grandchild (a NO ACTION
// FK pointing at it), list that grandchild in `dependents` and the executor clears
// it first — resolving this table's ids for the parent, then recursing. Example:
// creator → anchors(creator_id) → live_sessions(anchor_id).
export interface DependentTable {
  table: string;
  column: string; // the FK column on THIS table pointing at the PARENT row's id
  // Grandchildren with a BLOCKING inbound FK to THIS table, cleared before it.
  // Omit when this table has zero blocking children (confdeltype-verified).
  dependents?: DependentTable[];
}

export const GOVERNED_DELETE_ENTITIES: Record<string, GovernedDeleteEntity> = {
  task: {
    table: "tasks",
    label: "task",
    titleField: "title",
    revalidate: ["/tasks"],
  },
  // A Growth Pod. pod_brands (the pod↔brand assignments) FK-reference the pod;
  // we remove them FIRST, then the pods row — org-scoped, in the executor. (The
  // FK is ON DELETE CASCADE today, so this is also robust to that being tightened
  // later; either way nothing is deleted until BOTH officers approve.)
  pod: {
    table: "pods",
    label: "pod",
    titleField: "name",
    dependents: [{ table: "pod_brands", column: "pod_id" }],
    revalidate: ["/pods", "/scoreboard"],
  },
  // NOTE — `brand` and `finance_entry` are DELIBERATELY ABSENT. They are
  // ARCHIVE-ONLY: a brand has 13 blocking (NO ACTION) inbound FKs across shops,
  // marketplace, TikTok performance, campaigns, contracts, expenses and
  // finance_entries; a finance_entry is referenced by payroll_runs. These are
  // financial-root records that must never be hard-deleted (only archived), so
  // they carry NO governed hard-delete surface at all. Removing them here also
  // makes requestGovernedDeletion refuse them (unknown entity), and the archive
  // config marks their clusters `archiveOnly` so no one-click delete reappears.
  // (See the delete-sweep note below on why "verified across migrations" was
  // wrong — the live catalog is the authority.)

  // ── The delete-sweep: every other RowActions cluster (all except tasks + pods,
  //    which shipped in #192).
  //
  //    LEAF vs. DEPENDENTS is decided against the LIVE catalog
  //    (pg_constraint.confdeltype), NOT the migration text. A foreign key written
  //    with no ON DELETE clause defaults to NO ACTION, which BLOCKS the parent
  //    delete (23503) — reading migrations alone misses this. Of the entities
  //    below, exactly two have blocking inbound FKs and therefore declare
  //    `dependents`: `anchor` (← live_sessions.anchor_id) and `creator`
  //    (← anchors.creator_id, which is itself blocked by live_sessions.anchor_id —
  //    a nested chain). Every other entity here was confirmed to have ZERO
  //    blocking inbound FK (its children are ON DELETE CASCADE / SET NULL, or it
  //    has none) and is a true LEAF.
  //
  //    Data-model caveat on `creators`, carried for a separate call: creator_posts,
  //    affiliate_deals and outreach_activities carry a creator_id with NO FK
  //    constraint, so a creator delete leaves them orphaned rather than cascading.
  //    Governing the delete (COO→CEO + audit + the anchors/live_sessions chain
  //    above) is still strictly safer than the one-click it replaced; sweeping
  //    those FK-less orphans is a separate data-model decision.

  campaign: { table: "campaigns", label: "campaign", titleField: "name", revalidate: ["/campaigns"] },
  client_contract: {
    table: "client_contracts",
    label: "contract",
    titleField: "client_name",
    revalidate: ["/contracts", "/clients"],
  },
  op_record: {
    table: "op_records",
    label: "record",
    titleField: "title",
    revalidate: ["/commerce-ops", "/affiliate", "/affiliate/fulfillment", "/live-ops"],
  },
  lead: { table: "leads", label: "lead", titleField: "name", revalidate: ["/outreach", "/leads"] },
  // products: warehouse_stock rows FK it ON DELETE CASCADE → leaf.
  product: {
    table: "products",
    label: "product",
    titleField: "product_name",
    revalidate: ["/warehouse/products", "/warehouse"],
  },
  // return_cases: rts monitoring rows FK it ON DELETE SET NULL → leaf.
  return_case: {
    table: "return_cases",
    label: "return / RTS record",
    titleField: "rts_number",
    revalidate: ["/warehouse/rts", "/warehouse"],
  },
  // cases: case events FK it ON DELETE CASCADE → leaf.
  case: { table: "cases", label: "case", titleField: "case_number", revalidate: ["/warehouse/cases"] },
  // projects: tasks.project_id FK it ON DELETE CASCADE → leaf (its tasks go with it).
  project: { table: "projects", label: "project", titleField: "name", revalidate: ["/tasks", "/projects"] },
  brand_initiative: {
    table: "brand_initiatives",
    label: "initiative",
    titleField: "name",
    revalidate: ["/brands", "/creative-studio"],
  },
  content_item: {
    table: "content_items",
    label: "content item",
    titleField: "title",
    revalidate: ["/creative-studio", "/content-calendar"],
  },
  // live_sessions: attachments + reports FK it ON DELETE CASCADE → leaf.
  live_session: {
    table: "live_sessions",
    label: "live session",
    titleField: "title",
    revalidate: ["/live-ops", "/live-ops/schedule", "/live-ops/reports", "/live-wall"],
  },
  video: { table: "videos", label: "video", titleField: "title", revalidate: ["/live-wall"] },
  // anchors ← live_sessions.anchor_id is NO ACTION (blocks) → clear live_sessions
  // for this anchor first. live_sessions has no blocking children of its own
  // (its attachments/reports cascade), so the chain ends there.
  anchor: {
    table: "anchors",
    label: "anchor",
    titleField: "name",
    dependents: [{ table: "live_sessions", column: "anchor_id" }],
    revalidate: ["/live", "/live-ops", "/live-ops/schedule", "/creative-studio"],
  },
  // creators ← anchors.creator_id is NO ACTION (blocks); anchors is in turn
  // blocked by live_sessions.anchor_id. Nested: clear each anchor's live_sessions,
  // then the anchors, then the creator. All org-scoped, inside the executor.
  creator: {
    table: "creators",
    label: "creator",
    titleField: "name",
    dependents: [
      {
        table: "anchors",
        column: "creator_id",
        dependents: [{ table: "live_sessions", column: "anchor_id" }],
      },
    ],
    revalidate: ["/creators", "/affiliate", "/affiliate/engage"],
  },
  affiliate_deal: {
    table: "affiliate_deals",
    label: "deal",
    titleField: "id",
    revalidate: ["/creators", "/affiliate"],
  },
  affiliate_content: {
    table: "affiliate_content",
    label: "content",
    titleField: "id",
    revalidate: ["/affiliate", "/affiliate/fulfillment"],
  },
  affiliate_sample: {
    table: "affiliate_samples",
    label: "sample",
    titleField: "id",
    revalidate: ["/affiliate", "/affiliate/fulfillment"],
  },
  outreach_message: {
    table: "outreach_messages",
    label: "message",
    titleField: "id",
    revalidate: ["/affiliate", "/affiliate/engage", "/outreach"],
  },
  // Finance — the scariest of the ungoverned deletes. No inbound FK → leaf.
  expense: {
    table: "expenses",
    label: "expense",
    titleField: "expense_code",
    revalidate: ["/finance/expenses", "/finance/expenses/records", "/finance/expenses/budgets", "/finance"],
  },
  budget: {
    table: "budgets",
    label: "budget",
    titleField: "scope",
    revalidate: ["/finance/expenses/budgets", "/finance/expenses"],
  },
  // NOTE: finance_entry is intentionally NOT here — archive-only (see the top note).
  // finance_entries ← payroll_runs.finance_entry_id is NO ACTION, and it is a
  // financial-root record; it must never be hard-deleted, only archived.
  // payroll_runs is a leaf (payroll_items.run_id cascades; confdeltype-verified).
  payroll_run: {
    table: "payroll_runs",
    label: "payroll run",
    titleField: "id",
    revalidate: ["/payroll", "/finance"],
  },
  // Recruitment. No inbound FK on either → leaf.
  vacancy: { table: "vacancies", label: "vacancy", titleField: "title", revalidate: ["/recruitment"] },
  candidate: { table: "candidates", label: "candidate", titleField: "name", revalidate: ["/recruitment"] },
  metric_entry: {
    table: "metric_entries",
    label: "metric entry",
    titleField: "metric_key",
    revalidate: ["/metrics"],
  },
  daily_report: {
    table: "daily_reports",
    label: "daily report",
    titleField: "work_date",
    revalidate: ["/daily-report"],
  },
  // documents: doc chunks FK it ON DELETE CASCADE → leaf (RAG chunks go with it).
  document: { table: "documents", label: "document", titleField: "title", revalidate: ["/knowledge"] },
};

export function governedDeleteEntity(entity: string | null | undefined): GovernedDeleteEntity | null {
  if (!entity) return null;
  return GOVERNED_DELETE_ENTITIES[entity] ?? null;
}

// A parsed, validated hard_delete instruction — or null when the action isn't a
// well-formed hard_delete for a whitelisted entity. The single choke-point both
// the executor and the reads use so nothing hand-rolls the shape.
export function parseHardDelete(action: unknown): HardDeleteAction | null {
  if (!action || typeof action !== "object") return null;
  const a = action as Record<string, unknown>;
  if (a.type !== "hard_delete") return null;
  const entity = typeof a.entity === "string" ? a.entity : "";
  const id = typeof a.id === "string" ? a.id : a.id != null ? String(a.id) : "";
  if (!entity || !id) return null;
  if (!GOVERNED_DELETE_ENTITIES[entity]) return null;
  return { type: "hard_delete", entity, id };
}

// The 2-stage sequential chain, in order. Stage 1 is the COO, stage 2 the CEO —
// strict, and the CEO can never act before the COO. Kept here so the request
// filer, the decision action and the UI all agree on the order + roles.
export const GOVERNED_DELETE_CHAIN = ["coo", "ceo"] as const;
export const GOVERNED_DELETE_CHAIN_STR = GOVERNED_DELETE_CHAIN.join(","); // 'coo,ceo'

// The governance source_module tag on action_requests for this gate.
export const GOVERNANCE_SOURCE_MODULE = "governance";

// The shape the request/decision server actions return to their client forms.
export interface GovActionState {
  ok: boolean;
  error?: string;
  message?: string;
  // Changes on every call so a client effect reacts even when ok/error repeat.
  nonce?: number;
}
