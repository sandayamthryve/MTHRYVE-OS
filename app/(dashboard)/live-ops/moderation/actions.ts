"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { promoteLogToLiveSession, type PromotableLog } from "@/lib/contributors/promote";

// Server actions for the Moderator work-data gate.
//
// Authorization is DB-enforced: the moderator reads the target log through their
// own RLS-scoped client first. If the row comes back, they are ceo/coo OR hold a
// moderator_brand_assignment for that log's brand (the contriblogs_read policy) —
// otherwise the read returns nothing and the action aborts. Only AFTER that check
// does promotion write to live_sessions with the service-role client, keeping the
// promotion off the live_sessions page entirely (a new action, not a cluster edit).

type Db = { from: (t: string) => any };

const LOG_COLS =
  "id, org_id, contributor_id, brand_id, log_date, clock_in_at, extracted_metrics, status, promoted_session_id";

// Approve the snapped work-data → status 'work_approved' AND promote to a
// live_sessions row (brand + date + host), storing promoted_session_id.
export async function approveWorkData(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // RLS scoping IS the authorization: only a permitted moderator sees this row.
  const { data: logRow } = await db.from("contributor_logs").select(LOG_COLS).eq("id", id).maybeSingle();
  if (!logRow) return;
  const log = logRow as PromotableLog & { contributor_id: string; status: string };
  if (log.status === "work_approved") return; // idempotent — already approved

  // Contributor (name + platform) for the session title/platform. Org-readable.
  const { data: contribRow } = await db
    .from("contributors")
    .select("id, name, platform")
    .eq("id", log.contributor_id)
    .maybeSingle();
  const contributor = (contribRow as { id: string; name: string; platform: string | null } | null) ?? {
    id: log.contributor_id,
    name: "Host",
    platform: null,
  };

  // Promote with the service-role client (trusted, already-authorized step).
  const service = createServiceRoleClient() as unknown as Db;
  const sessionId = await promoteLogToLiveSession(service, log, contributor, profile.id);

  // Advance the log through the moderator's own RLS-scoped client so the write is
  // DB-gated too (the contriblogs_update policy re-checks the brand assignment).
  await db
    .from("contributor_logs")
    .update({
      status: "work_approved",
      work_reviewed_by: profile.id,
      work_reviewed_at: new Date().toISOString(),
      promoted_session_id: sessionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  revalidatePath("/live-ops/moderation");
  revalidatePath("/live-ops");
}

// Reject the snapped work-data → status 'rejected'. No promotion.
export async function rejectWorkData(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  const { data: logRow } = await db.from("contributor_logs").select("id, status").eq("id", id).maybeSingle();
  if (!logRow) return; // not visible → not authorized

  await db
    .from("contributor_logs")
    .update({
      status: "rejected",
      work_reviewed_by: profile.id,
      work_reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  revalidatePath("/live-ops/moderation");
}
