// lib/daily-tap/types.ts — shared shapes for the Daily AI Tap.
//
// A "tap" is one person's morning brief for one day. It is built READ-ONLY from
// real rows, delivered as a per-user notification (+ optional email), and
// recorded once per (user, tap_date) in public.daily_taps. The persisted record
// carries a human-readable `summary` (the tap body) — the same text the
// notification and the in-app inbox render — plus the tier, whether AI was used,
// and which channels it reached.

import type { UserRole } from "@/types/database";

// public.daily_taps.tier — the check constraint allows exactly these three.
export type TapTier = "leadership" | "head" | "staff";

// Map an org role onto the tap tier. ceo/coo → the fuller AI leadership digest;
// department_head → the templated head brief; everyone else → the staff nudge.
export function tierForRole(role: UserRole): TapTier {
  if (role === "ceo" || role === "coo") return "leadership";
  if (role === "department_head") return "head";
  return "staff";
}

// The delivery channels a tap can reach. "inapp" is always attempted (the
// notification row + inbox); "email" only when a transport is configured.
export type TapChannel = "inapp" | "email";

// The brief each tier's tap points at. Derived from the tier (no link column
// needed) and shared by the builder, the inbox, and the nudge toast — opening it
// marks the tap ACTED. Client-safe (pure), so the client toast/link can import it.
export function tapLink(tier: TapTier): { href: string; label: string } {
  if (tier === "leadership") return { href: "/home/operations", label: "Open Operations brief" };
  if (tier === "head") return { href: "/home/dept", label: "Open your Dept Cockpit" };
  return { href: "/quick-entry", label: "Log today's Quick Entry" };
}

// A short, safe label for a tier (badges, headings).
export const TIER_LABEL: Record<TapTier, string> = {
  leadership: "Leadership digest",
  head: "Department brief",
  staff: "Daily tap",
};

// One built tap, ready to deliver. `title` heads the notification + inbox card;
// `summary` is the full body (plain, newline-separated). `aiUsed` is true only
// for a leadership tap whose Sonnet synthesis call actually returned.
export interface BuiltTap {
  tier: TapTier;
  title: string;
  summary: string;
  aiUsed: boolean;
}

// The active user the endpoint iterates over.
export interface TapUser {
  id: string;
  org_id: string;
  department_id: string | null;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  employment_status: string | null;
}
