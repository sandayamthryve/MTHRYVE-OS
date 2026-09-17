"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDeliverableType } from "@/lib/metrics/contracts";
import { loadContractsData, buildScopeAttainment } from "@/lib/contracts/data";
import { isAtRisk, buildDeliveryRiskDraft, SCANNED_TYPES } from "@/lib/actions/delivery-risk";
import { writeActionAudit } from "@/lib/actions/audit";
import { todayManila } from "@/lib/metrics/windows";

// Server actions for Reports-vs-Contract v2. Every write sets org_id from the
// caller's profile so it satisfies the with_check (org_id = current_org_id())
// on each table, and role gating mirrors the RLS policies exactly — the page
// only offers a control the policy would accept, and RLS remains the real guard:
//   client_contracts     — ceo / coo / department_head write
//   contract_financials  — ceo / coo write only
//   contract_scope_items — ceo / coo (any) or department_head (own department)
//
// The contract tables aren't in the generated Database types yet, so they're
// reached through the same cast shim the Live module uses. Blank optional
// numbers are stored as null (unknown), never a fabricated zero.

const CONTRACT_ROLES = ["ceo", "coo", "department_head"] as const;
const FINANCIALS_ROLES = ["ceo", "coo"] as const;

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; department_id: string | null; role: string };

function shim() {
  return createServerSupabaseClient() as unknown as Shim;
}

// Blank → null (unknown); integers truncated. Never coerces a blank to 0.
function optNum(formData: FormData, key: string, integer = false): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return integer ? Math.trunc(n) : n;
}

function optText(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v || null;
}

// Parse the deliverables textarea (one "label" or "label: detail" per line) into
// a jsonb array, or null when empty — so an untouched field never writes [].
function parseDeliverables(formData: FormData): unknown {
  const raw = String(formData.get("deliverables") ?? "").trim();
  if (!raw) return null;
  const items = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx < 0) return { label: line };
      return { label: line.slice(0, idx).trim(), detail: line.slice(idx + 1).trim() };
    });
  return items.length ? items : null;
}

// ── Contract header + delivery commitments ────────────────────────────────────

export async function createContract(formData: FormData) {
  const profile = (await requireRole([...CONTRACT_ROLES])) as unknown as Profile;
  const clientName = optText(formData, "client_name");
  if (!clientName) return;
  await shim()
    .from("client_contracts")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      client_name: clientName,
      brand_id: optText(formData, "brand_id"),
      period_start: optText(formData, "period_start"),
      period_end: optText(formData, "period_end"),
      monthly_gmv_target: optNum(formData, "monthly_gmv_target"),
      monthly_content_target: optNum(formData, "monthly_content_target", true),
      deliverables: parseDeliverables(formData),
      status: optText(formData, "status") ?? "active",
      notes: optText(formData, "notes"),
    });
  revalidatePath("/contracts");
}

export async function updateContract(formData: FormData) {
  await requireRole([...CONTRACT_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await shim()
    .from("client_contracts")
    .update({
      client_name: optText(formData, "client_name"),
      brand_id: optText(formData, "brand_id"),
      period_start: optText(formData, "period_start"),
      period_end: optText(formData, "period_end"),
      monthly_gmv_target: optNum(formData, "monthly_gmv_target"),
      monthly_content_target: optNum(formData, "monthly_content_target", true),
      deliverables: parseDeliverables(formData),
      status: optText(formData, "status") ?? "active",
      notes: optText(formData, "notes"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/contracts");
  revalidatePath(`/contracts/${id}`);
}

// ── Financials (ceo / coo only) ───────────────────────────────────────────────
// Upsert-by-contract: one financials row per contract. We look for an existing
// row (RLS returns it only if the caller may read it) and update, else insert.

export async function saveFinancials(formData: FormData) {
  const profile = (await requireRole([...FINANCIALS_ROLES])) as unknown as Profile;
  const contractId = String(formData.get("contract_id") ?? "");
  if (!contractId) return;
  const patch = {
    monthly_fee: optNum(formData, "monthly_fee"),
    monthly_ad_budget: optNum(formData, "monthly_ad_budget"),
    gross_margin_pct: optNum(formData, "gross_margin_pct"),
    notes: optText(formData, "notes"),
  };
  const db = shim();
  const { data: existing } = await db
    .from("contract_financials")
    .select("id")
    .eq("contract_id", contractId)
    .maybeSingle();
  if (existing?.id) {
    await db
      .from("contract_financials")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } else {
    await db.from("contract_financials").insert({
      org_id: profile.org_id,
      contract_id: contractId,
      created_by: profile.id,
      ...patch,
    });
  }
  revalidatePath(`/contracts/${contractId}`);
  revalidatePath("/contracts");
}

// ── Scope of work items ───────────────────────────────────────────────────────

export async function createScopeItem(formData: FormData) {
  const profile = (await requireRole([...CONTRACT_ROLES])) as unknown as Profile;
  const contractId = String(formData.get("contract_id") ?? "");
  const title = optText(formData, "title");
  if (!contractId || !title) return;
  const rawType = String(formData.get("deliverable_type") ?? "other");
  await shim()
    .from("contract_scope_items")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      contract_id: contractId,
      department_id: optText(formData, "department_id"),
      brand_id: optText(formData, "brand_id"),
      title,
      deliverable_type: isDeliverableType(rawType) ? rawType : "other",
      target_value: optNum(formData, "target_value"),
      target_unit: optText(formData, "target_unit"),
      status: optText(formData, "status") ?? "planned",
      notes: optText(formData, "notes"),
    });
  revalidatePath(`/contracts/${contractId}`);
  revalidatePath("/contracts");
}

export async function updateScopeItem(formData: FormData) {
  await requireRole([...CONTRACT_ROLES]);
  const id = String(formData.get("id") ?? "");
  const contractId = String(formData.get("contract_id") ?? "");
  if (!id) return;
  const rawType = String(formData.get("deliverable_type") ?? "other");
  await shim()
    .from("contract_scope_items")
    .update({
      department_id: optText(formData, "department_id"),
      brand_id: optText(formData, "brand_id"),
      title: optText(formData, "title"),
      deliverable_type: isDeliverableType(rawType) ? rawType : "other",
      target_value: optNum(formData, "target_value"),
      target_unit: optText(formData, "target_unit"),
      status: optText(formData, "status") ?? "planned",
      notes: optText(formData, "notes"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (contractId) {
    revalidatePath(`/contracts/${contractId}`);
    revalidatePath("/contracts");
  }
}

export async function deleteScopeItem(formData: FormData) {
  await requireRole([...CONTRACT_ROLES]);
  const id = String(formData.get("id") ?? "");
  const contractId = String(formData.get("contract_id") ?? "");
  if (!id) return;
  await shim().from("contract_scope_items").delete().eq("id", id);
  if (contractId) {
    revalidatePath(`/contracts/${contractId}`);
    revalidatePath("/contracts");
  }
}

// ── One-click deploy: scope items → department projects ────────────────────────
// For each scope item on the contract that has NO linked project, create a
// public.projects row (name = item title, department + brand from the item,
// owner = that department's head, status active, due = contract period_end),
// then stamp the item with project_id and status='deployed'. Idempotent: items
// already linked are skipped. A department_head can only deploy their own
// department's items (RLS blocks the scope-item update otherwise), so we filter
// to that set up front to avoid creating orphan projects.

export async function deployScope(formData: FormData) {
  const profile = (await requireRole([...CONTRACT_ROLES])) as unknown as Profile;
  const contractId = String(formData.get("contract_id") ?? "");
  if (!contractId) redirect("/contracts");
  const db = shim();

  const [{ data: contract }, { data: items }, { data: depts }] = await Promise.all([
    db.from("client_contracts").select("period_end").eq("id", contractId).maybeSingle(),
    db
      .from("contract_scope_items")
      .select("id, department_id, brand_id, title, project_id")
      .eq("contract_id", contractId),
    db.from("departments").select("id, lead_user_id"),
  ]);

  const leadByDept = new Map<string, string | null>(
    ((depts ?? []) as Array<{ id: string; lead_user_id: string | null }>).map((d) => [
      d.id,
      d.lead_user_id,
    ])
  );
  const dueDate = (contract as { period_end: string | null } | null)?.period_end ?? null;

  const isDeptHead = profile.role === "department_head";
  const pending = ((items ?? []) as Array<{
    id: string;
    department_id: string | null;
    brand_id: string | null;
    title: string;
    project_id: string | null;
  }>).filter((it) => {
    if (it.project_id) return false; // already deployed — idempotent skip
    if (isDeptHead && it.department_id !== profile.department_id) return false;
    return true;
  });

  let created = 0;
  for (const it of pending) {
    const { data: project, error } = await db
      .from("projects")
      .insert({
        org_id: profile.org_id,
        created_by: profile.id,
        name: it.title,
        department_id: it.department_id,
        brand_id: it.brand_id,
        owner_id: it.department_id ? leadByDept.get(it.department_id) ?? null : null,
        status: "active",
        due_date: dueDate,
        description: "Deployed from client contract scope of work.",
      })
      .select("id")
      .single();
    if (error || !project?.id) continue;
    const { error: linkErr } = await db
      .from("contract_scope_items")
      .update({ project_id: project.id, status: "deployed", updated_at: new Date().toISOString() })
      .eq("id", it.id);
    // If the link update was blocked (shouldn't happen given the filter), roll
    // back the just-created project so a re-run stays idempotent.
    if (linkErr) {
      await db.from("projects").delete().eq("id", project.id);
      continue;
    }
    created += 1;
  }

  const skipped = ((items ?? []) as Array<{ project_id: string | null }>).filter(
    (it) => it.project_id
  ).length;

  revalidatePath(`/contracts/${contractId}`);
  revalidatePath("/contracts");
  revalidatePath("/projects");
  redirect(`/contracts/${contractId}?deployed=${created}&skipped=${skipped}`);
}

// ── Signal producer: "Scan delivery risk" (the first proactive loop) ──────────
// Leadership-triggered. Reads the SAME attainment the board shows and, for every
// active contract's measurable scope item that is genuinely pacing to miss its
// target, DRAFTS one action_request (Tony's reasoning) into the queue for a human
// to approve. It never executes and never fabricates:
//   • only gmv/content/live items are scanned (ads = budget, other = manual);
//   • an item is flagged only when isAtRisk() is true (real target + real data,
//     < 70% attained while > 60% of the window has elapsed);
//   • idempotent — an item with an already-open (pending/approved) request is
//     skipped, so re-scanning never duplicates a signal.
// A system 'created' audit row is written for each new draft (actor = system).

export interface ScanResult {
  scanned: number; // measurable scope items evaluated
  atRisk: number; // items found at risk this scan
  created: number; // new action_requests drafted
  skipped: number; // at-risk items that already had an open request
}

export async function scanDeliveryRisk(): Promise<ScanResult> {
  // Leadership only — same set that may approve the resulting L3 requests.
  const profile = (await requireRole(["ceo", "coo"])) as unknown as Profile;
  const supabase = createServerSupabaseClient();
  const db = shim();

  const data = await loadContractsData(supabase);
  const today = todayManila();

  // Active contracts only; index by id for message context.
  const activeContracts = data.contracts.filter((c) => c.status === "active");
  const contractById = new Map(activeContracts.map((c) => [c.id, c]));
  const brandName = (id: string | null) => data.brands.find((b) => b.id === id)?.name ?? null;

  // Measurable scope items belonging to an active contract.
  const measurable = data.scopeItems.filter(
    (it) =>
      contractById.has(it.contract_id) &&
      (SCANNED_TYPES as readonly string[]).includes(it.deliverable_type)
  );

  const attainment = buildScopeAttainment(data, measurable, today);
  const atRisk = attainment.filter(isAtRisk);

  // One query for idempotency: which scope items already have an OPEN request?
  const { data: openRows } = await db
    .from("action_requests")
    .select("source_ref, status")
    .eq("source_module", "reports_vs_contract")
    .in("status", ["pending", "approved"]);
  const openScopeIds = new Set<string>();
  for (const r of (openRows ?? []) as Array<{ source_ref: { scope_item_id?: string } | null }>) {
    const sid = r.source_ref?.scope_item_id;
    if (sid) openScopeIds.add(sid);
  }

  let created = 0;
  let skipped = 0;

  for (const sa of atRisk) {
    if (openScopeIds.has(sa.item.id)) {
      skipped += 1;
      continue;
    }
    const contract = contractById.get(sa.item.contract_id);
    if (!contract) continue;
    const draft = buildDeliveryRiskDraft(sa, contract, brandName(sa.item.brand_id), today);

    const { data: inserted, error } = await db
      .from("action_requests")
      .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
      .select("id")
      .single();
    if (error || !inserted?.id) continue;

    await writeActionAudit(db, {
      org_id: profile.org_id,
      action_request_id: inserted.id,
      event: "created",
      actor_id: null,
      actor_role: "system",
      detail: { source: "scan_delivery_risk", scope_item_id: sa.item.id },
    });
    openScopeIds.add(sa.item.id); // guard against dupes within this same run
    created += 1;
  }

  revalidatePath("/approvals");
  revalidatePath("/contracts");
  return { scanned: measurable.length, atRisk: atRisk.length, created, skipped };
}
