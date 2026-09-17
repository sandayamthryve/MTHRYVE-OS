// lib/actions/executor.ts — the EXECUTOR. Runs ONLY after a human approval, and
// ONLY server-side with the service role, because executing a drafted action can
// touch rows the approver's own RLS grant can't (e.g. writing a project owned by
// a department head who isn't the approver). It is the single place the OS turns
// an approved action_request into a real change.
//
// Contract:
//   • never throws — every failure is caught, recorded as status='failed' + error
//     and an 'failed' audit row, and returned as { ok:false }.
//   • never performs external or irreversible actions — v1 only creates an
//     internal project (fully reversible), and refuses unknown action types.
//   • idempotent-friendly — it is called once, right after the atomic
//     pending→approved transition, so it can't double-fire for one request.

import { createServiceRoleClient } from "@/lib/supabase/service";
import { checkPolicy } from "@/lib/governance/policy";
import { todayManila } from "@/lib/metrics/windows";
import { peso } from "@/lib/metrics/format";
import { addDays, RESCHEDULE_DAYS } from "./follow-ups";
import { writeActionAudit } from "./audit";
import { sendEmail } from "@/lib/outreach/email";
import {
  isOutreachChannel,
  isAutoSendChannel,
  activityTypeForChannel,
  channelNotePrefix,
  CHANNEL_LABEL,
} from "@/lib/outreach/channels";
import type { ActionRequestRow } from "./types";
import { executeWindsorAction, isWindsorConfigured } from "@/lib/windsor/client";
import { isSupportedWrite } from "@/lib/windsor/actions";
import type { AdActionPayload } from "@/lib/ad-ops/types";
import {
  runGenerateScripts,
  runForecastRestock,
  runNextBestProduct,
  runMatchCreators,
  runAnalyzeContentPerformance,
  runCompileScoreboard,
} from "@/lib/vesper/executors";
import {
  isExpenseGate,
  nextExpenseStage,
  statusForStage,
} from "@/lib/finance/expense-workflow";
import { fileExpenseGateRequest } from "@/lib/finance/expense-requests";
import { runBudgetAlerts } from "@/lib/finance/expense-alerts";
import { writeExpenseAudit } from "@/lib/expenses/audit";

// A standards task is due this many days out — a weekly cadence, so the affiliate
// lead has room to act before the next Monday review.
const STANDARDS_TASK_DUE_DAYS = 2;

// Warehouse task due-out windows. Replenishment is a supply action with a short
// lead time (~3 days); a push-to-sell is more time-sensitive (~2 days), and an
// urgent push (near-expiry / high-value dead stock) shortens to ~1 day.
const REPLENISH_TASK_DUE_DAYS = 3;
const PUSH_TASK_DUE_DAYS = 2;
const PUSH_TASK_URGENT_DUE_DAYS = 1;

// A cash-flow action task is due ~2 days out — leadership needs to start working
// the plan (accelerate receivables / defer spend / arrange financing) well before
// the projected deficit date.
const CASHFLOW_TASK_DUE_DAYS = 2;

// A quality task is due ~2 days out — the ecom/ops owner should start
// investigating the return / rating spike promptly before it compounds.
const QUALITY_TASK_DUE_DAYS = 2;

// An opportunity qualification task is due ~2 days out — a HOT prospect should be
// researched and worked before the signal cools.
const OPPORTUNITY_TASK_DUE_DAYS = 2;

type Shim = { from: (t: string) => any };

export interface ExecResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

// create_recovery_project — mirrors the contract "deploy scope" path: a project
// in the item's department, owned by that department's head, brand carried over,
// active, due at the contract's period_end. Returns the new project id. The scope
// item is linked back to the recovery project only when it has no project yet, so
// an already-deployed item's existing link is never clobbered.
async function runCreateRecoveryProject(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const scopeItemId = (payload.scope_item_id as string | undefined) ?? null;
  const departmentId = (payload.department_id as string | undefined) ?? null;
  const brandId = (payload.brand_id as string | undefined) ?? null;
  const title =
    (payload.title as string | undefined)?.trim() || request.title || "Recovery project";
  const contractId = (request.source_ref?.contract_id as string | undefined) ?? null;

  // Due date = the contract's period end (the deadline the deliverable must hit).
  let dueDate: string | null = null;
  if (contractId) {
    const { data: contract } = await db
      .from("client_contracts")
      .select("period_end")
      .eq("id", contractId)
      .maybeSingle();
    dueDate = (contract as { period_end: string | null } | null)?.period_end ?? null;
  }

  // Owner = the department head (lead_user_id), same rule as one-click deploy.
  let ownerId: string | null = null;
  if (departmentId) {
    const { data: dept } = await db
      .from("departments")
      .select("lead_user_id")
      .eq("id", departmentId)
      .maybeSingle();
    ownerId = (dept as { lead_user_id: string | null } | null)?.lead_user_id ?? null;
  }

  const { data: project, error } = await db
    .from("projects")
    .insert({
      org_id: request.org_id,
      created_by: request.decided_by, // the approver, for traceability
      name: title,
      department_id: departmentId,
      brand_id: brandId,
      owner_id: ownerId,
      status: "active",
      due_date: dueDate,
      description: `Recovery project — created by the OS on approval of a delivery-risk action (${request.id}).`,
    })
    .select("id")
    .single();

  if (error || !(project as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not create the recovery project.");
  }
  const projectId = (project as { id: string }).id;

  // Link the scope item to the recovery project — only if it isn't already
  // linked, so we never overwrite an existing deployment.
  if (scopeItemId) {
    const { data: item } = await db
      .from("contract_scope_items")
      .select("project_id")
      .eq("id", scopeItemId)
      .maybeSingle();
    const alreadyLinked = (item as { project_id: string | null } | null)?.project_id ?? null;
    if (!alreadyLinked) {
      await db
        .from("contract_scope_items")
        .update({ project_id: projectId, status: "deployed", updated_at: new Date().toISOString() })
        .eq("id", scopeItemId);
    }
  }

  return { project_id: projectId };
}

// log_followup — the poly-source follow-up loop's executor. Records the approved
// follow-up as an outreach_activities row against its lead OR creator, stamps the
// target as contacted now, and reschedules the next touch a few days out. It
// SENDS NOTHING externally (v1: log + save only; SMTP is a later on-demand step)
// and touches only fully-reversible internal rows. The note stored is the FINAL,
// human-editable message carried on the request; the caller persists any edit
// into proposed_action.payload.drafted_message before we run.
async function runLogFollowup(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const leadId = (payload.lead_id as string | undefined) ?? null;
  const creatorId = (payload.creator_id as string | undefined) ?? null;
  const channel = payload.channel === "message" ? "message" : "email";
  const message = ((payload.drafted_message as string | undefined) ?? "").trim();

  if (!message) throw new Error("No follow-up message to log.");
  if (!leadId && !creatorId) throw new Error("Follow-up has no lead or creator target.");
  if (leadId && creatorId) throw new Error("Follow-up targets both a lead and a creator.");

  const now = new Date().toISOString();
  const nextActionDate = addDays(todayManila(), RESCHEDULE_DAYS);

  // Insert the activity (lead_id XOR creator_id), note = the final message.
  const activityRow: Record<string, unknown> = {
    org_id: request.org_id,
    created_by: request.decided_by, // the approver, for traceability
    activity_type: channel,
    note: message,
    occurred_at: now,
  };
  if (leadId) activityRow.lead_id = leadId;
  else activityRow.creator_id = creatorId;

  const { data: activity, error } = await db
    .from("outreach_activities")
    .insert(activityRow)
    .select("id")
    .single();
  if (error || !(activity as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not log the follow-up activity.");
  }
  const activityId = (activity as { id: string }).id;

  // Advance the target: contacted now, next touch rescheduled.
  if (leadId) {
    await db
      .from("leads")
      .update({ last_contacted_at: now, next_action_date: nextActionDate, updated_at: now })
      .eq("id", leadId);
  } else {
    await db
      .from("creators")
      .update({ last_contacted_at: now, next_action_date: nextActionDate, updated_at: now })
      .eq("id", creatorId!);
  }

  return { outreach_activity_id: activityId };
}

// create_standards_task — the affiliate performance-standard loop's executor. On
// approval it creates ONE internal task for the affiliate lead to act on a
// below-standard creator. It is fully reversible and touches nothing external:
// it never pauses the deal, never recovers product, never re-tiers — the human
// decides all of that; this only opens the task that puts the decision in front
// of them. Assignee = the affiliate department head, falling back to the
// creator's owner. Due ~2 days out (weekly cadence). The task is linked back to
// the source via the request's source_ref (creator_id/deal_id/iso_week) carried
// in the description, and the new task_id is returned into execution_result.
async function runCreateStandardsTask(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const creatorId = (payload.creator_id as string | undefined) ?? null;
  if (!creatorId) throw new Error("Standards task has no creator target.");
  const dealId = (payload.deal_id as string | undefined) ?? null;
  const tier = ((payload.tier as string | undefined) ?? "Untiered").trim() || "Untiered";
  const postRatePct = (payload.post_rate_pct as number | null | undefined) ?? null;
  const gmvGap = (payload.gmv_gap as number | null | undefined) ?? null;
  const suggested = ((payload.suggested_action as string | undefined) ?? "Nudge / follow-up").trim();
  const isoWeek = (request.source_ref?.iso_week as string | undefined) ?? null;
  const ownerId = (request.source_ref?.owner_id as string | undefined) ?? null;

  // Creator name + attributed GMV for the title (only the id is on the payload).
  const { data: creator } = await db
    .from("creators")
    .select("name, attributed_gmv, owner_id")
    .eq("id", creatorId)
    .maybeSingle();
  const c = creator as { name: string; attributed_gmv: number | null; owner_id: string | null } | null;
  const name = c?.name ?? "Creator";
  const actualGmv = c?.attributed_gmv != null ? Number(c.attributed_gmv) : null;

  // GMV floor for the title: reconstruct from actual + gap when there's a gap,
  // else read the tier's floor directly. Either may be unknown (cadence-only miss).
  let floorGmv: number | null =
    actualGmv != null && gmvGap != null && gmvGap > 0 ? actualGmv + gmvGap : null;
  if (floorGmv == null) {
    const { data: tierRow } = await db
      .from("creator_tiers")
      .select("min_gmv")
      .eq("tier", tier)
      .maybeSingle();
    const mg = (tierRow as { min_gmv: number | null } | null)?.min_gmv;
    floorGmv = mg != null ? Number(mg) : null;
  }

  // Assignee: the affiliate department head, else the creator's owner.
  const { data: depts } = await db.from("departments").select("id, name, lead_user_id");
  const affiliateDept = ((depts ?? []) as Array<{ name: string; lead_user_id: string | null }>).find(
    (d) => (d.name ?? "").toLowerCase().includes("affiliate")
  );
  const assigneeId = affiliateDept?.lead_user_id ?? ownerId ?? c?.owner_id ?? null;

  const rateLabel = postRatePct != null ? `${postRatePct}% posts` : "posting below bar";
  const gmvLabel =
    actualGmv != null && floorGmv != null
      ? `GMV ${peso(actualGmv)} vs ${peso(floorGmv)}`
      : actualGmv != null
        ? `GMV ${peso(actualGmv)}`
        : "GMV below floor";
  const title = `${tier} KOL ${name} below standard — ${rateLabel} / ${gmvLabel}; recommend ${suggested}`;

  const description =
    `Auto-opened by the OS on approval of an affiliate standards action (${request.id}).\n` +
    `Creator: ${name} (${creatorId})${dealId ? ` · deal ${dealId}` : ""}${isoWeek ? ` · ${isoWeek}` : ""}.\n` +
    `Recommended first step: ${suggested}. The human decides whether to pause the deal, ` +
    `recover product, or re-tier — nothing is done automatically.`;

  // status 'todo' is the task board's live/open state (the enum has no 'active');
  // due ~2 days out for the weekly cadence.
  const { data: task, error } = await db
    .from("tasks")
    .insert({
      org_id: request.org_id,
      created_by: request.decided_by, // the approver, for traceability
      title,
      description,
      assignee_id: assigneeId,
      priority: "high",
      status: "todo",
      due_date: addDays(todayManila(), STANDARDS_TASK_DUE_DAYS),
    })
    .select("id")
    .single();

  if (error || !(task as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not create the standards task.");
  }
  return { task_id: (task as { id: string }).id };
}

// Find the lead_user_id of the first department whose name contains any of the
// given keywords (case-insensitive). Used to route a warehouse task to the right
// owner; returns null when no matching department (or no lead) exists so the
// caller can fall back to the approver.
async function findDeptHead(db: Shim, keywords: string[]): Promise<string | null> {
  const { data: depts } = await db.from("departments").select("name, lead_user_id");
  const rows = (depts ?? []) as Array<{ name: string | null; lead_user_id: string | null }>;
  for (const kw of keywords) {
    const hit = rows.find(
      (d) => (d.name ?? "").toLowerCase().includes(kw) && d.lead_user_id
    );
    if (hit?.lead_user_id) return hit.lead_user_id;
  }
  return null;
}

// The brand name for a title, or null when the request carries no brand / it
// can't be resolved.
async function brandNameFor(db: Shim, brandId: string | null | undefined): Promise<string | null> {
  if (!brandId) return null;
  const { data } = await db.from("brands").select("name").eq("id", brandId).maybeSingle();
  return (data as { name: string | null } | null)?.name ?? null;
}

// create_replenishment_task — the warehouse replenish path's executor. On
// approval it opens ONE internal task for the Warehouse/Ops head to stock up a
// live seller running low. It orders nothing and touches nothing external — it
// only puts the re-stock decision (with a suggested quantity) in front of the
// owner. Assignee = the Warehouse/Ops department head, falling back to the
// approver. Due ~3 days out. Returns the new task_id into execution_result.
async function runCreateReplenishmentTask(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const brandId = (payload.brand_id as string | undefined) ?? null;
  const sku = (payload.sku as string | undefined) ?? null;
  const productName = ((payload.product_name as string | undefined) ?? "").trim() || sku || "product";
  const qtyRaw = payload.suggested_qty as number | null | undefined;
  const qty = qtyRaw != null && Number.isFinite(qtyRaw) ? Math.max(0, Math.round(qtyRaw)) : null;
  if (!sku) throw new Error("Replenishment task has no SKU.");

  const brand = await brandNameFor(db, brandId);
  const assigneeId =
    (await findDeptHead(db, ["warehouse", "ops", "operation", "supply", "logistic"])) ??
    request.decided_by ??
    null;

  const qtyLabel = qty != null && qty > 0 ? `~${qty} units` : "qty to set";
  const title = `Replenish ${productName} (${sku})${brand ? ` for ${brand}` : ""} — ${qtyLabel}`;
  const description =
    `Auto-opened by the OS on approval of a warehouse replenishment action (${request.id}).\n` +
    `SKU: ${sku}${brand ? ` · brand ${brand}` : ""}. Suggested quantity: ${
      qty != null ? qty : "—"
    } units (reach the target cover). ` +
    `The human confirms the final PO — nothing is ordered automatically.`;

  const { data: task, error } = await db
    .from("tasks")
    .insert({
      org_id: request.org_id,
      created_by: request.decided_by, // the approver, for traceability
      brand_id: brandId,
      title,
      description,
      assignee_id: assigneeId,
      priority: "high",
      status: "todo",
      due_date: addDays(todayManila(), REPLENISH_TASK_DUE_DAYS),
    })
    .select("id")
    .single();

  if (error || !(task as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not create the replenishment task.");
  }
  return { task_id: (task as { id: string }).id };
}

// create_push_task — the warehouse push-to-sell path's executor. On approval it
// opens ONE internal task for the Ecom/Brand owner to move dead / aging /
// near-expiry / high-value stagnant stock. It discounts nothing, lists nothing
// and seeds nothing — the human picks the tactic and executes. Assignee = the
// Ecom/Brand department head, falling back to the approver. Due ~2 days out, or
// ~1 day when the request is urgent. Returns the new task_id.
async function runCreatePushTask(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const brandId = (payload.brand_id as string | undefined) ?? null;
  const sku = (payload.sku as string | undefined) ?? null;
  const productName = ((payload.product_name as string | undefined) ?? "").trim() || sku || "product";
  const movementRaw = ((payload.movement as string | undefined) ?? "").trim();
  const movement =
    ({ fast: "Fast", healthy: "Healthy", slow: "Slow", nonmoving: "Non-moving" } as Record<string, string>)[
      movementRaw
    ] ?? (movementRaw || "stagnant");
  const tactic = ((payload.suggested_tactic as string | undefined) ?? "").trim() || "Creative push";
  const urgent = payload.urgent === true;
  if (!sku) throw new Error("Push task has no SKU.");

  const assigneeId =
    (await findDeptHead(db, ["ecom", "e-com", "commerce", "brand", "marketing", "sales"])) ??
    request.decided_by ??
    null;

  const title = `Push ${productName} (${sku}) — ${movement}; ${tactic}`;
  const description =
    `Auto-opened by the OS on approval of a warehouse push-to-sell action (${request.id}).\n` +
    `SKU: ${sku}${brandId ? ` · brand ${brandId}` : ""}. Movement: ${movement}. ` +
    `Recommended tactic: ${tactic}. The human picks the tactic (flash discount, feature in ` +
    `next live, creative push, bundle, or affiliate seeding) and executes — nothing is ` +
    `discounted, listed or seeded automatically.`;

  const { data: task, error } = await db
    .from("tasks")
    .insert({
      org_id: request.org_id,
      created_by: request.decided_by, // the approver, for traceability
      brand_id: brandId,
      title,
      description,
      assignee_id: assigneeId,
      priority: urgent ? "urgent" : "high",
      status: "todo",
      due_date: addDays(todayManila(), urgent ? PUSH_TASK_URGENT_DUE_DAYS : PUSH_TASK_DUE_DAYS),
    })
    .select("id")
    .single();

  if (error || !(task as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not create the push-to-sell task.");
  }
  return { task_id: (task as { id: string }).id };
}

// A short, friendly date ("Aug 12") for a task title; falls back to the raw
// YYYY-MM-DD when it can't be parsed.
const CF_SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function cashflowShortDate(dateStr: string | null | undefined): string {
  if (!dateStr || dateStr.length < 10) return dateStr || "the projected date";
  const m = Number(dateStr.slice(5, 7)) - 1;
  const d = Number(dateStr.slice(8, 10));
  return CF_SHORT_MONTHS[m] != null ? `${CF_SHORT_MONTHS[m]} ${d}` : dateStr;
}

// create_cashflow_task — the Cash-Flow Deficit loop's executor. On approval it
// opens ONE internal task for leadership (CEO/COO) to own the plan against a
// projected cash deficit. It NEVER executes a financial transaction — it moves,
// transfers and borrows nothing. It only puts the dated shortfall and a suggested
// first step in front of the people who decide. Assignee = a CEO, else a COO,
// else the approver. Due ~2 days out. Returns the new task_id into
// execution_result.
async function runCreateCashflowTask(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const deficitDate = (payload.deficit_date as string | undefined) ?? null;
  const shortfallRaw = payload.projected_shortfall as number | null | undefined;
  const shortfall = shortfallRaw != null && Number.isFinite(shortfallRaw) ? Math.max(0, Math.round(shortfallRaw)) : null;
  const suggested =
    ((payload.suggested_action as string | undefined) ?? "").trim() ||
    "Accelerate receivables and defer discretionary spend.";

  // Assignee: leadership only. Prefer a CEO, then a COO; fall back to the
  // approver so the task always has an owner.
  const { data: leaders } = await db
    .from("users")
    .select("id, role")
    .eq("org_id", request.org_id)
    .in("role", ["ceo", "coo"]);
  const leaderRows = (leaders ?? []) as Array<{ id: string; role: string }>;
  const assigneeId =
    leaderRows.find((u) => u.role === "ceo")?.id ??
    leaderRows.find((u) => u.role === "coo")?.id ??
    request.decided_by ??
    null;

  const shortfallLabel = shortfall != null ? `~${peso(shortfall)}` : "a projected shortfall";
  const whenLabel = cashflowShortDate(deficitDate);
  const title = `Cash-flow action — deficit ${shortfallLabel} projected ${whenLabel}; ${suggested}`;

  const asOf = (request.source_ref?.as_of_date as string | undefined) ?? null;
  const isoWeek = (request.source_ref?.iso_week as string | undefined) ?? null;
  const description =
    `Auto-opened by the OS on approval of a cash-flow deficit action (${request.id}).\n` +
    `Projected deficit${deficitDate ? ` on ${deficitDate}` : ""}${
      shortfall != null ? `, shortfall ~${peso(shortfall)}` : ""
    }${asOf ? ` · cash position as of ${asOf}` : ""}${isoWeek ? ` · ${isoWeek}` : ""}.\n` +
    `Suggested first step: ${suggested} Leadership decides the actual levers ` +
    `(accelerate receivables, defer discretionary spend, arrange financing, trim cost) — ` +
    `the OS moves, transfers and borrows NOTHING; it only opens this plan-owning task.`;

  const { data: task, error } = await db
    .from("tasks")
    .insert({
      org_id: request.org_id,
      created_by: request.decided_by, // the approver, for traceability
      title,
      description,
      assignee_id: assigneeId,
      priority: "high",
      status: "todo",
      due_date: addDays(todayManila(), CASHFLOW_TASK_DUE_DAYS),
    })
    .select("id")
    .single();

  if (error || !(task as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not create the cash-flow task.");
  }
  return { task_id: (task as { id: string }).id };
}

// create_quality_task — the Returns/Quality loop's executor. On approval it opens
// ONE internal task for the Ecom/Ops owner to work a brand- or SKU-level quality
// issue (high return rate, fulfillment errors, low rating, abnormal returns). It
// pauses no ad, edits no listing and contacts no supplier — it only puts the
// issue and a suggested first step in front of the owner who decides. Assignee =
// the Ecom/Ops department head, falling back to the approver. Due ~2 days out.
// Returns the new task_id into execution_result.
async function runCreateQualityTask(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const brandId = (payload.brand_id as string | undefined) ?? null;
  const sku = (payload.sku as string | undefined) ?? null;
  const issue = ((payload.issue as string | undefined) ?? "").trim() || "quality risk";
  const suggested =
    ((payload.suggested_action as string | undefined) ?? "").trim() ||
    "Investigate return reasons and run a supplier/QA review.";

  const brand = await brandNameFor(db, brandId);
  const assigneeId =
    (await findDeptHead(db, ["ecom", "e-com", "commerce", "ops", "operation", "brand", "marketing", "sales"])) ??
    request.decided_by ??
    null;

  // "{brand}{/sku}" scope label — brand, brand/sku, or just sku when brand-less.
  const scope = brand ? `${brand}${sku ? `/${sku}` : ""}` : sku ? sku : "brand";
  const title = `Quality issue — ${scope}: ${issue}; ${suggested}`;

  const isoWeek = (request.source_ref?.iso_week as string | undefined) ?? null;
  const kind = (request.source_ref?.kind as string | undefined) ?? (sku ? "product" : "brand");
  const description =
    `Auto-opened by the OS on approval of a returns/quality action (${request.id}).\n` +
    `Scope: ${kind === "product" ? "SKU" : "brand"} ${scope}${brandId ? ` · brand ${brandId}` : ""}${
      sku ? ` · sku ${sku}` : ""
    }${isoWeek ? ` · ${isoWeek}` : ""}.\n` +
    `Issue: ${issue}. Suggested first step: ${suggested} The human decides the levers ` +
    `(investigate return reasons, pause promotion/ads on the SKU, supplier/QA review, ` +
    `fix listing/expectations) — the OS pauses, edits and contacts NOTHING; it only ` +
    `opens this quality task.`;

  const { data: task, error } = await db
    .from("tasks")
    .insert({
      org_id: request.org_id,
      created_by: request.decided_by, // the approver, for traceability
      brand_id: brandId,
      title,
      description,
      assignee_id: assigneeId,
      priority: "high",
      status: "todo",
      due_date: addDays(todayManila(), QUALITY_TASK_DUE_DAYS),
    })
    .select("id")
    .single();

  if (error || !(task as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not create the quality task.");
  }
  return { task_id: (task as { id: string }).id };
}

// create_lead — the Opportunity Engine gateway's executor. On approval it inserts
// ONE internal `leads` row for review. It is fully reversible and reaches NOTHING
// external: no outreach, no email, no money — it only records the qualified
// opportunity as a lead the team can work. The lead is owned by the approver for
// traceability, born in the 'new' stage. tier/score have no dedicated columns on
// `leads`, so they're folded into the notes so nothing from the payload is lost.
// Returns the new lead_id into execution_result.
async function runCreateLead(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  // The gateway nests the lead under payload.lead; tolerate a top-level `lead`
  // too so a hand-authored request still works.
  const lead =
    ((payload.lead as Record<string, unknown> | undefined) ??
      ((request.proposed_action as unknown as { lead?: Record<string, unknown> })?.lead) ??
      {}) as Record<string, unknown>;

  const name = ((lead.name as string | undefined) ?? "").trim();
  if (!name) throw new Error("Lead has no name.");
  const source = ((lead.source as string | undefined) ?? "opportunity_engine").trim() || "opportunity_engine";
  const tier = lead.tier != null ? String(lead.tier).trim() : null;
  const scoreRaw = lead.score;
  const score =
    typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
      ? scoreRaw
      : scoreRaw != null && Number.isFinite(Number(scoreRaw))
        ? Number(scoreRaw)
        : null;
  const baseNotes = ((lead.notes as string | undefined) ?? "").trim();

  // Preserve tier/score (no columns for them) as a compact meta line in notes.
  const meta = [tier ? `Tier ${tier}` : null, score != null ? `Score ${score}` : null]
    .filter(Boolean)
    .join(" · ");
  const notes = [baseNotes || null, meta ? `[Opportunity Engine · ${meta}]` : null]
    .filter(Boolean)
    .join("\n\n") || null;

  const { data: created, error } = await db
    .from("leads")
    .insert({
      org_id: request.org_id,
      created_by: request.decided_by, // the approver, for traceability
      owner_id: request.decided_by,
      name,
      source,
      notes,
      stage: "new",
    })
    .select("id")
    .single();

  if (error || !(created as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not create the lead.");
  }
  return { lead_id: (created as { id: string }).id };
}

// create_opportunity_task — the Opportunity Engine loop's executor. On approval
// it opens ONE internal task for the BizDev team to research and qualify a HOT
// prospect the engine surfaced. It CONTACTS NO PROSPECT and touches nothing
// external — it only puts the qualification decision (with the engine's tier,
// score and reason) in front of the BizDev owner, who decides whether and how to
// reach out. Assignee = the BizDev/Sales department head, falling back to the
// approver. Due ~2 days out. Returns the new task_id into execution_result.
async function runCreateOpportunityTask(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const name = ((payload.candidate_name as string | undefined) ?? "").trim();
  if (!name) throw new Error("Opportunity task has no prospect name.");
  const category = ((payload.category as string | undefined) ?? "").trim() || null;
  const tier = ((payload.tier as string | undefined) ?? "HOT").trim() || "HOT";
  const scoreRaw = payload.score as number | null | undefined;
  const score = scoreRaw != null && Number.isFinite(scoreRaw) ? Math.round(scoreRaw) : null;
  const reason = ((payload.reason as string | undefined) ?? "").trim();
  const revenueRaw = payload.monthly_revenue as number | null | undefined;
  const revenue = revenueRaw != null && Number.isFinite(revenueRaw) ? Number(revenueRaw) : null;
  const signals = Array.isArray(payload.signals) ? (payload.signals as string[]) : [];

  const assigneeId =
    (await findDeptHead(db, [
      "business development",
      "bizdev",
      "biz dev",
      "business",
      "sales",
      "commercial",
      "partnership",
    ])) ??
    request.decided_by ??
    null;

  const scoreLabel = score != null ? ` (score ${score}/100)` : "";
  const title = `Qualify ${tier} prospect: ${name}${category ? ` — ${category}` : ""}${scoreLabel}`;

  const description =
    `Auto-opened by the OS on approval of an Opportunity Engine action (${request.id}).\n` +
    `Prospect: ${name}${category ? ` · ${category}` : ""}${
      revenue != null ? ` · ~${peso(revenue)}/mo` : ""
    }.\n` +
    `Engine verdict: ${tier}${score != null ? ` · ${score}/100` : ""}${
      reason ? ` — ${reason}` : ""
    }.\n` +
    (signals.length > 0 ? `Signals: ${signals.join(", ")}.\n` : "") +
    `Next step: research and qualify this prospect, then decide whether and how to reach out. ` +
    `The OS contacts NO prospect — it only opens this qualification task.`;

  const { data: task, error } = await db
    .from("tasks")
    .insert({
      org_id: request.org_id,
      created_by: request.decided_by, // the approver, for traceability
      title,
      description,
      assignee_id: assigneeId,
      priority: "high",
      status: "todo",
      due_date: addDays(todayManila(), OPPORTUNITY_TASK_DUE_DAYS),
    })
    .select("id")
    .single();

  if (error || !(task as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not create the opportunity task.");
  }
  return { task_id: (task as { id: string }).id };
}

// run_ad_action — Vesper's Ad Ops executor. Runs ONLY after a ceo/coo approval
// and it is the ONE place the OS moves ad spend: it applies the approved
// campaign change (pause / enable / set budget) on the platform via Windsor.ai's
// write API. It NEVER fakes success — a missing connector, an unsupported change,
// or ANY Windsor error throws, and the outer catch records status='failed' with
// the real message and a 'failed' audit row. On success it returns the change
// plus a before/after pair (the trail the executor writes into the 'executed'
// audit), so the audit shows exactly what moved.
async function runAdAction(request: ActionRequestRow): Promise<Record<string, unknown>> {
  const payload = (request.proposed_action?.payload ?? {}) as unknown as Partial<AdActionPayload>;
  const connector = payload.connector;
  const change = payload.change;
  const accountId = payload.accountId;
  const windsorAction = payload.windsorAction;
  const windsorParams = payload.windsorParams;

  // Defence-in-depth: refuse anything we can't safely execute end-to-end. These
  // fail BEFORE any platform call, so a malformed request never touches spend.
  if (!connector || !change || !accountId || !windsorAction || !windsorParams) {
    throw new Error("Ad action is missing the connector, account, change or resolved Windsor call.");
  }
  if (!isSupportedWrite(connector, change)) {
    throw new Error(`Unsupported ad action "${change}" for connector "${connector}".`);
  }
  // Honest "not configured" — surfaced as a failed execution, never a fake OK.
  if (!isWindsorConfigured()) {
    throw new Error("Ad connector not configured — WINDSOR_API_KEY is not set; no spend change was made.");
  }

  // Money-gate, from the Policy Registry: AI actions spend no money without
  // approval. This runs post-approval, so the seeded rule allows it; if
  // leadership tightens the ₱ threshold or deactivates auto-spend, this refuses
  // BEFORE any platform call — no code change needed.
  const spendGate = await checkPolicy("spend", {
    orgId: request.org_id,
    approved: request.status === "approved",
    amountPhp: payload.budget?.amount ?? null,
    actorId: request.decided_by,
    actionRequestId: request.id,
    detail: { connector, change, account_id: accountId },
  });
  if (spendGate.decision !== "allow") {
    throw new Error(`Policy "${spendGate.policyKey ?? "?"}" blocked spend: ${spendGate.reason}`);
  }

  // The "before" side of the audit: the performance snapshot captured at draft
  // time plus the known prior state. (Windsor's read fields don't expose a
  // campaign's current budget, so a set_budget's prior amount is recorded as
  // unknown rather than invented.)
  const snap = payload.snapshot;
  const before = {
    status: "active",
    budget: null as null | { amount: number; currency: string; kind: string },
    spend: snap?.spend ?? null,
    roas: snap?.roas ?? null,
    cpc: snap?.cpc ?? null,
    ctr: snap?.ctr ?? null,
    conversions: snap?.conversions ?? null,
    currency: snap?.currency ?? null,
  };

  // Apply the change on the platform. Throws (→ failed) on any Windsor error.
  const exec = await executeWindsorAction({
    connector,
    account: accountId,
    action: windsorAction,
    params: windsorParams,
  });

  // The "after" side: the state the approved change moves the campaign to.
  const after =
    change === "pause"
      ? { status: "paused" }
      : change === "enable"
        ? { status: "active" }
        : { status: "active", budget: payload.budget ?? null };

  return {
    kind: "ad_action",
    platform: payload.platform ?? null,
    connector,
    account_id: accountId,
    object_id: payload.objectId ?? null,
    object_name: payload.objectName ?? null,
    change,
    windsor_action: windsorAction,
    before,
    after,
    windsor_response: exec.response,
  };
}

// advance_expense_stage — the Expense Approval workflow's executor. Runs ONLY
// after a human approves a gate's request in the queue. It stamps the expense one
// stage forward and, when the NEXT stage is itself a gate, files the next pending
// action_request (so the chain flows finance → department → management with a
// separate human at each gate). At management_approval it advances to
// ready_for_payment and stamps approved_by/approved_at — the expense is now
// payable, but the OS moves NO money: payment is recorded by a human, outside the
// OS (see recordExpensePayment). Everything is a reversible internal write; it
// never touches an external system and never pays.
async function runAdvanceExpenseStage(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const expenseId = (payload.expense_id as string | undefined) ?? null;
  const fromStage = (payload.from_stage as string | undefined) ?? null;
  const toStage = (payload.to_stage as string | undefined) ?? null;
  if (!expenseId) throw new Error("Expense advance has no expense id.");
  if (!isExpenseGate(fromStage)) throw new Error(`"${fromStage}" is not an approval gate.`);
  const target = nextExpenseStage(fromStage);
  if (!target || (toStage && toStage !== target)) {
    throw new Error(`Expense gate ${fromStage} cannot advance to "${toStage}".`);
  }

  // Read the current expense (service role — the approver may not be able to read
  // the expenses table under RLS, but the executor can). All the fields the next
  // gate's card needs are fetched here so the downstream request stands alone.
  const { data: current } = await db
    .from("expenses")
    .select(
      "id, org_id, workflow_stage, status, reference_number, expense_code, gross_amount, vat_amount, " +
        "net_amount, type, allocation, transaction_date, payment_method, remarks, brand_id, department_id, " +
        "vendor_id, vendor_name_oneoff"
    )
    .eq("id", expenseId)
    .maybeSingle();
  const expense = current as
    | {
        id: string;
        org_id: string;
        workflow_stage: string | null;
        status: string | null;
        reference_number: string | null;
        expense_code: string | null;
        gross_amount: number | null;
        vat_amount: number | null;
        net_amount: number | null;
        type: string | null;
        allocation: string | null;
        transaction_date: string | null;
        payment_method: string | null;
        remarks: string | null;
        brand_id: string | null;
        department_id: string | null;
        vendor_id: string | null;
        vendor_name_oneoff: string | null;
      }
    | null;
  if (!expense) throw new Error("Expense not found.");
  // Guard against a double-advance: the expense must still be sitting at the gate
  // the request was filed for. If it already moved, this is a stale approval.
  if (expense.workflow_stage !== fromStage) {
    throw new Error(
      `Expense is at "${expense.workflow_stage ?? "—"}", not "${fromStage}" — it already advanced.`
    );
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    workflow_stage: target,
    status: statusForStage(target),
    updated_at: now,
  };
  // Reaching ready_for_payment IS the final approval — stamp who/when. This marks
  // the expense payable; it pays NOTHING.
  if (target === "ready_for_payment") {
    update.approved_by = request.decided_by;
    update.approved_at = now;
  }

  const { error: updErr } = await db.from("expenses").update(update).eq("id", expenseId);
  if (updErr) throw new Error(updErr.message || "Could not advance the expense.");

  // Immutable expense-audit row for the advance — this is the "approved" event on
  // the F3 audit trail (a human approved this gate in the queue, which ran here).
  // Best-effort; the advance already committed. Reaching ready_for_payment is the
  // final sign-off, so it reads as the approval that clears the expense.
  await writeExpenseAudit(db, {
    orgId: expense.org_id,
    event: "expense_approved",
    actorId: request.decided_by,
    actorRole: request.required_role ?? "system",
    expenseId: expense.id,
    expenseCode: expense.expense_code,
    changes: [{ field: "workflow_stage", from: fromStage, to: target }],
    note:
      target === "ready_for_payment"
        ? "Final sign-off — expense marked ready for payment (the OS moves no money)."
        : `Advanced to ${target.replace(/_/g, " ")} — next gate filed.`,
  });

  // If the new stage is itself a gate, file its request so the chain continues.
  let nextRequestId: string | null = null;
  if (isExpenseGate(target)) {
    nextRequestId = await fileExpenseGateRequest(db, {
      orgId: expense.org_id,
      createdBy: request.decided_by,
      expense: {
        id: expense.id,
        expense_code: expense.expense_code,
        transaction_date: expense.transaction_date,
        type: expense.type,
        allocation: expense.allocation,
        gross_amount: expense.gross_amount,
        vat_amount: expense.vat_amount,
        net_amount: expense.net_amount,
        reference_number: expense.reference_number,
        payment_method: expense.payment_method,
        remarks: expense.remarks,
        brand_id: expense.brand_id,
        department_id: expense.department_id,
        vendor_id: expense.vendor_id,
        vendor_name_oneoff: expense.vendor_name_oneoff,
      },
      gate: target,
    });
  }

  // Utilization only changes when spend is added, not on a stage move, but a
  // re-scan here is cheap and keeps the budget meter honest as expenses flow.
  await runBudgetAlerts(db, expense.org_id);

  return {
    kind: "advance_expense_stage",
    expense_id: expenseId,
    from: fromStage,
    to: target,
    next_request_id: nextRequestId,
    marked_payable: target === "ready_for_payment",
  };
}

// send_outreach — VESPER's gated-outreach executor (V2). Runs ONLY after a human
// approval. What it does depends entirely on the channel, and it is the single
// place the drafted message becomes real:
//
//   • email  — the ONLY auto-send channel. Sends via the configured provider
//              (SMTP or provider API). If email isn't configured it throws an
//              honest EmailNotConfiguredError — surfaced as a clear "email not
//              configured" failure, NEVER a faked send, and NOTHING is logged.
//              On a real send it logs the touch to outreach_activities and stamps
//              last_contacted_at + reschedules the next touch.
//   • viber / dm — copy-paste channels; the OS sends NOTHING (Viber ToS + no DM
//              API). Approving means the human sent it by hand, so we ONLY log
//              the touch (activity_type 'message', channel noted in the note) and
//              stamp last_contacted_at. The message text is unchanged.
//
// Like every executor here it touches only internal, reversible rows apart from
// the one email it is explicitly asked (and configured) to send.
async function runSendOutreach(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const leadId = (payload.lead_id as string | undefined) ?? null;
  const creatorId = (payload.creator_id as string | undefined) ?? null;
  const channelRaw = String(payload.channel ?? "");
  const message = ((payload.drafted_message as string | undefined) ?? "").trim();
  const subject = ((payload.subject as string | undefined) ?? "").trim();

  if (!isOutreachChannel(channelRaw)) throw new Error(`Unknown outreach channel "${channelRaw}".`);
  const channel = channelRaw;
  if (!message) throw new Error("No outreach message to send.");
  if (!leadId && !creatorId) throw new Error("Outreach has no lead or creator target.");
  if (leadId && creatorId) throw new Error("Outreach targets both a lead and a creator.");

  // Outbound-send gate, from the Policy Registry: outbound / consequential
  // actions require human approval. This runs post-approval so the seeded rule
  // allows it; deactivating the rule or tightening it in the Governance screen
  // changes this behaviour with no code change.
  const sendGate = await checkPolicy("outbound_send", {
    orgId: request.org_id,
    db,
    approved: request.status === "approved",
    actorId: request.decided_by,
    actionRequestId: request.id,
    detail: { channel: channelRaw, lead_id: leadId, creator_id: creatorId },
  });
  if (sendGate.decision !== "allow") {
    throw new Error(`Policy "${sendGate.policyKey ?? "?"}" blocked outbound send: ${sendGate.reason}`);
  }

  const now = new Date().toISOString();
  const nextActionDate = addDays(todayManila(), RESCHEDULE_DAYS);

  let sent = false;
  const sendMeta: Record<string, unknown> = {};

  // Only email is ever machine-sent, and only when configured.
  if (isAutoSendChannel(channel)) {
    // Resolve the recipient: the drafted payload, else the target's email on file.
    let recipient = ((payload.recipient as string | undefined) ?? "").trim();
    if (!recipient) {
      const table = leadId ? "leads" : "creators";
      const id = leadId ?? creatorId!;
      const { data: row } = await db.from(table).select("email").eq("id", id).maybeSingle();
      recipient = ((row as { email: string | null } | null)?.email ?? "").trim();
    }
    if (!recipient) {
      throw new Error("No email address on file for this contact — add one before sending.");
    }

    // sendEmail throws EmailNotConfiguredError when no transport is set up (an
    // honest not-configured failure), or a plain Error on a real send failure.
    // Either way we throw BEFORE logging, so a mail that didn't go out is never
    // recorded as sent.
    const result = await sendEmail({
      to: recipient,
      subject: subject || defaultEmailSubject(payload),
      text: message,
    });
    sent = true;
    sendMeta.transport = result.transport;
    sendMeta.message_id = result.messageId;
    sendMeta.recipient = recipient;
  }

  // Log the touch to outreach_activities (channel folded into activity_type +
  // note prefix, since the table has no channel column and we add no schema).
  const notePrefix = channelNotePrefix(channel);
  const noteBody =
    channel === "email" && subject ? `Subject: ${subject}\n\n${message}` : message;
  const activityRow: Record<string, unknown> = {
    org_id: request.org_id,
    created_by: request.decided_by, // the approver, for traceability
    activity_type: activityTypeForChannel(channel),
    note: `${notePrefix}${noteBody}`,
    occurred_at: now,
  };
  if (leadId) activityRow.lead_id = leadId;
  else activityRow.creator_id = creatorId;

  const { data: activity, error } = await db
    .from("outreach_activities")
    .insert(activityRow)
    .select("id")
    .single();
  if (error || !(activity as { id?: string } | null)?.id) {
    throw new Error(error?.message || "Could not log the outreach activity.");
  }
  const activityId = (activity as { id: string }).id;

  // Advance the target: contacted now, next touch rescheduled.
  if (leadId) {
    await db
      .from("leads")
      .update({ last_contacted_at: now, next_action_date: nextActionDate, updated_at: now })
      .eq("id", leadId);
  } else {
    await db
      .from("creators")
      .update({ last_contacted_at: now, next_action_date: nextActionDate, updated_at: now })
      .eq("id", creatorId!);
  }

  return {
    outreach_activity_id: activityId,
    channel,
    channel_label: CHANNEL_LABEL[channel],
    sent, // true only for a real email send; false for copy-paste channels
    ...sendMeta,
  };
}

// ── Care: confidential check-in (approval-gated, no external send) ─────────
// On approval, move the care_check_ins row from proposed → completed and
// stamp completion; the human check-in itself happens offline — this only
// records that it was approved to proceed.
async function runCareCheckIn(db: Shim, request: ActionRequestRow): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const userId = (payload.user_id as string | undefined) ?? null;
  const reason = ((payload.reason as string | undefined) ?? "").trim();
  if (!userId) throw new Error("Care check-in has no user target.");
  const now = new Date().toISOString();
  // Update the ledger row if it exists (best-effort — was written at propose time).
  try {
    await db
      .from("care_check_ins")
      .update({ status: "completed", updated_at: now })
      .eq("action_request_id", request.id);
  } catch {}
  // Fallback: if no ledger row was matched, create one so Care page has a record.
  try {
    const { data: existing } = await db.from("care_check_ins").select("id").eq("action_request_id", request.id).maybeSingle();
    if (!(existing as { id?: string } | null)?.id) {
      await db.from("care_check_ins").insert({
        org_id: request.org_id,
        user_id: userId,
        action_request_id: request.id,
        reason: reason || request.title || "Care check-in",
        status: "completed",
        created_by: request.decided_by,
      } as any);
    }
  } catch {}
  return { kind: "care_check_in", user_id: userId, reason: reason || request.title, completed_at: now };
}

async function runAtlasCapture(db: Shim, request: ActionRequestRow): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const title = ((payload.title as string | undefined) ?? "").trim() || request.title || "Atlas capture";
  // Recommendation-only — no table write beyond the audit that the executor does.
  return { kind: "atlas_capture", title, captured_at: new Date().toISOString() };
}

async function runOracleRecommendation(db: Shim, request: ActionRequestRow): Promise<Record<string, unknown>> {
  const payload = request.proposed_action?.payload ?? {};
  const title = ((payload.title as string | undefined) ?? "").trim() || request.title || "Oracle recommendation";
  return { kind: "oracle_recommendation", title, acknowledged_at: new Date().toISOString(), note: "Recommendation-only — no money moved." };
}

// A safe fallback email subject when the draft didn't carry one.
function defaultEmailSubject(payload: Record<string, unknown>): string {
  const brand = ((payload.brand as string | undefined) ?? "").trim();
  const kind = String(payload.kind ?? "outreach");
  if (kind === "reply") return brand ? `Re: your message — ${brand}` : "Re: your message";
  return brand ? `A quick note from ${brand}` : "Reaching out";
}

// Execute an already-approved request. The caller must have moved it to
// 'approved' first (the human gate); this only runs the machine step.
export async function executeApprovedAction(request: ActionRequestRow): Promise<ExecResult> {
  const db = createServiceRoleClient() as unknown as Shim;
  const type = request.proposed_action?.type;

  try {
    // Consult the centralized Policy Registry BEFORE acting. The request is
    // already human-approved (the caller moved it to 'approved'), so the
    // approval-gated policies pass — but leadership can tighten a rule in the
    // Governance screen to refuse a category of execution with no code change,
    // and this is where that refusal takes effect. The consult also records the
    // decision to action_audit.
    const gate = await checkPolicy("ai_execute", {
      orgId: request.org_id,
      db,
      approved: request.status === "approved",
      actorId: request.decided_by,
      actionRequestId: request.id,
      riskTier: request.risk_tier,
      confidence: request.confidence,
      detail: { action_type: type ?? null },
    });
    if (gate.decision !== "allow") {
      throw new Error(`Policy "${gate.policyKey ?? "?"}" blocked execution: ${gate.reason}`);
    }

    let result: Record<string, unknown>;
    switch (type) {
      case "create_recovery_project":
        result = await runCreateRecoveryProject(db, request);
        break;
      case "log_followup":
        result = await runLogFollowup(db, request);
        break;
      case "send_outreach":
        result = await runSendOutreach(db, request);
        break;
      case "create_standards_task":
        result = await runCreateStandardsTask(db, request);
        break;
      case "create_replenishment_task":
        result = await runCreateReplenishmentTask(db, request);
        break;
      case "create_push_task":
        result = await runCreatePushTask(db, request);
        break;
      case "create_cashflow_task":
        result = await runCreateCashflowTask(db, request);
        break;
      case "create_quality_task":
        result = await runCreateQualityTask(db, request);
        break;
      case "create_lead":
        result = await runCreateLead(db, request);
        break;
      case "create_opportunity_task":
        result = await runCreateOpportunityTask(db, request);
        break;
      case "ad_action":
        result = await runAdAction(request);
        break;
      case "advance_expense_stage":
        result = await runAdvanceExpenseStage(db, request);
        break;
      // ── Vesper (Operator agent) internal plays — same spine, same audit. All
      // are internal: reads + one reversible internal writer (generate_scripts).
      case "generate_scripts":
        result = await runGenerateScripts(db, request);
        break;
      case "forecast_restock":
        result = await runForecastRestock(db, request);
        break;
      case "next_best_product":
        result = await runNextBestProduct(db, request);
        break;
      case "match_creators":
        result = await runMatchCreators(db, request);
        break;
      case "analyze_content_performance":
        result = await runAnalyzeContentPerformance(db, request);
        break;
      case "compile_scoreboard":
        result = await runCompileScoreboard(db, request);
        break;
      case "care_check_in":
        result = await runCareCheckIn(db, request);
        break;
      case "atlas_capture":
        result = await runAtlasCapture(db, request);
        break;
      case "oracle_recommendation":
        result = await runOracleRecommendation(db, request);
        break;
      default:
        // Refuse anything we don't have a safe, internal executor for.
        throw new Error(`No executor for action type "${type ?? "(none)"}".`);
    }

    const executedAt = new Date().toISOString();
    await db
      .from("action_requests")
      .update({
        status: "executed",
        executed_at: executedAt,
        execution_result: result,
        error: null,
        updated_at: executedAt,
      })
      .eq("id", request.id);

    await writeActionAudit(db, {
      org_id: request.org_id,
      action_request_id: request.id,
      event: "executed",
      actor_id: null,
      actor_role: "system",
      detail: { decided_by: request.decided_by, result },
    });

    return { ok: true, result };
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const ts = new Date().toISOString();
    try {
      await db
        .from("action_requests")
        .update({ status: "failed", error: message, updated_at: ts })
        .eq("id", request.id);
      await writeActionAudit(db, {
        org_id: request.org_id,
        action_request_id: request.id,
        event: "failed",
        actor_id: null,
        actor_role: "system",
        detail: { decided_by: request.decided_by, error: message },
      });
    } catch {
      // Even failure-recording is best effort — never throw out of the executor.
    }
    return { ok: false, error: message };
  }
}
