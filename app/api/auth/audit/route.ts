import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import { resolveAuditActor } from "@/lib/security/audit";

// POST /api/auth/audit — records the client-driven AUTH security events on the
// shared action_audit trail (PASTE 3.2, Part B).
//
// login / failed login / password change happen in the browser against Supabase
// auth, so the client reports them here right after they occur:
//   • login / password_change  → the session cookie is set, so we read the
//     authenticated user server-side and stamp actor_id/role from their profile.
//     A caller cannot forge these: without a valid session we reject.
//   • failed_login             → there is no session (the attempt failed), so we
//     record via the service role against the default org with actor_id null and
//     the ATTEMPTED email in detail — the signal leadership needs to spot
//     brute-forcing even though no user is authenticated.
//
// Never trust the client for identity: on the authenticated paths we ignore any
// client-sent identity and use only the verified session.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single-tenant for now — the one Mthryve org (matches the automation gateway).
const DEFAULT_ORG_ID = "146ab645-a5b8-4916-85c0-4ebd91480478";

type Shim = { from: (t: string) => any };

const BodySchema = z.object({
  event: z.enum(["login", "failed_login", "password_change"]),
  email: z.string().trim().max(320).optional(),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    const result = BodySchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // Failed login: no session exists. Record via the service role so the attempt
  // is still auditable, with the attempted email as the only identifying detail.
  if (parsed.event === "failed_login") {
    const db = createServiceRoleClient() as unknown as Shim;
    await writeActionAudit(db, {
      org_id: DEFAULT_ORG_ID,
      action_request_id: null,
      event: "failed_login",
      actor_id: null,
      actor_role: "anonymous",
      detail: { email: parsed.email ?? null },
    });
    return NextResponse.json({ ok: true });
  }

  // login / password_change: require a real session; identity comes from it.
  const supabase = createServerSupabaseClient();
  const actor = await resolveAuditActor(supabase);
  if (!actor) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  await writeActionAudit(supabase as unknown as Shim, {
    org_id: actor.org_id,
    action_request_id: null,
    event: parsed.event,
    actor_id: actor.actor_id,
    actor_role: actor.actor_role,
    detail: { email: parsed.email ?? null },
  });

  return NextResponse.json({ ok: true });
}
