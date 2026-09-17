import { createServiceRoleClient } from "@/lib/supabase/service";
import { getFalModel, estimateFalCostUsd } from "@/lib/fal/models";
import { ASSET_REMOVED_STATUS } from "@/lib/content/assets";
import type { FalVideoResult } from "@/lib/fal/client";

// Completion writer for fal video generations — the ONE place a finished (or
// failed) clip is recorded. Both the webhook receiver and the status poll route
// funnel here so the two paths write identically and idempotently.
//
// Unlike HeyGen there is NO separate ledger table: content_assets IS the ledger
// (we inserted the row as status='processing' at submit time, tagged with
// meta.fal_request_id). So completion is an in-place UPDATE of that same row —
// no schema / RLS changes, as required.
//
// Writes go through the SERVICE-ROLE client on purpose: the webhook arrives with
// NO user session (RLS's current_org_id() would be null). Service-role bypasses
// RLS; we still scope every write by the row's own id so it only ever touches the
// intended row. On success we also best-effort mirror the finished URL onto the
// originating content_items.asset_url (only when empty — never clobber).

// The minimal, id-addressable view of the content_assets row we finalise. Kept
// narrow so callers hand us exactly what they read.
export interface FalAssetRow {
  id: string;
  content_item_id: string | null;
  fal_model_id: string | null;
  estimated_cost_usd: number | null;
  status: string;
}

// Loosely-typed service-role shim — content_items isn't in the generated types
// (same idiom as the HeyGen/Canva helpers), and content_assets is written via a
// plain id-scoped update.
type SvcDb = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => Promise<{ error: unknown }>;
    };
    select: (c: string) => {
      eq: (c: string, val: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

// Apply a terminal fal result to a content_assets row (and, on success, mirror
// the URL onto the content item). No-op for non-terminal results so repeated
// polls before completion don't churn the row. Returns the status we settled the
// row to, or "processing" when nothing changed. Idempotent: an already-terminal
// row is left untouched.
export async function applyFalCompletion(
  row: FalAssetRow,
  result: FalVideoResult
): Promise<"ready" | "failed" | "processing"> {
  // Already settled → do not re-write (webhook + poll can both arrive).
  if (row.status === "ready" || row.status === "failed" || row.status === ASSET_REMOVED_STATUS) {
    return row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "processing";
  }

  const svc = createServiceRoleClient() as unknown as SvcDb;

  if (result.status === "completed" && result.videoUrl) {
    // Re-price the real runtime at the model's rate the approver saw. When fal
    // doesn't report a duration, keep the stored estimate rather than invent one.
    const model = row.fal_model_id ? getFalModel(row.fal_model_id) : null;
    const actualCost =
      model && result.durationSeconds != null
        ? estimateFalCostUsd(model, result.durationSeconds)
        : row.estimated_cost_usd;

    console.log(
      "[fal] completing asset",
      row.id,
      "duration",
      result.durationSeconds,
      "costUsd",
      actualCost
    );

    const update: Record<string, unknown> = {
      status: "ready",
      url: result.videoUrl,
      thumbnail_url: result.thumbnailUrl,
      duration_seconds: result.durationSeconds,
      updated_at: new Date().toISOString(),
    };
    if (actualCost != null) update.cost_usd = actualCost;

    const { error } = await svc.from("content_assets").update(update).eq("id", row.id);
    if (error) console.error("[fal] completion asset update failed", row.id, error);

    // Best-effort: surface the finished clip on the content item so the editor /
    // calendar shows it — only when asset_url is empty (never clobber a link).
    if (row.content_item_id) {
      try {
        const { data: ci } = await svc
          .from("content_items")
          .select("asset_url")
          .eq("id", row.content_item_id)
          .maybeSingle();
        const assetUrl = (ci as { asset_url?: string | null } | null)?.asset_url ?? null;
        if (!assetUrl) {
          const { error: ciErr } = await svc
            .from("content_items")
            .update({ asset_url: result.videoUrl })
            .eq("id", row.content_item_id);
          if (ciErr) console.error("[fal] content_items.asset_url mirror failed", row.id, ciErr);
        }
      } catch (e) {
        console.error("[fal] content_items mirror threw", row.id, e);
      }
    }
    return "ready";
  }

  if (result.status === "failed") {
    console.log("[fal] marking asset failed", row.id, result.error);
    const { error } = await svc
      .from("content_assets")
      .update({
        status: "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) console.error("[fal] failure asset update failed", row.id, error);
    return "failed";
  }

  // Still queued / rendering — nothing to persist yet.
  return "processing";
}

// Look up a single content_assets row by its fal request id, using service-role
// (the webhook has no session). Returns the narrow shape applyFalCompletion needs
// plus the fal slug so the caller can fetch the result. null when not found.
export async function findAssetByRequestId(
  requestId: string
): Promise<(FalAssetRow & { fal_slug: string | null; fal_response_url: string | null }) | null> {
  const svc = createServiceRoleClient();
  const { data, error } = await (svc as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: string) => {
          maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
        };
      };
    };
  })
    .from("content_assets")
    .select("id, content_item_id, status, cost_usd, meta")
    .eq("meta->>fal_request_id", requestId)
    .maybeSingle();
  if (error) {
    console.error("[fal] findAssetByRequestId failed", error);
    return null;
  }
  if (!data) return null;
  const r = data as {
    id: string;
    content_item_id: string | null;
    status: string;
    cost_usd: number | string | null;
    meta: Record<string, unknown> | null;
  };
  const meta = r.meta ?? {};
  return {
    id: r.id,
    content_item_id: r.content_item_id,
    status: r.status,
    estimated_cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
    fal_model_id: (meta.fal_model_id as string | undefined) ?? null,
    fal_slug: (meta.fal_slug as string | undefined) ?? null,
    fal_response_url: (meta.fal_response_url as string | undefined) ?? null,
  };
}
