// lib/daily-tap/read.ts — the READ + interaction side of the Daily Tap: the inbox
// read, the in-app snooze nudge check, and the "acted" mark.
//
// public.daily_taps has a WORKING self-only READ policy
// (org_id = current_org_id() AND (user_id = auth.uid() OR role in ceo/coo)), so
// every READ here runs on the normal AUTHED client and RLS enforces self-only in
// the database. There is NO write policy, so the WRITES (the snooze increment and
// the acted stamp) still run on the service-role client. Callers pass the right
// client per operation. Each function also takes an explicit, server-VERIFIED
// userId/orgId (from the signed-in session, never request input) and scopes its
// query to that user's own row, so self-only holds even for a ceo/coo whose read
// policy would otherwise let them see peers. Nothing here is callable from the
// browser directly; it runs behind the authed app routes and server components.

import type { TapTier } from "@/lib/daily-tap/types";

type Shim = { from: (t: string) => any };

// The snooze cadence: at most 3 in-app re-shows, each ≥ 20 minutes apart, and it
// stops the moment the user acts.
export const MAX_SNOOZES = 3;
export const SNOOZE_INTERVAL_MS = 20 * 60 * 1000;

export interface TapRecord {
  id: string;
  tap_date: string;
  tier: TapTier;
  summary: string | null;
  ai_used: boolean;
  channels: string[];
  status: string;
  snooze_count: number;
  last_nudge_at: string | null;
  acted_at: string | null;
  created_at: string;
}

const COLS =
  "id, tap_date, tier, summary, ai_used, channels, status, snooze_count, last_nudge_at, acted_at, created_at";

// Today's tap for one user (or null when none was recorded). Scoped to the
// verified user + org + date.
export async function readTodaysTap(
  db: Shim,
  userId: string,
  orgId: string,
  today: string
): Promise<TapRecord | null> {
  try {
    const { data } = await db
      .from("daily_taps")
      .select(COLS)
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .eq("tap_date", today)
      .maybeSingle();
    return (data as TapRecord | null) ?? null;
  } catch {
    return null;
  }
}

// The user's most recent taps, newest first — the inbox history rail.
export async function readRecentTaps(
  db: Shim,
  userId: string,
  orgId: string,
  limit = 14
): Promise<TapRecord[]> {
  try {
    const { data } = await db
      .from("daily_taps")
      .select(COLS)
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .order("tap_date", { ascending: false })
      .limit(limit);
    return ((data as TapRecord[] | null) ?? []).map((r) => ({
      ...r,
      channels: Array.isArray(r.channels) ? r.channels : [],
    }));
  } catch {
    return [];
  }
}

export interface NudgeResult {
  nudge: boolean;
  reason: "shown" | "no_tap" | "acted" | "capped" | "too_soon";
  snoozeCount?: number;
  tap?: { tier: TapTier; summary: string | null; tap_date: string; ai_used: boolean };
}

// The in-app snooze check the app shell polls (on load, then every 20 min).
// Re-shows today's tap iff it is UNACTED, under the snooze cap, and at least the
// interval has passed since the last nudge — then increments snooze_count and
// stamps last_nudge_at. IN-APP ONLY: this never re-sends the email. Returns the
// tap payload to re-show when a nudge fires. Best-effort; a write failure simply
// yields no nudge rather than throwing.
//
// Two clients: the READ of today's tap goes through `readDb` (the authed client,
// so RLS enforces self-only), and the snooze increment goes through `writeDb`
// (the service-role client, because daily_taps has no write policy).
export async function runNudgeCheck(
  readDb: Shim,
  writeDb: Shim,
  userId: string,
  orgId: string,
  today: string,
  nowMs: number = Date.now()
): Promise<NudgeResult> {
  const tap = await readTodaysTap(readDb, userId, orgId, today);
  if (!tap) return { nudge: false, reason: "no_tap" };
  if (tap.acted_at) return { nudge: false, reason: "acted" };
  if (tap.snooze_count >= MAX_SNOOZES) return { nudge: false, reason: "capped" };

  const last = tap.last_nudge_at ? Date.parse(tap.last_nudge_at) : 0;
  if (Number.isFinite(last) && nowMs - last < SNOOZE_INTERVAL_MS) {
    return { nudge: false, reason: "too_soon" };
  }

  const nextCount = tap.snooze_count + 1;
  try {
    // Guard the update on the observed snooze_count so two concurrent polls can't
    // both increment past the cap (optimistic concurrency).
    const { data, error } = await writeDb
      .from("daily_taps")
      .update({ snooze_count: nextCount, last_nudge_at: new Date(nowMs).toISOString() })
      .eq("id", tap.id)
      .eq("snooze_count", tap.snooze_count)
      .is("acted_at", null)
      .select("id");
    if (error || !((data as unknown[] | null)?.length)) {
      return { nudge: false, reason: "too_soon" };
    }
  } catch {
    return { nudge: false, reason: "too_soon" };
  }

  return {
    nudge: true,
    reason: "shown",
    snoozeCount: nextCount,
    tap: { tier: tap.tier, summary: tap.summary, tap_date: tap.tap_date, ai_used: tap.ai_used },
  };
}

// Mark today's tap ACTED (snoozing stops). Idempotent: only stamps a tap that
// isn't already acted, and only the verified user's own row. Returns true when a
// row transitioned to acted. Safe to call from any "completed the action" path
// (Quick Entry save, opening the linked brief).
export async function markTapActed(
  db: Shim,
  userId: string,
  orgId: string,
  today: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  try {
    const { data } = await db
      .from("daily_taps")
      .update({ acted_at: new Date(nowMs).toISOString() })
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .eq("tap_date", today)
      .is("acted_at", null)
      .select("id");
    return ((data as unknown[] | null)?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
