import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { buildSnapshot } from "@/lib/os/snapshot";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";

// GET /api/os/snapshot — the single canonical, org-scoped read for all KPIs.
//
// ADDITIVE: this ships ALONGSIDE the existing dashboards; nothing else changes.
// Everything is computed live through the CALLER's own RLS-scoped Supabase
// session, so `org_id = current_org_id()` (and the finance gate
// `current_user_role() in ('ceo','coo')`) stay the real boundary — this route
// adds no schema, no service-role, and no write. See lib/os/snapshot.ts for the
// centralized query logic and the exact source of every figure.
//
// RANGE: the caller passes the SAME date-range query params the shared picker
// writes (?preset / ?period_start / ?period_end, plus legacy ?from/?to), and we
// resolve them through the ONE parser every dashboard uses (resolveDateRange), so
// the snapshot's window is identical to what the page's <DateRangeControls> shows.
// An absent/invalid preset falls back to MTD — the Command Center default.
//
// The finance block is populated for ceo/coo only; for every other role it is
// null (the fields are never even fetched — defense in depth on top of the
// finance-table RLS).
//
// Caching: the response is per-user (RLS-scoped + role-gated finance), so it must
// NEVER be shared across users. We recompute server-side on every request
// (force-dynamic) and let the BROWSER hold a short private copy for ~45s via
// `Cache-Control: private` — that gives the asked-for 30–60s revalidation window
// without a shared cache that could leak one user's org (or finance) to another.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = createServerSupabaseClient();

  // Identity + org come from the same session the RLS policies read. A missing
  // profile means not signed in (or no profile row) → 401, no data.
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Resolve the selected window from the URL through the shared parser, so the
  // snapshot scopes to exactly what the page's date picker shows. MTD is the
  // Command Center default when no preset is supplied.
  const sp = Object.fromEntries(
    request.nextUrl.searchParams.entries()
  ) as DateRangeSearchParams;
  const dr = resolveDateRange(sp, { fallbackPreset: "mtd" });

  try {
    const snapshot = await buildSnapshot({
      supabase,
      orgId: profile.org_id,
      role: profile.role,
      range: {
        key: dr.preset,
        start: dr.range.start,
        end: dr.range.end,
        label: dr.rangeLabel,
      },
    });

    return NextResponse.json(snapshot, {
      headers: {
        // Private so it is cached per-browser, never in a shared/CDN cache.
        "Cache-Control": "private, max-age=45, stale-while-revalidate=30",
      },
    });
  } catch (err) {
    console.error("[os/snapshot] failed to build snapshot", err);
    return NextResponse.json({ error: "snapshot_failed" }, { status: 500 });
  }
}
