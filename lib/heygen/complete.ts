import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  actualCostFromRate,
  deriveRatePerMinuteUsd,
} from "@/lib/heygen/cost";
import type { HeygenVideoStatus } from "@/lib/heygen/client";

// Completion writer for HeyGen generations — the ONE place a finished (or
// failed) render is recorded. Both the webhook receiver and the status poll
// route funnel here so the two paths write identically and idempotently.
//
// Writes go through the SERVICE-ROLE client on purpose: the webhook arrives with
// NO user session (so RLS's current_org_id() would be null), and the completion
// must land in two tables — the heygen_generations ledger AND the originating
// content_items.heygen_url. The service-role client bypasses RLS; we still scope
// every write by the row's own id/org so it only ever touches the intended row.
// We do NOT modify RLS or the schema.

// A minimal, id-addressable view of the ledger row we need to finalise. Kept
// narrow so callers can hand us exactly what they read.
export interface HeygenGenerationRow {
  id: string;
  content_item_id: string | null;
  script: string | null;
  estimated_cost_usd: number | null;
  status: string;
}

// Loosely-typed service-role shim — heygen_generations / content_items aren't in
// the generated Supabase types (same idiom as the Canva/TikTok vault helpers).
type SvcDb = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => Promise<{ error: unknown }>;
    };
    select: (c: string) => {
      eq: (c: string, val: string) => {
        eq: (c: string, val: string) => Promise<{ data: unknown[] | null; error: unknown }>;
        in: (c: string, vals: string[]) => Promise<{ data: unknown[] | null; error: unknown }>;
      };
    };
  };
};

// A narrower shim for the content_assets Kit mirror, which filters an UPDATE on
// two columns (meta linkage + kind). Kept separate so the main SvcDb stays as-is.
type AssetSvc = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => {
        eq: (c: string, val: string) => Promise<{ error: unknown }>;
      };
    };
  };
};

// Mirror a terminal HeyGen result onto the linked Creative Kit asset (the
// content_assets row we wrote at generation time, tagged with
// meta.heygen_generation_id = generationId, kind 'heygen_video'). Best-effort:
// the heygen_generations ledger + content_items.heygen_url are the source of
// truth, so a failed asset write only logs. Never clobbers a URL with null.
async function mirrorHeygenAsset(
  generationId: string,
  patch: Record<string, unknown>
): Promise<void> {
  try {
    const svc = createServiceRoleClient() as unknown as AssetSvc;
    const { error } = await svc
      .from("content_assets")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("meta->>heygen_generation_id", generationId)
      .eq("kind", "heygen_video");
    if (error) console.error("[heygen] creative-kit asset mirror failed", generationId, error);
  } catch (e) {
    console.error("[heygen] creative-kit asset mirror threw", generationId, e);
  }
}

// Apply a terminal HeyGen status to a ledger row (and, on success, back to the
// content item). No-op for non-terminal statuses (waiting/pending/processing) so
// repeated polls before completion don't churn the row. Returns the status we
// settled the row to, or "processing" when nothing changed.
export async function applyHeygenCompletion(
  row: HeygenGenerationRow,
  status: HeygenVideoStatus
): Promise<"completed" | "failed" | "processing"> {
  const svc = createServiceRoleClient() as unknown as SvcDb;

  if (status.status === "completed") {
    const rate = deriveRatePerMinuteUsd(row.script ?? "", row.estimated_cost_usd);
    const actual =
      status.durationSeconds != null ? actualCostFromRate(status.durationSeconds, rate) : null;

    console.log(
      "[heygen] completing generation",
      row.id,
      "duration",
      status.durationSeconds,
      "actualCostUsd",
      actual
    );

    const update: Record<string, unknown> = {
      status: "completed",
      video_url: status.videoUrl,
      thumbnail_url: status.thumbnailUrl,
      duration_seconds: status.durationSeconds,
      actual_cost_usd: actual,
      error_message: null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await svc.from("heygen_generations").update(update).eq("id", row.id);
    if (error) {
      console.error("[heygen] completion ledger update failed", row.id, error);
    }

    // Mirror the finished video onto the originating content item so the
    // calendar/editor shows it. Only when we actually have a URL and a linked
    // item. Never clobber with an empty value.
    if (status.videoUrl && row.content_item_id) {
      const { error: ciErr } = await svc
        .from("content_items")
        .update({ heygen_url: status.videoUrl })
        .eq("id", row.content_item_id);
      if (ciErr) console.error("[heygen] content_items.heygen_url update failed", row.id, ciErr);
    }

    // Mirror onto the Creative Kit asset: mark ready, fill URL/thumbnail/duration
    // and the actual cost. Only set url when we actually have one.
    const assetPatch: Record<string, unknown> = {
      status: "ready",
      thumbnail_url: status.thumbnailUrl,
      duration_seconds: status.durationSeconds,
    };
    if (status.videoUrl) assetPatch.url = status.videoUrl;
    if (actual != null) assetPatch.cost_usd = actual;
    await mirrorHeygenAsset(row.id, assetPatch);
    return "completed";
  }

  if (status.status === "failed") {
    console.log("[heygen] marking generation failed", row.id, status.error);
    const { error } = await svc
      .from("heygen_generations")
      .update({
        status: "failed",
        error_message: status.error ?? "HeyGen reported the render failed.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (error) console.error("[heygen] failure ledger update failed", row.id, error);
    await mirrorHeygenAsset(row.id, { status: "failed" });
    return "failed";
  }

  // Still rendering — nothing to persist yet.
  return "processing";
}

// Look up a single in-flight ledger row by its HeyGen video id, scoped to an org
// (webhook path — no session, so we scope explicitly). Returns null if not found.
export async function findGenerationByVideoId(
  heygenVideoId: string
): Promise<(HeygenGenerationRow & { org_id: string; heygen_video_id: string }) | null> {
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
    .from("heygen_generations")
    .select("id, org_id, content_item_id, script, estimated_cost_usd, status, heygen_video_id")
    .eq("heygen_video_id", heygenVideoId)
    .maybeSingle();
  if (error) {
    console.error("[heygen] findGenerationByVideoId failed", error);
    return null;
  }
  return (data as (HeygenGenerationRow & { org_id: string; heygen_video_id: string }) | null) ?? null;
}
