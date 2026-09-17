import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { isWindsorConfigured } from "@/lib/windsor/client";
import { mappedBrandCount } from "@/lib/windsor/brands";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";

// GET /api/integrations/ad-ops/diag — leadership-only self-diagnostics for the
// Vesper Ad Ops / Windsor.ai integration. Answers "is the key set and how many
// brands are mapped?" WITHOUT ever leaking the key: booleans + counts only.
//
//   { hasKey, mappedBrands, currency, runtime, dynamic }
//
// hasKey reflects WINDSOR_API_KEY presence (read at call time). mappedBrands is
// the number of brands with at least one account in WINDSOR_BRAND_MAP. The key
// itself is NEVER returned.
export async function GET() {
  await requireRole(["ceo", "coo", "department_head"]);

  return NextResponse.json({
    hasKey: isWindsorConfigured(),
    mappedBrands: mappedBrandCount(),
    currency: process.env.WINDSOR_CURRENCY?.trim() || "PHP",
    runtime: "nodejs",
    dynamic: true,
  });
}
