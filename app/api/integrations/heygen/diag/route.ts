import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { getWallet, listAvatars, isHeygenConfigured } from "@/lib/heygen/client";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";

// GET /api/integrations/heygen/diag — leadership-only self-diagnostics for the
// HeyGen AI-video integration. Answers "is the key set and does it work?"
// WITHOUT ever leaking the key: booleans + non-sensitive numbers only.
//
//   { hasApiKey, remainingQuota, walletBalanceUsd, avatarsCount, walletEmpty,
//     message?, runtime, dynamic }
//
// remainingQuota is HeyGen's raw credit balance from /v2/user/remaining_quota;
// walletBalanceUsd is populated only when the payload carries an explicit dollar
// figure (otherwise null — rely on remainingQuota). Both are null when the key
// is missing OR invalid (getWallet swallows the failure), so null-next-to-
// hasApiKey:true is the tell-tale of a bad/expired key. avatarsCount is a cheap
// authenticated GET that further confirms the key works. When the quota is
// exhausted (remainingQuota <= 0) we surface the top-up message. Gated by the
// same leadership requireRole as the rest of the integration.
export async function GET() {
  await requireRole(["ceo", "coo", "department_head"]);

  const hasApiKey = isHeygenConfigured();

  let remainingQuota: number | null = null;
  let walletBalanceUsd: number | null = null;
  let avatarsCount: number | null = null;
  if (hasApiKey) {
    // Both calls are defensive (never throw for a bad key — they log + return
    // nulls/[]), so a broken key simply surfaces as null quota / 0 avatars.
    const [wallet, avatars] = await Promise.all([getWallet(), listAvatars()]);
    remainingQuota = wallet.remainingQuota;
    walletBalanceUsd = wallet.walletBalanceUsd;
    avatarsCount = avatars.length;
  }

  const walletEmpty = remainingQuota != null && remainingQuota <= 0;

  return NextResponse.json({
    hasApiKey,
    remainingQuota,
    walletBalanceUsd,
    avatarsCount,
    walletEmpty,
    ...(walletEmpty ? { message: "HeyGen wallet empty — top up to generate." } : {}),
    runtime: "nodejs",
    dynamic: true,
  });
}
