"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { fmtDate, isDateStr, isRtsStatus, RTS_REASON_SET } from "@/lib/warehouse/rts";

// Server actions for the RTS (Return to Seller) module. RTS records REUSE the
// existing public.return_cases table — an RTS record is a return_cases row with
// the rts_* columns populated. Nothing is duplicated. Shipping fees are RECORDED
// on the row (shipping_fee) and only summed for analytics; money is never moved.
//
// return_cases isn't in the generated Supabase types, so writes go through the
// same cast shim the Returns tracker, Finance and Warehouse Intelligence use.
type Shim = { from: (t: string) => any };

function s(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}
function numOrNull(v: string): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[₱,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Generate the next RTS number for an org: RTS-0001, RTS-0002, … Derived from
// the highest existing number so it stays human-readable. Best-effort — a rare
// concurrent double-submit could repeat a number, which is cosmetic only (the
// row is keyed by id, not rts_number).
async function nextRtsNumber(db: Shim, orgId: string): Promise<string> {
  const { data } = await db
    .from("return_cases")
    .select("rts_number")
    .eq("org_id", orgId)
    .not("rts_number", "is", null)
    .order("rts_number", { ascending: false })
    .limit(1);
  const rows = (data as { rts_number: string | null }[] | null) ?? [];
  const m = /RTS-(\d+)/.exec(rows[0]?.rts_number ?? "");
  const n = m ? Number(m[1]) + 1 : 1;
  return `RTS-${String(n).padStart(4, "0")}`;
}

// Any authenticated user (Warehouse team) can log an RTS record.
export async function saveRtsRecord(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const db = createServerSupabaseClient() as unknown as Shim;

  const rtsNumberInput = s(formData, "rts_number");
  const rts_number = rtsNumberInput || (await nextRtsNumber(db, profile.org_id));

  const reason = s(formData, "reason");
  const rtsStatusInput = s(formData, "rts_status");
  const reportedRaw = s(formData, "reported_date");
  const receivedRaw = s(formData, "date_received");

  await db.from("return_cases").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    // RTS identity
    rts_number,
    order_number: s(formData, "order_number") || null,
    order_ref: s(formData, "order_number") || null, // keep the legacy field aligned
    customer_name: s(formData, "customer_name") || null,
    brand_id: s(formData, "brand_id") || null,
    product_name: s(formData, "product_name") || null,
    sku: s(formData, "sku") || null,
    units: Math.max(1, Math.round(Number(s(formData, "units")) || 1)),
    reason: RTS_REASON_SET.has(reason) ? reason : "rts_undelivered",
    // RTS logistics
    warehouse_staff_id: s(formData, "warehouse_staff_id") || null,
    courier: s(formData, "courier") || null,
    shipping_fee: numOrNull(s(formData, "shipping_fee")) ?? 0,
    date_received: isDateStr(receivedRaw) ? receivedRaw : null,
    reported_date: isDateStr(reportedRaw) ? reportedRaw : fmtDate(new Date()),
    rts_status: isRtsStatus(rtsStatusInput) ? rtsStatusInput : "pending_verification",
    // The legacy return-case status is left at its default; the RTS workflow
    // lives entirely in rts_status.
    note: s(formData, "note") || null,
  });

  revalidatePath("/warehouse/rts");
  revalidatePath("/warehouse/cases");
}

// Advance / edit an RTS record. The status workflow is enforced by the form,
// which only ever offers the current status, the single next forward status, or
// Cancelled — so a record can't skip stages. Reaching Completed/Cancelled stamps
// resolved_date once for honest lead-time reporting.
export async function updateRtsRecord(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const id = s(formData, "id");
  if (!id) return;
  const db = createServerSupabaseClient() as unknown as Shim;

  const statusInput = s(formData, "rts_status");
  const rts_status = isRtsStatus(statusInput) ? statusInput : "pending_verification";

  const patch: Record<string, unknown> = {
    rts_status,
    courier: s(formData, "courier") || null,
    warehouse_staff_id: s(formData, "warehouse_staff_id") || null,
  };
  const fee = numOrNull(s(formData, "shipping_fee"));
  if (fee !== null) patch.shipping_fee = fee;

  if (rts_status === "completed" || rts_status === "cancelled") {
    const { data: existing } = await db
      .from("return_cases")
      .select("resolved_date")
      .eq("id", id)
      .eq("org_id", profile.org_id)
      .maybeSingle();
    const resolved = (existing as { resolved_date: string | null } | null)?.resolved_date;
    if (!resolved) patch.resolved_date = fmtDate(new Date());
  }

  await db.from("return_cases").update(patch).eq("id", id).eq("org_id", profile.org_id);
  revalidatePath("/warehouse/rts");
  revalidatePath("/warehouse/cases");
}
