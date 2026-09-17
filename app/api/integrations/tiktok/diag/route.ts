import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { tiktokRedirectUri } from "@/lib/tiktok/config";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";

// GET /api/integrations/tiktok/diag — leadership-only self-diagnostics for the
// TikTok Shop
// Partner integration. Answers "why won't TikTok connect?" WITHOUT ever leaking
// a secret: booleans + non-sensitive strings only (which env vars are present,
// the redirect URI, the origin, and per-org vault row counts). Never returns any
// token or secret value.
//
// Gated by the same requireRole as connect/callback so only leadership can see
// even this much. The counts use the service-role client (the only thing that
// can read the locked tiktok_* tables).

// Minimal service-role count shim — the tiktok_* tables aren't in the generated
// Supabase types (same idiom as lib/tiktok/vault.ts).
type CountDb = {
  from: (t: string) => {
    select: (
      c: string,
      opts: { count: "exact"; head: true }
    ) => {
      eq: (col: string, v: string) => Promise<{ count: number | null; error: unknown }>;
    };
  };
};

async function countForOrg(table: string, orgId: string): Promise<number | null> {
  try {
    const svc = createServiceRoleClient() as unknown as CountDb;
    const { count, error } = await svc
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId);
    if (error) {
      console.error("[tiktok] diag count error", table, error);
      return null;
    }
    return count ?? 0;
  } catch (e) {
    console.error("[tiktok] diag count threw", table, e);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const profile = await requireRole(["ceo", "coo", "department_head"]);

  const appOrigin = new URL(request.url).origin;
  const redirectUri = tiktokRedirectUri(request.url);

  const hasServiceRoleKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hasSupabaseUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);

  let connectionsCount: number | null = null;
  let shopsCount: number | null = null;
  if (hasServiceRoleKey && hasSupabaseUrl) {
    connectionsCount = await countForOrg("tiktok_connections", profile.org_id);
    shopsCount = await countForOrg("tiktok_shops", profile.org_id);
  }

  return NextResponse.json({
    hasAppKey: Boolean(process.env.TIKTOK_APP_KEY),
    hasAppSecret: Boolean(process.env.TIKTOK_APP_SECRET),
    hasServiceId: Boolean(process.env.TIKTOK_SERVICE_ID),
    hasRedirectUri: Boolean(process.env.TIKTOK_REDIRECT_URI),
    hasServiceRoleKey,
    redirectUri,
    appOrigin,
    connectionsCount,
    shopsCount,
    runtime: "nodejs",
    dynamic: true,
  });
}
