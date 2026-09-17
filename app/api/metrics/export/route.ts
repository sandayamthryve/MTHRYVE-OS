import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { recordSecurityEvent } from "@/lib/security/events";
import { auditDataExport } from "@/lib/security/audit";
import { getDashboard, getUserNames } from "@/lib/metrics/data";
import { isDepartment, DEPARTMENT_LABELS, type Department } from "@/lib/metrics/types";
import { ORIGIN_LABEL, VALIDATION_LABEL } from "@/lib/metrics/display";
import {
  parsePreset,
  resolvePreset,
  isValidDate,
  type Range,
} from "@/lib/metrics/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Wrap and escape a CSV cell so values with commas/quotes stay in one column.
function cell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function resolveRange(params: URLSearchParams): Range {
  const ps = params.get("period_start");
  const pe = params.get("period_end");
  if (isValidDate(ps) && isValidDate(pe)) return { start: ps, end: pe };
  return resolvePreset(parsePreset(params.get("preset")), new Date());
}

// GET /api/metrics/export?department=&period_start=&period_end= — CSV of the
// dashboard: label, value, origin, validation_status, health. Honest nulls: a
// metric with no value exports an empty cell, never 0. XLSX/PDF deferred.
export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return new Response("Not signed in.", { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const department = params.get("department") ?? "";
  if (!isDepartment(department)) {
    return new Response("Unknown department.", { status: 400 });
  }
  const rawBrand = params.get("brand_id");
  const brandId = rawBrand && rawBrand !== "shop" && rawBrand !== "" ? rawBrand : null;
  const range = resolveRange(params);

  const supabase = createServerSupabaseClient();
  const userNames = await getUserNames(supabase);
  const data = await getDashboard(supabase, {
    department,
    brandId,
    range,
    compareRange: null,
    userNames,
  });

  const headers = [
    "metric_key",
    "label",
    "category",
    "value",
    "unit",
    "origin",
    "validation_status",
    "health",
    "target_value",
    "entered_by",
    "updated_at",
  ];
  const lines = [headers.map(cell).join(",")];
  for (const m of data.metrics) {
    lines.push(
      [
        m.metric_key,
        m.label,
        m.category ?? "",
        // Honest empty for a missing value — no fabricated 0.
        m.display_value ?? "",
        m.unit ?? "",
        m.display_origin ? ORIGIN_LABEL[m.display_origin] : "",
        VALIDATION_LABEL[m.validation_status],
        m.health ?? "",
        m.target_value ?? "",
        m.entered_by_name ?? "",
        m.updated_at ?? "",
      ]
        .map(cell)
        .join(",")
    );
  }
  const csv = lines.join("\r\n");

  const label = DEPARTMENT_LABELS[department as Department].replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const filename = `metrics_${label}_${range.start}_${range.end}.csv`;

  // Audit the export to the shared action_audit trail (best-effort) — module,
  // format, and what was scoped, never the exported rows — for the leadership
  // Security Events view.
  await auditDataExport(supabase, {
    module: "metrics",
    format: "csv",
    department,
    brand_id: brandId,
    period_start: range.start,
    period_end: range.end,
    row_count: data.metrics.length,
  });

  // Part D: also record it as a security signal in security_events, which the
  // anomaly monitor reads for unusual-export-volume detection.
  void recordSecurityEvent(supabase, {
    orgId: profile.org_id,
    userId: profile.id,
    eventType: "data_export",
    severity: "info",
    detail: { kind: "metrics_csv", department, rows: data.metrics.length, range },
  });

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv;charset=utf-8;",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
