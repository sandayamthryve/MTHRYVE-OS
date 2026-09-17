import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { parseJsonBody, serverError } from "@/lib/security/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LEADERSHIP = ["ceo", "coo", "department_head"] as const;

const ApproveSchema = z.object({
  id: z.string().max(200).optional(),
  override: z.boolean().optional(),
});

// POST /api/metrics/entries/approve — leadership-only. Stamps approved_by /
// approved_at on a metric entry. Optionally marks validation_status
// 'overridden' when leadership accepts a manual value despite an API mismatch.
//
// The DB guard trigger (guard_metric_entry_approval) is the real enforcement of
// the leadership rule; this handler mirrors it so non-leadership get a clean 403
// instead of a raised exception.
export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!LEADERSHIP.includes(profile.role as (typeof LEADERSHIP)[number])) {
    return NextResponse.json({ error: "Only leadership may approve metric entries." }, { status: 403 });
  }

  const parsed = await parseJsonBody(request, ApproveSchema, "metrics/entries/approve");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }
  const override = body.override === true;

  const supabase = createServerSupabaseClient();
  const patch: Record<string, unknown> = {
    approved_by: profile.id,
    approved_at: new Date().toISOString(),
  };
  if (override) patch.validation_status = "overridden";

  // `as never` per the codebase's @supabase/ssr write-inference convention.
  const { error } = await supabase.from("metric_entries").update(patch as never).eq("id", id);
  if (error) {
    return serverError("metrics/entries/approve", error, 400, "Could not approve the entry.");
  }
  return NextResponse.json({ ok: true, id, approved_by: profile.id });
}
