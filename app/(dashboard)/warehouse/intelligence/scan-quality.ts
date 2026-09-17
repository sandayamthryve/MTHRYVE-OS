"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { loadQualitySignals } from "@/lib/quality/data";
import {
  evaluateBrand,
  evaluateProduct,
  buildBrandQualityDraft,
  buildProductQualityDraft,
} from "@/lib/quality/signal";

// The Returns/Quality loop's SIGNAL PRODUCER, behind the "Scan quality" button on
// the Product Intelligence page. One click runs the SHARED quality engine over
// every brand (live tiktok_shop_performance via lib/quality/data) and every SKU
// (product_metrics) for the
// trailing week, flags the ones whose returns / fulfillment errors / rating cross
// the tunable thresholds, and DRAFTS one action_request per flagged brand or SKU
// into the Action & Approval Queue for a human to approve.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then the
// OS EXECUTES — and the executor only ever opens an internal task. This producer
// pauses no ad, edits no listing and contacts no supplier. A healthy or
// low-volume brand/SKU is simply not drafted (honest — no false alarms).
//
// IDEMPOTENT — one quality draft per brand/SKU per ISO week. A brand or SKU that
// already has a quality request (pending / approved / executed) stamped with the
// same kind+brand+sku+iso_week is skipped, so re-scanning never stacks duplicates.
//
// RLS is the real guard: action_requests INSERT requires ceo/coo/department_head,
// so this action is gated to exactly that set, and every write stamps org_id from
// the caller's profile to pass the with_check.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface QualityScanResult {
  brandsScanned: number;
  productsScanned: number;
  flaggedBrands: number;
  flaggedProducts: number;
  created: number;
  skipped: number; // flagged but a draft already existed this week
}

// Same idempotency key the drafts carry in source_ref.
function refKey(kind: string, brandId: string | null, sku: string | null, isoWeek: string): string {
  return `${kind}:${brandId ?? ""}:${(sku ?? "").trim().toLowerCase()}:${isoWeek}`;
}

export async function scanQuality(): Promise<QualityScanResult> {
  // Leadership / department heads only — the set RLS lets draft and approve the
  // resulting L2 department_head requests.
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  const { brands, products, isoWeek } = await loadQualitySignals(db, profile.org_id);

  // Idempotency: keys of quality requests already raised this ISO week.
  const existingRes = await db
    .from("action_requests")
    .select("source_ref, status")
    .eq("source_module", "quality")
    .in("status", ["pending", "approved", "executed"]);
  const takenKeys = new Set<string>();
  for (const r of (existingRes.data ?? []) as Array<{
    source_ref: { kind?: string; brand_id?: string | null; sku?: string | null; iso_week?: string } | null;
  }>) {
    const sr = r.source_ref;
    if (!sr) continue;
    takenKeys.add(refKey(sr.kind ?? "brand", sr.brand_id ?? null, sr.sku ?? null, sr.iso_week ?? ""));
  }

  let flaggedBrands = 0;
  let flaggedProducts = 0;
  let created = 0;
  let skipped = 0;

  const insertDraft = async (
    draft: ReturnType<typeof buildBrandQualityDraft>,
    detail: Record<string, unknown>
  ): Promise<boolean> => {
    const { data: inserted, error } = await db
      .from("action_requests")
      .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
      .select("id")
      .single();
    if (error || !(inserted as { id?: string } | null)?.id) return false;
    await writeActionAudit(db, {
      org_id: profile.org_id,
      action_request_id: (inserted as { id: string }).id,
      event: "created",
      actor_id: null,
      actor_role: "system",
      detail: { source: "scan_quality", ...detail },
    });
    return true;
  };

  // ── Brand-level flags ──────────────────────────────────────────────────────────
  for (const f of brands) {
    const triggers = evaluateBrand(f);
    if (triggers.length === 0) continue;
    flaggedBrands += 1;

    const k = refKey("brand", f.brandId, null, isoWeek);
    if (takenKeys.has(k)) {
      skipped += 1;
      continue;
    }
    const ok = await insertDraft(buildBrandQualityDraft(f, triggers, isoWeek), {
      kind: "brand",
      brand_id: f.brandId,
      triggers,
      iso_week: isoWeek,
    });
    if (ok) {
      takenKeys.add(k);
      created += 1;
    }
  }

  // ── Product-level flags ──────────────────────────────────────────────────────────
  for (const f of products) {
    const triggers = evaluateProduct(f);
    if (triggers.length === 0) continue;
    flaggedProducts += 1;

    const k = refKey("product", f.brandId, f.sku, isoWeek);
    if (takenKeys.has(k)) {
      skipped += 1;
      continue;
    }
    const ok = await insertDraft(buildProductQualityDraft(f, triggers, isoWeek), {
      kind: "product",
      brand_id: f.brandId,
      sku: f.sku,
      triggers,
      iso_week: isoWeek,
    });
    if (ok) {
      takenKeys.add(k);
      created += 1;
    }
  }

  revalidatePath("/approvals");
  revalidatePath("/warehouse/intelligence");
  return {
    brandsScanned: brands.length,
    productsScanned: products.length,
    flaggedBrands,
    flaggedProducts,
    created,
    skipped,
  };
}
