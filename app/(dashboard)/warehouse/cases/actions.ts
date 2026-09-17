"use server";

import { revalidatePath } from "next/cache";
import { requireProfile, requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  CASE_LEADERSHIP_ONLY,
  CASE_STATUS_LABEL,
  isCasePriority,
  isCaseStatus,
  type CaseStatus,
} from "@/lib/warehouse/rts";
import { safeUrl, sanitizeText } from "@/lib/security/sanitize";

// Server actions for Case Monitoring. Cases live in public.cases and their
// chronological remarks in public.case_updates. Assignment REUSES the existing
// public.tasks spine (a task is created for the assignee), and every status
// transition + assignment change is written to public.action_audit by the DB
// trigger on public.cases — the app never re-implements that audit.
//
// In-app notifications are written to public.events (the notifications feed).
// events INSERT is leadership-gated by RLS, so — like the Roll-Down producer —
// notifications are fanned out through the service-role client with org_id
// stamped from the caller's verified profile.
//
// The cases / case_updates / return_cases / events / tasks tables aren't all in
// the generated Database types, so they're reached through the shared cast shim.
type Shim = { from: (t: string) => any };
const ALL_ROLES = ["ceo", "coo", "department_head", "team_member"] as const;

function userDb(): Shim {
  return createServerSupabaseClient() as unknown as Shim;
}
function serviceDb(): Shim {
  return createServiceRoleClient() as unknown as Shim;
}
function s(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function revalidate(caseId?: string) {
  revalidatePath("/warehouse/cases");
  if (caseId) revalidatePath(`/warehouse/cases/${caseId}`);
  revalidatePath("/notifications");
  revalidatePath("/tasks");
}

// Best-effort notification into the events feed. Never breaks the action.
async function notify(
  orgId: string,
  actorId: string,
  title: string,
  body: string,
  severity: "info" | "warning" = "info"
): Promise<void> {
  try {
    await serviceDb().from("events").insert({
      org_id: orgId,
      created_by: actorId,
      scope: "org",
      kind: "alert",
      severity,
      title,
      body,
    });
  } catch {
    // A failed notification must never take down the case action it describes.
  }
}

// Next case number for an org: CASE-0001, CASE-0002, …
async function nextCaseNumber(db: Shim, orgId: string): Promise<string> {
  const { data } = await db
    .from("cases")
    .select("case_number")
    .eq("org_id", orgId)
    .not("case_number", "is", null)
    .order("case_number", { ascending: false })
    .limit(1);
  const rows = (data as { case_number: string | null }[] | null) ?? [];
  const m = /CASE-(\d+)/.exec(rows[0]?.case_number ?? "");
  const n = m ? Number(m[1]) + 1 : 1;
  return `CASE-${String(n).padStart(4, "0")}`;
}

// ── Auto case creation from an RTS record — one click, no re-encoding ─────────
// Inherits RTS Number, Brand, Product, SKU, Customer, Reason and Shipping
// Details straight from the return_cases row. Idempotent: if a case already
// exists for this RTS record, it's a no-op that returns the existing case.
export async function createCaseFromRts(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const rtsId = s(formData, "rts_id");
  if (!rtsId) return;
  const db = userDb();

  // Don't stack a second case on the same RTS record.
  const { data: existing } = await db
    .from("cases")
    .select("id")
    .eq("rts_id", rtsId)
    .eq("org_id", profile.org_id)
    .limit(1);
  if (Array.isArray(existing) && existing.length > 0) {
    revalidate();
    return;
  }

  const { data: rtsRow } = await db
    .from("return_cases")
    .select(
      "id, rts_number, brand_id, product_name, sku, customer_name, reason, courier, shipping_fee, order_number"
    )
    .eq("id", rtsId)
    .eq("org_id", profile.org_id)
    .maybeSingle();
  const rts = rtsRow as
    | {
        id: string;
        rts_number: string | null;
        brand_id: string | null;
        product_name: string | null;
        sku: string | null;
        customer_name: string | null;
        reason: string | null;
        courier: string | null;
        shipping_fee: number | null;
        order_number: string | null;
      }
    | null;
  if (!rts) return;

  const shippingBits = [
    rts.order_number ? `Order ${rts.order_number}` : null,
    rts.courier ? `Courier ${rts.courier}` : null,
    rts.shipping_fee != null ? `Shipping fee ₱${Number(rts.shipping_fee).toLocaleString()}` : null,
  ].filter(Boolean);

  const case_number = await nextCaseNumber(db, profile.org_id);
  await db.from("cases").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    case_number,
    rts_id: rts.id,
    brand_id: rts.brand_id,
    product: rts.product_name,
    sku: rts.sku,
    customer: rts.customer_name,
    reason: rts.reason,
    shipping_details: shippingBits.length ? shippingBits.join(" · ") : null,
    status: "new",
    priority: "medium",
  });

  revalidate();
}

// ── Manual case creation (a case not sourced from an RTS record) ──────────────
export async function createCaseManual(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const product = s(formData, "product");
  if (!product) return;
  const db = userDb();
  const case_number = await nextCaseNumber(db, profile.org_id);
  await db.from("cases").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    case_number,
    brand_id: s(formData, "brand_id") || null,
    product,
    sku: s(formData, "sku") || null,
    customer: s(formData, "customer") || null,
    reason: s(formData, "reason") || null,
    shipping_details: s(formData, "shipping_details") || null,
    priority: isCasePriority(s(formData, "priority")) ? s(formData, "priority") : "medium",
    status: "new",
  });
  revalidate();
}

// ── Assign a case → creates a task (reuse tasks), notifies, sets due + priority ┐
// Assignment history is recorded automatically: the DB trigger on cases writes a
// 'case.assigned' row to action_audit whenever assigned_to changes.
export async function assignCase(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const caseId = s(formData, "case_id");
  const assignee = s(formData, "assigned_to");
  if (!caseId || !assignee) return;
  const priority = isCasePriority(s(formData, "priority")) ? s(formData, "priority") : "medium";
  const dueDate = s(formData, "due_date") || null;
  const db = userDb();

  const { data: caseRow } = await db
    .from("cases")
    .select("id, case_number, product, brand_id, status")
    .eq("id", caseId)
    .eq("org_id", profile.org_id)
    .maybeSingle();
  const c = caseRow as
    | { id: string; case_number: string | null; product: string | null; brand_id: string | null; status: string }
    | null;
  if (!c) return;

  // Move the case to 'assigned' (unless it's already further along) and stamp
  // owner/priority/due — the DB trigger records the assignment in action_audit.
  const patch: Record<string, unknown> = { assigned_to: assignee, priority, due_date: dueDate };
  if (c.status === "new") patch.status = "assigned";
  await db.from("cases").update(patch).eq("id", caseId).eq("org_id", profile.org_id);

  // REUSE the tasks spine: create a task for the assignee so it surfaces in
  // their task center. org-open tasks_insert RLS lets the user client do this.
  await db.from("tasks").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    brand_id: c.brand_id,
    title: `Case ${c.case_number ?? ""}: ${c.product ?? "Investigate case"}`.trim(),
    description: `Assigned case ${c.case_number ?? caseId}. Track progress in Warehouse → Case Monitoring.`,
    assignee_id: assignee,
    priority, // task_priority shares the low/medium/high/urgent vocabulary
    due_date: dueDate,
    status: "todo",
  });

  // Notify the org feed + the assignee.
  await notify(
    profile.org_id,
    profile.id,
    `Case ${c.case_number ?? ""} assigned`,
    `Case "${c.product ?? c.case_number ?? caseId}" was assigned${dueDate ? `, due ${dueDate}` : ""}. See Warehouse → Case Monitoring or your Task Center.`
  );

  revalidate(caseId);
}

// ── Remarks & Progress Updates → chronological timeline (case_updates) ────────
export async function addCaseRemark(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const caseId = s(formData, "case_id");
  // Strip any markup/control chars from the free-text remark before storing it.
  const remarks = sanitizeText(s(formData, "remarks"));
  if (!caseId || !remarks) return;
  const db = userDb();

  // Only store an attachment link if it's a safe http(s) URL — a javascript:/
  // data: URL would otherwise be persisted and rendered as a clickable link.
  const attachmentUrl = safeUrl(s(formData, "attachment_url"));
  const attachments = attachmentUrl ? [{ url: attachmentUrl }] : null;

  await db.from("case_updates").insert({
    org_id: profile.org_id,
    case_id: caseId,
    user_id: profile.id,
    remarks,
    attachments,
  });

  // Bump the case so updated_at reflects the latest activity, then notify.
  const { data: caseRow } = await db
    .from("cases")
    .select("case_number, product")
    .eq("id", caseId)
    .eq("org_id", profile.org_id)
    .maybeSingle();
  const c = caseRow as { case_number: string | null; product: string | null } | null;
  await notify(
    profile.org_id,
    profile.id,
    `Case ${c?.case_number ?? ""} — remarks updated`,
    `${profile.full_name} added a progress update to "${c?.product ?? c?.case_number ?? caseId}".`
  );

  revalidate(caseId);
}

// ── Status workflow: New → … → Resolved → Closed ──────────────────────────────
// Resolved/Closed are leadership-only (enforced by the DB guard trigger too).
export async function updateCaseStatus(formData: FormData): Promise<void> {
  const statusInput = s(formData, "status");
  if (!isCaseStatus(statusInput)) return;

  // Match the DB guard: only leadership may resolve/close.
  const profile = CASE_LEADERSHIP_ONLY.has(statusInput as CaseStatus)
    ? await requireRole(["ceo", "coo", "department_head"])
    : await requireProfile();

  const caseId = s(formData, "case_id");
  if (!caseId) return;
  const db = userDb();

  const { data: updated } = await db
    .from("cases")
    .update({ status: statusInput })
    .eq("id", caseId)
    .eq("org_id", profile.org_id)
    .select("case_number, product, status")
    .maybeSingle();
  const c = updated as { case_number: string | null; product: string | null; status: string } | null;

  if (c) {
    await notify(
      profile.org_id,
      profile.id,
      `Case ${c.case_number ?? ""} → ${CASE_STATUS_LABEL[statusInput as CaseStatus]}`,
      `Status of "${c.product ?? c.case_number ?? caseId}" changed to ${CASE_STATUS_LABEL[statusInput as CaseStatus]}.`
    );
  }

  revalidate(caseId);
}
