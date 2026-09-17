import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { recordSecurityEvent } from "@/lib/security/events";

// POST /api/security/login-failed — records a failed password login as a
// security signal (PASTE 4.3 Part D — failed-login-burst monitor). The login
// form is client-side (supabase.auth.signInWithPassword), so there is no session
// on failure; the client pings this endpoint with the attempted email.
//
// It resolves the email → org with the service-role client so the event can be
// attributed to a tenant, but ALWAYS returns 204 no matter what (unknown email,
// bad body, anything) — so it can never be used as an account-enumeration oracle.
// Rate-limited by middleware under the "auth" category.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    // Cheap sanity bound; never reveal whether it matched.
    if (email && email.length <= 320 && email.includes("@")) {
      const db = createServiceRoleClient() as unknown as { from: (t: string) => any };
      const { data } = await db.from("users").select("id, org_id").eq("email", email).maybeSingle();
      const row = data as { id?: string; org_id?: string } | null;
      if (row?.org_id) {
        await recordSecurityEvent(db, {
          orgId: row.org_id,
          userId: row.id ?? null,
          eventType: "failed_login",
          severity: "warning",
          subject: email,
          ip: clientIp(req),
        });
      }
    }
  } catch {
    // Never surface anything — this is a fire-and-forget signal.
  }
  return new NextResponse(null, { status: 204 });
}
