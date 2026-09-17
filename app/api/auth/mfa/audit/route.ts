import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit/log";

// POST /api/auth/mfa/audit — records the MFA lifecycle events on the privileged
// audit_log trail (migration 20260720000000, "reuse #190").
//
// Enroll / challenge-pass / unenroll all happen in the browser against Supabase
// auth (supabase.auth.mfa.*), so the client reports them here right after they
// succeed. Identity is NEVER trusted from the client: we read the authenticated
// user server-side from the session cookie and stamp actor_id/role/org from the
// verified profile. Without a valid session we reject.
//
// writeAudit is best-effort and service-role (audit_log has no INSERT policy), so
// a failed insert can never break the auth flow that triggered it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The only three actions this endpoint may record. An allowlist keeps the trail
// honest — a client can't invent arbitrary audit verbs through this surface.
const MFA_AUDIT_EVENTS = ["mfa_enrolled", "mfa_challenge_passed", "mfa_unenrolled"] as const;

const BodySchema = z.object({
  event: z.enum(MFA_AUDIT_EVENTS),
  // Optional, non-secret context: the factor id and/or friendly name. Never a
  // TOTP code or secret — those never leave the enrollment step.
  factorId: z.string().trim().max(200).optional(),
  friendlyName: z.string().trim().max(200).optional(),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof BodySchema>;
  try {
    const result = BodySchema.safeParse(await req.json());
    if (!result.success) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // Identity comes from the verified session only. Read the auth user, then their
  // profile (org + role) so the audit row is stamped with who did it.
  const supabase = createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("users")
    .select("org_id, role")
    .eq("id", user.id)
    .single();
  const orgId = (profile as { org_id?: string } | null)?.org_id ?? null;
  const role = (profile as { role?: string } | null)?.role ?? null;

  await writeAudit({
    action: parsed.event,
    entityType: "mfa_factor",
    entityId: parsed.factorId ?? null,
    actorUserId: user.id,
    actorRole: role,
    orgId,
    detail: parsed.friendlyName ? { friendlyName: parsed.friendlyName } : null,
  });

  return NextResponse.json({ ok: true });
}
