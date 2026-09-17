import { NextResponse } from "next/server";
import { canAccessModulePath } from "@/lib/auth/module-access";
import { z } from "zod";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { parseJsonBody } from "@/lib/security/api";
import { sanitizeNullableText } from "@/lib/security/sanitize";
import { getDashboard, getUserNames } from "@/lib/metrics/data";
import { upsertManualEntry } from "@/lib/metrics/manual-entry";
import { isDepartment } from "@/lib/metrics/types";
import {
  parsePreset,
  parseCompare,
  resolvePreset,
  resolveCompare,
  isValidDate,
  type Range,
} from "@/lib/metrics/dates";

// Accept the known manual-entry fields; `.passthrough()` keeps any extra keys so
// the forbidden-field guard below can still reject API-owned columns explicitly.
const EntrySchema = z
  .object({
    metric_key: z.string().max(200).optional(),
    department: z.string().max(100).optional(),
    period_start: z.string().max(40).optional(),
    period_end: z.string().max(40).optional(),
    brand_id: z.union([z.string().max(200), z.null()]).optional(),
    note: z.union([z.string().max(10_000), z.null()]).optional(),
    manual_value: z.union([z.number(), z.string().max(64), z.null()]).optional(),
  })
  .passthrough();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Resolve the period from explicit period_start/period_end, or fall back to the
// named preset (default Last 7 Days) evaluated against the server's now.
function resolveRange(params: URLSearchParams): Range {
  const ps = params.get("period_start");
  const pe = params.get("period_end");
  if (isValidDate(ps) && isValidDate(pe)) return { start: ps, end: pe };
  return resolvePreset(parsePreset(params.get("preset")), new Date());
}

// GET /api/metrics/entries?department=&brand_id=&period_start=&period_end=
// Entries joined to the catalog (label/unit/lane/direction) and to
// metric_targets (health). CALCULATED metrics are computed at read time and
// marked origin='calculated'. Missing values come back null (never 0).
export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const department = params.get("department") ?? "";
  if (!isDepartment(department)) {
    return NextResponse.json({ error: "Unknown department." }, { status: 400 });
  }

  const rawBrand = params.get("brand_id");
  const brandId = rawBrand && rawBrand !== "shop" && rawBrand !== "" ? rawBrand : null;
  const range = resolveRange(params);
  const compareRange = resolveCompare(range, parseCompare(params.get("compare")));

  const supabase = createServerSupabaseClient();
  const userNames = await getUserNames(supabase);
  const data = await getDashboard(supabase, {
    department,
    brandId,
    range,
    compareRange,
    userNames,
  });

  return NextResponse.json(
    { department, brand_id: brandId, range, compareRange, metrics: data.metrics },
    { headers: { "cache-control": "no-store" } }
  );
}

// POST /api/metrics/entries — upsert the MANUAL value for one metric/brand/
// period. This never touches api_value: any api_value/origin/validation the
// client tries to send is ignored. origin is forced to 'manual' and entered_by
// comes from the session.
export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, EntrySchema, "metrics/entries");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as Record<string, unknown>;

  // Hard reject any attempt to write API-owned or privileged fields from the
  // client. These columns are owned by the sync / approval flows only.
  for (const forbidden of ["api_value", "validation_status", "variance_pct", "approved_by", "approved_at"]) {
    if (forbidden in body && body[forbidden] != null) {
      return NextResponse.json(
        { error: `Field '${forbidden}' cannot be set from the client.` },
        { status: 400 }
      );
    }
  }

  const metric_key = typeof body.metric_key === "string" ? body.metric_key : "";
  const department = typeof body.department === "string" ? body.department : "";
  if (profile.preview_role && !canAccessModulePath(profile.preview_role, `/analytics/${department}`)) {
    return NextResponse.json({ error: "Department access denied." }, { status: 403 });
  }
  const period_start = typeof body.period_start === "string" ? body.period_start : "";
  const period_end = typeof body.period_end === "string" ? body.period_end : "";
  const brand_id =
    typeof body.brand_id === "string" && body.brand_id !== "" && body.brand_id !== "shop"
      ? body.brand_id
      : null;
  // Strip any markup/control chars before the note ever reaches the DB.
  const note = sanitizeNullableText(body.note);

  // manual_value: a finite number to set, or null to clear. Anything else is a
  // bad request — we never coerce garbage to 0.
  let manual_value: number | null;
  if (body.manual_value === null || body.manual_value === "") {
    manual_value = null;
  } else if (typeof body.manual_value === "number" && Number.isFinite(body.manual_value)) {
    manual_value = body.manual_value;
  } else if (typeof body.manual_value === "string" && body.manual_value.trim() !== "" && Number.isFinite(Number(body.manual_value))) {
    manual_value = Number(body.manual_value);
  } else {
    return NextResponse.json({ error: "manual_value must be a number or null." }, { status: 400 });
  }

  if (!metric_key || !isDepartment(department) || !isValidDate(period_start) || !isValidDate(period_end)) {
    return NextResponse.json(
      { error: "metric_key, department, period_start, period_end are required." },
      { status: 400 }
    );
  }

  const supabase = createServerSupabaseClient();

  // One sanctioned manual-floor upsert (shared with the mobile Quick-Entry
  // capture): validates the metric against the caller's catalog, refuses derived
  // metrics, and writes ONLY manual_value / origin / entered_by / note.
  const result = await upsertManualEntry(supabase, profile, {
    metric_key,
    department,
    brand_id,
    period_start,
    period_end,
    manual_value,
    note,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.id, action: result.action });
}
