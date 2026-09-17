import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { isJson2VideoConfigured } from "@/lib/json2video/client";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";

// GET /api/integrations/assembly/diag — leadership-only self-diagnostics for the
// JSON2Video listing-video assembly integration. Answers "is the key set?"
// WITHOUT ever leaking the key: a single boolean.
//
//   { hasKey }
//
// hasKey reflects JSON2VIDEO_API_KEY presence (read at call time). The key itself
// is NEVER returned. Gated by the same leadership requireRole as the rest of the
// integration diag routes.
export async function GET() {
  await requireRole(["ceo", "coo", "department_head"]);

  return NextResponse.json({
    hasKey: isJson2VideoConfigured(),
    runtime: "nodejs",
    dynamic: true,
  });
}
