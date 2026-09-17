import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { upsertManualEntry } from "@/lib/metrics/manual-entry";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { markTapActed } from "@/lib/daily-tap/read";
import { todayManila } from "@/lib/metrics/windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/quick-entry/bulk — the bulk save behind the standalone mobile
// Quick-Entry grid. One period, one department, many metrics at once: every row
// the leader (or team member) typed a number into is written to the metric floor
// through the ONE sanctioned manual path (upsertManualEntry) — manual_value +
// origin='manual' + entered_by only, api_value never touched.
//
// Honest nulls: a blank input is NOT in the payload the client sends, and any
// null / non-finite value that slips through is skipped here — we never coerce a
// blank to a fabricated 0, and we never clear an existing value from a blank.
//
// The department rides on each metric row (it's metric_catalog.department, the
// TEXT name), so there is no uuid-vs-text guessing. RLS is the real write
// boundary; any authenticated org member may record.
interface BulkEntry {
  metric_key: string;
  department: string;
  manual_value: number;
  // 'vision' for a Snap-to-fill row the user reviewed; 'manual' (default) for a
  // hand-typed row. Only these two are honoured — see upsertManualEntry.
  origin: "manual" | "vision";
}

function isDateStr(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime());
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// GET /api/quick-entry/bulk?department=<code>&period_start=<day>&period_end=<day>
// — read BACK the org-level (brand_id null) manual floor already stored for a
// department + day, so the grid can PRE-FILL each row with what's persisted and a
// saved value REFLECTS on load (blanks stay "—"). It reads by the exact same keys
// the save writes and the Data Analytics dashboard reads — department CODE, period
// = the chosen day, brand_id IS NULL — so the grid, the save, and analytics can
// never disagree. RLS scopes every read to the caller's org.
export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const department = (searchParams.get("department") ?? "").trim();
  const period_start = searchParams.get("period_start") ?? "";
  const period_end = searchParams.get("period_end") || period_start;

  if (!department) {
    return NextResponse.json({ values: {} }, { headers: { "cache-control": "no-store" } });
  }
  if (!isDateStr(period_start) || !isDateStr(period_end)) {
    return NextResponse.json(
      { error: "A valid period_start (YYYY-MM-DD) is required." },
      { status: 400 }
    );
  }

  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("metric_entries")
    .select("metric_key, manual_value")
    .eq("department", department)
    .eq("period_start", period_start)
    .eq("period_end", period_end)
    .is("brand_id", null);

  // Only real, finite manual numbers become a pre-filled row. A stored null (an
  // entry that exists but was cleared) stays blank — honest "—", never a 0.
  const values: Record<string, number> = {};
  for (const row of (data ?? []) as unknown as { metric_key: string; manual_value: number | string | null }[]) {
    const n = num(row.manual_value);
    if (n != null) values[row.metric_key] = n;
  }

  return NextResponse.json({ values }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    period_start?: unknown;
    period_end?: unknown;
    brand_id?: unknown;
    entries?: unknown;
  };

  const period_start = payload.period_start;
  const period_end = payload.period_end;
  if (!isDateStr(period_start) || !isDateStr(period_end)) {
    return NextResponse.json(
      { error: "A valid period_start and period_end (YYYY-MM-DD) are required." },
      { status: 400 }
    );
  }

  const brand_id =
    typeof payload.brand_id === "string" && payload.brand_id !== "" && payload.brand_id !== "shop"
      ? payload.brand_id
      : null;

  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    return NextResponse.json({ error: "Enter at least one value to save." }, { status: 400 });
  }

  // Normalise + drop anything blank/garbage (honest nulls). Only rows with a real
  // finite number make it to the write path.
  const entries: BulkEntry[] = [];
  for (const raw of payload.entries) {
    const row = (raw ?? {}) as {
      metric_key?: unknown;
      department?: unknown;
      manual_value?: unknown;
      origin?: unknown;
    };
    const metric_key = typeof row.metric_key === "string" ? row.metric_key : "";
    const department = typeof row.department === "string" ? row.department : "";
    const value =
      typeof row.manual_value === "number"
        ? row.manual_value
        : typeof row.manual_value === "string" && row.manual_value.trim() !== ""
          ? Number(row.manual_value)
          : null;
    const origin: "manual" | "vision" = row.origin === "vision" ? "vision" : "manual";
    if (!metric_key || !department) continue;
    if (value == null || !Number.isFinite(value)) continue; // blank / non-number → skip
    entries.push({ metric_key, department, manual_value: value, origin });
  }

  if (entries.length === 0) {
    return NextResponse.json({ error: "No valid numbers to save." }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();

  // Each result carries the written entry_id so the client can hang evidence off
  // the exact metric_entry it just recorded (Part B attaches at entity_type
  // 'metric_entry', entity_id = this id).
  const results: Array<{
    metric_key: string;
    ok: boolean;
    action?: string;
    entry_id?: string | null;
    error?: string;
  }> = [];
  let saved = 0;
  for (const e of entries) {
    const res = await upsertManualEntry(supabase, profile, {
      metric_key: e.metric_key,
      department: e.department,
      brand_id,
      period_start,
      period_end,
      manual_value: e.manual_value,
      origin: e.origin,
      note: null,
    });
    if (res.ok) {
      saved += 1;
      results.push({ metric_key: e.metric_key, ok: true, action: res.action, entry_id: res.id });
    } else {
      results.push({ metric_key: e.metric_key, ok: false, error: res.error });
    }
  }

  // A saved row IS acting on today's daily tap — stop the in-app snooze nudges.
  // Best-effort, self-scoped to the verified session user; daily_taps is
  // RLS-with-no-policy so this uses the service-role client.
  if (saved > 0) {
    try {
      const svc = createServiceRoleClient() as unknown as { from: (t: string) => any };
      await markTapActed(svc, profile.id, profile.org_id, todayManila());
    } catch {
      /* best-effort — never break the bulk save */
    }
  }

  const failed = results.filter((r) => !r.ok);
  return NextResponse.json({
    ok: failed.length === 0,
    saved,
    failed: failed.length,
    period: { start: period_start, end: period_end },
    results,
  });
}
