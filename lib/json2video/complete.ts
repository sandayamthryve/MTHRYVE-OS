import { createServiceRoleClient } from "@/lib/supabase/service";
import { ASSET_REMOVED_STATUS } from "@/lib/content/assets";
import { coerceResolution, actualAssemblyCostUsd } from "@/lib/json2video/assembly";
import type { MovieResult } from "@/lib/json2video/client";

// Completion writer for JSON2Video assemblies — the ONE place a finished (or
// failed) assembled MP4 is recorded. Both the webhook receiver and the status
// poll route funnel here so the two paths write identically and idempotently.
//
// Like fal, there is NO separate ledger table: content_assets IS the ledger (we
// inserted the row as status='processing', kind='assembled_video', tagged with
// meta.json2video_project at submit time). So completion is an in-place UPDATE of
// that same row — no schema / RLS changes, as required.
//
// Writes go through the SERVICE-ROLE client on purpose: the webhook arrives with
// NO user session (RLS's current_org_id() would be null). Service-role bypasses
// RLS; we still scope every write by the row's own id so it only ever touches the
// intended row. On success we ALSO best-effort mirror the finished URL onto the
// originating content_items.asset_url (only when empty — never clobber).

// The minimal, id-addressable view of the content_assets row we finalise.
export interface AssemblyAssetRow {
  id: string;
  content_item_id: string | null;
  // The resolution id the approver saw (from meta) — used to re-price the real
  // runtime at the rate they approved.
  resolution_id: string | null;
  estimated_cost_usd: number | null;
  status: string;
}

// Loosely-typed service-role shim — content_items isn't in the generated types
// (same idiom as the fal/HeyGen helpers), and content_assets is written via a
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

// Apply a terminal JSON2Video result to a content_assets row (and, on success,
// mirror the URL onto the content item). No-op for non-terminal results so
// repeated polls before completion don't churn the row. Returns the status we
// settled the row to, or "processing" when nothing changed. Idempotent: an
// already-terminal row is left untouched.
export async function applyAssemblyCompletion(
  row: AssemblyAssetRow,
  result: MovieResult
): Promise<"ready" | "failed" | "processing"> {
  // Already settled → do not re-write (webhook + poll can both arrive).
  if (row.status === "ready" || row.status === "failed" || row.status === ASSET_REMOVED_STATUS) {
    return row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "processing";
  }

  const svc = createServiceRoleClient() as unknown as SvcDb;

  if (result.status === "done" && result.url) {
    // Re-price the real runtime at the resolution rate the approver saw. When
    // JSON2Video doesn't report a duration, keep the stored estimate.
    const resolution = coerceResolution(row.resolution_id);
    const repriced = actualAssemblyCostUsd(result.durationSeconds, resolution);
    const actualCost = repriced ?? row.estimated_cost_usd;

    console.log(
      "[json2video] completing asset",
      row.id,
      "duration",
      result.durationSeconds,
      "costUsd",
      actualCost
    );

    const update: Record<string, unknown> = {
      status: "ready",
      url: result.url,
      duration_seconds: result.durationSeconds,
      updated_at: new Date().toISOString(),
    };
    if (actualCost != null) update.cost_usd = actualCost;

    const { error } = await svc.from("content_assets").update(update).eq("id", row.id);
    if (error) console.error("[json2video] completion asset update failed", row.id, error);

    // Best-effort: surface the finished MP4 on the content item so the editor /
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
            .update({ asset_url: result.url })
            .eq("id", row.content_item_id);
          if (ciErr) console.error("[json2video] content_items.asset_url mirror failed", row.id, ciErr);
        }
      } catch (e) {
        console.error("[json2video] content_items mirror threw", row.id, e);
      }
    }
    return "ready";
  }

  if (result.status === "failed") {
    console.log("[json2video] marking asset failed", row.id, result.error);
    const { error } = await svc
      .from("content_assets")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) console.error("[json2video] failure asset update failed", row.id, error);
    return "failed";
  }

  // Still pending / running — nothing to persist yet.
  return "processing";
}

// The narrow content_assets shape both completion paths read, plus the fields
// applyAssemblyCompletion needs. Kept together so the poll route and the webhook
// receiver parse a row identically.
export interface AssemblyLedgerRow extends AssemblyAssetRow {
  project_id: string | null;
}

// Reconstruct an AssemblyLedgerRow from a raw content_assets read (id,
// content_item_id, status, cost_usd, meta). Centralised so the poll route and
// webhook receiver agree on where the project id / resolution live in meta.
export function ledgerRowFromRead(data: {
  id: string;
  content_item_id: string | null;
  status: string;
  cost_usd: number | string | null;
  meta: Record<string, unknown> | null;
}): AssemblyLedgerRow {
  const meta = data.meta ?? {};
  return {
    id: data.id,
    content_item_id: data.content_item_id,
    status: data.status,
    estimated_cost_usd: data.cost_usd == null ? null : Number(data.cost_usd),
    resolution_id: (meta.json2video_resolution as string | undefined) ?? null,
    project_id: (meta.json2video_project as string | undefined) ?? null,
  };
}

// Look up a single content_assets row by its JSON2Video project id, using
// service-role (the webhook has no session). null when not found.
export async function findAssetByProjectId(projectId: string): Promise<AssemblyLedgerRow | null> {
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
    .eq("meta->>json2video_project", projectId)
    .maybeSingle();
  if (error) {
    console.error("[json2video] findAssetByProjectId failed", error);
    return null;
  }
  if (!data) return null;
  return ledgerRowFromRead(
    data as {
      id: string;
      content_item_id: string | null;
      status: string;
      cost_usd: number | string | null;
      meta: Record<string, unknown> | null;
    }
  );
}
