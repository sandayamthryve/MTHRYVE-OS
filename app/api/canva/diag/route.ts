import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { canvaRedirectUri } from "@/lib/canva/config";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";

// GET /api/canva/diag — leadership-only self-diagnostics for the Canva Connect
// OAuth integration. Answers "why won't Canva connect?" WITHOUT ever leaking a
// secret: it returns booleans + non-sensitive strings only (which env vars are
// present, the exact redirect_uri the connect route will build, the origin in
// use, and whether this org already has a vault row). Never returns token or
// secret values.
//
// Gated by the same requireRole as connect/callback so only leadership can see
// even this much. The vault row check uses the service-role client (the only
// thing that can read the locked canva_connections table) and reports a boolean.

// Minimal service-role read shim — canva_connections isn't in the generated
// Supabase types (same idiom as lib/canva/vault.ts).
type DiagDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        v: string
      ) => { maybeSingle: () => Promise<{ data: { org_id: string } | null; error: unknown }> };
    };
  };
};

export async function GET(request: NextRequest) {
  const profile = await requireRole(["ceo", "coo", "department_head"]);

  const appOrigin = new URL(request.url).origin;
  const redirectUri = canvaRedirectUri(request.url);

  const hasServiceRoleKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hasSupabaseUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);

  // Service-role read of this org's vault row → boolean only, never the tokens.
  let vaultRowExists = false;
  if (hasServiceRoleKey && hasSupabaseUrl) {
    try {
      const svc = createServiceRoleClient() as unknown as DiagDb;
      const { data, error } = await svc
        .from("canva_connections")
        .select("org_id")
        .eq("org_id", profile.org_id)
        .maybeSingle();
      if (error) console.error("[canva] diag vault read error", error);
      vaultRowExists = Boolean(data);
    } catch (e) {
      console.error("[canva] diag vault read threw", e);
    }
  }

  return NextResponse.json({
    hasClientId: Boolean(process.env.CANVA_CLIENT_ID),
    hasClientSecret: Boolean(process.env.CANVA_CLIENT_SECRET),
    hasServiceRoleKey,
    redirectUri,
    appOrigin,
    vaultRowExists,
    runtime: "nodejs",
    dynamic: true,
  });
}
