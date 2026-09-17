"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { loadWarehouseIntelligence } from "@/lib/warehouse/data";
import { buildReplenishDraft, buildPushDraft } from "@/lib/warehouse/actions";
import { notifyStockoutRisk, notifyPendingApproval } from "@/lib/notifications/producers";
import { createServiceRoleClient } from "@/lib/supabase/service";

// The Intelligent Warehouse's SIGNAL PRODUCER, behind the "Scan warehouse"
// button on the Product Intelligence page. One click runs the SHARED velocity
// engine over every product (the same computation the view shows), routes each
// to exactly ONE action — REPLENISH or PUSH-TO-SELL, never both — and DRAFTS one
// action_request per routed product into the Action & Approval Queue for a human
// to approve.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then
// the OS EXECUTES. This action orders nothing, discounts nothing, seeds nothing —
// a product that isn't at risk is simply not drafted. Nothing external happens
// here or downstream; approval only ever opens an internal task.
//
// IDEMPOTENT — one open request per brand+sku. A product that already has an
// OPEN (pending/approved) warehouse request stamped with its brand_id+sku is
// skipped, so re-scanning never duplicates and a product never gets both a
// replenish and a push request open at once.
//
// RLS is the real guard: action_requests INSERT requires ceo/coo/department_head,
// so this action is gated to exactly that set, and every write stamps org_id from
// the caller's profile to pass the with_check.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface WarehouseScanResult {
  scanned: number; // products evaluated
  replenish: number; // products routed to replenish
  push: number; // products routed to push-to-sell
  created: number; // new action_requests drafted
  skipped: number; // routed products that already had an open request
}

// Same open-request key the data layer routes on: brand_id + case-folded sku.
function refKey(brandId: string | null, sku: string | null | undefined): string {
  return `${brandId ?? ""}::${(sku ?? "").trim().toLowerCase()}`;
}

export async function scanWarehouse(): Promise<WarehouseScanResult> {
  // Leadership / department heads only — the set RLS lets draft and approve the
  // resulting L2 department_head requests.
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  const { rows } = await loadWarehouseIntelligence(db, profile.org_id);

  // Idempotency: brand+sku keys that already carry an OPEN warehouse request.
  const openRes = await db
    .from("action_requests")
    .select("source_ref, status")
    .eq("source_module", "warehouse")
    .in("status", ["pending", "approved"]);
  const openKeys = new Set<string>();
  for (const r of (openRes.data ?? []) as Array<{
    source_ref: { brand_id?: string | null; sku?: string } | null;
  }>) {
    if (r.source_ref?.sku) openKeys.add(refKey(r.source_ref.brand_id ?? null, r.source_ref.sku));
  }

  // Draft urgent pushes first, then remaining pushes, then replenishments, so the
  // most time-critical risk lands at the top of a fresh queue. (The queue itself
  // re-sorts by risk tier then age; this only orders same-tier same-run inserts.)
  const routed = rows.filter((r) => r.route !== null);
  const ordered = [...routed].sort((a, b) => {
    const rank = (x: (typeof routed)[number]) =>
      x.route === "push" && (x.product.is_perishable || x.product.is_high_value) ? 0 : x.route === "push" ? 1 : 2;
    return rank(a) - rank(b);
  });

  let replenish = 0;
  let push = 0;
  let created = 0;
  let skipped = 0;

  for (const intel of ordered) {
    if (intel.route === "replenish") replenish += 1;
    else if (intel.route === "push") push += 1;

    const k = refKey(intel.product.brand_id, intel.product.sku);
    if (openKeys.has(k)) {
      skipped += 1;
      continue;
    }

    const draft =
      intel.route === "replenish"
        ? buildReplenishDraft(intel.product, intel.velocity, intel.brandName)
        : buildPushDraft(intel.product, intel.velocity, intel.aging, intel.brandName);

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
      detail: {
        source: "scan_warehouse",
        route: intel.route,
        brand_id: intel.product.brand_id,
        sku: intel.product.sku,
      },
    });

    // Notify the right people that this real risk was drafted for approval. A
    // replenish route IS a stockout risk; a push route is a plain pending
    // approval. Best-effort via the system client — org_id from the verified
    // profile — so a failed notification never affects the draft it announces.
    const svc = createServiceRoleClient() as unknown as Shim;
    const label = intel.brandName ? `${intel.brandName} · ${intel.product.sku}` : intel.product.sku ?? "product";
    if (intel.route === "replenish") {
      await notifyStockoutRisk(
        { orgId: profile.org_id, productLabel: label, actionRequestId: inserted.id },
        svc
      );
    } else {
      await notifyPendingApproval(
        {
          orgId: profile.org_id,
          title: `Push-to-sell drafted · ${label}`,
          body: "Aging stock — a push-to-sell action is drafted for your approval.",
          requiredRole: "department_head",
          actionRequestId: inserted.id,
          severity: "info",
        },
        svc
      );
    }

    openKeys.add(k); // guard against dupes within this same run
    created += 1;
  }

  revalidatePath("/approvals");
  revalidatePath("/warehouse/intelligence");
  return { scanned: rows.length, replenish, push, created, skipped };
}
