import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { automationApiKey, cronSecret, isTikTokConfigured } from "@/lib/tiktok/config";
import { syncProducts } from "@/lib/tiktok/products";

export const runtime = "nodejs";
// Read env fresh per request (Vercel "Sensitive" runtime-only vars) and never
// cache — this is a mutating sync, not a static read.
export const dynamic = "force-dynamic";
// A multi-shop product pull (list + per-product detail) is I/O-heavy; give it
// room. Matches the daily tiktok/sync route.
export const maxDuration = 300;

// POST/GET /api/automation/products — the TikTok PRODUCT-identity sync.
//
// Fills public.products from the TikTok Product API so Logi/warehouse has real
// SKUs. MACHINE-ONLY: automation's Schedule node drives it with
// `Authorization: Bearer <secret>`; no Vercel cron. The accepted secret is
// CRON_SECRET or AUTOMATION_API_KEY (the GitHub Actions key) — both server-side machine
// secrets compared in constant time. Anything else is 401.
//
// Run this AFTER the shop/perf sync so each shop's token + cipher are fresh.
// READ from TikTok, WRITE only API-owned columns of products (warehouse-managed
// fields are never in the payload, so they survive every re-sync).

// Constant-time check that the Authorization header is `Bearer <expected>`.
// Copied verbatim from app/api/integrations/tiktok/sync/route.ts.
function bearerMatches(authHeader: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const provided = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  // --- Auth: a machine bearer (GitHub Actions automation OR cron). ---
  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  const isMachine =
    bearerMatches(authHeader, cronSecret()) || bearerMatches(authHeader, automationApiKey());
  if (!isMachine) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isTikTokConfigured()) {
    return NextResponse.json({ error: "tiktok_not_configured" }, { status: 503 });
  }

  try {
    const summary = await syncProducts();
    console.info("[tiktok] products sync done", summary);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[tiktok] products sync threw", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Support GET too so a simple scheduler/health probe can drive the same route.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
