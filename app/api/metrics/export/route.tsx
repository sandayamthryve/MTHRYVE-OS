import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import React from "react";
import { Document, Page, View, Text, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth/session";
import { auditDataExport } from "@/lib/security/audit";
import {
  loadReviewData,
  formatMetricValue,
  formatTarget,
  formatVariance,
  HEALTH_LABEL,
  VALIDATION_LABEL,
  DASH,
  type ReviewData,
  type MetricEntry,
} from "@/lib/metrics/review";
import type { BriefPayload } from "@/lib/briefings/account-review";

// GET /api/metrics/export?format=csv|xlsx|pdf&department=&brand_id?=&period_start=&period_end=&brief_id?=
//
// One endpoint, three formats, over the SAME grounded review data as the AI
// brief (lib/metrics/review) plus, optionally, a persisted brief (brief_id). The
// metrics table carries provenance (origin, validation status) and honest nulls
// ("—", never a fabricated 0). xlsx adds a Brief sheet; pdf renders the header,
// metrics table, health rollup, and executive summary server-side. RLS scopes
// every row to the caller's org.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };
type Format = "csv" | "xlsx" | "pdf";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The metrics-table columns, shared by all three formats.
const COLUMNS: { header: string; get: (e: MetricEntry) => string }[] = [
  { header: "Metric", get: (e) => e.label },
  { header: "Value", get: (e) => formatMetricValue(e) },
  { header: "Target", get: (e) => formatTarget(e) },
  { header: "Variance", get: (e) => formatVariance(e) },
  { header: "Health", get: (e) => HEALTH_LABEL[e.health] },
  { header: "Validation", get: (e) => VALIDATION_LABEL[e.validation_status] },
  { header: "Origin", get: (e) => e.origin },
];

export async function GET(req: NextRequest) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase() as Format;
  if (!["csv", "xlsx", "pdf"].includes(format)) {
    return NextResponse.json({ error: "format must be csv, xlsx or pdf" }, { status: 400 });
  }
  const department = (url.searchParams.get("department") ?? "").trim();
  const period_start = (url.searchParams.get("period_start") ?? "").trim();
  const period_end = (url.searchParams.get("period_end") ?? "").trim();
  const brand_id = (url.searchParams.get("brand_id") ?? "").trim() || null;
  const brief_id = (url.searchParams.get("brief_id") ?? "").trim() || null;
  if (!department || !DATE_RE.test(period_start) || !DATE_RE.test(period_end)) {
    return NextResponse.json({ error: "department, period_start and period_end (YYYY-MM-DD) are required" }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const isOrgScope = department.toLowerCase() === "organization" || department.toLowerCase() === "all departments";
  let department_id: string | null = null;
  if (!isOrgScope) {
    const { data: dept } = await db.from("departments").select("id").ilike("name", department).maybeSingle();
    department_id = (dept as { id?: string } | null)?.id ?? null;
    if (!department_id) return NextResponse.json({ error: `unknown department "${department}"` }, { status: 400 });
  }

  const review = await loadReviewData(db, { department, department_id, brand_id, period_start, period_end });

  // Optional persisted brief (its Brief sheet / executive summary).
  let brief: (BriefPayload & { scope?: { brand_name?: string | null } }) | null = null;
  if (brief_id) {
    const { data } = await db.from("account_review_briefs").select("payload").eq("id", brief_id).maybeSingle();
    brief = ((data as { payload?: any } | null)?.payload as BriefPayload) ?? null;
  }

  const slug = slugify(`${department}${review.scope.brand_name ? `-${review.scope.brand_name}` : ""}`);
  const base = `account-review_${slug}_${period_start}_${period_end}`;

  // Audit the export (best-effort) — module, format, and scope, never the rows.
  await auditDataExport(supabase, {
    module: "account_review",
    format,
    department,
    brand_id,
    brief_id,
    period_start,
    period_end,
  });

  if (format === "csv") {
    const csv = buildCsv(review);
    return fileResponse(csv, `${base}.csv`, "text/csv;charset=utf-8;");
  }
  if (format === "xlsx") {
    const buffer = await buildXlsx(review, brief);
    return fileResponse(
      buffer,
      `${base}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  }
  // pdf
  const buffer = await buildPdf(review, brief);
  return fileResponse(buffer, `${base}.pdf`, "application/pdf");
}

function fileResponse(body: string | Buffer | Uint8Array, filename: string, contentType: string) {
  return new NextResponse(body as any, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "org";
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function cell(v: string | number): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function buildCsv(review: ReviewData): string {
  const lines: string[] = [];
  lines.push(COLUMNS.map((c) => cell(c.header)).join(","));
  for (const e of review.entries) {
    lines.push(COLUMNS.map((c) => cell(c.get(e))).join(","));
  }
  return lines.join("\r\n");
}

// ── XLSX ──────────────────────────────────────────────────────────────────────

const ARIAL = { name: "Arial", size: 10 } as const;
const THIN = { style: "thin" as const, color: { argb: "FFD0D0D0" } };
const ALL_BORDERS = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const TEAL = "FF0F766E";

async function buildXlsx(
  review: ReviewData,
  brief: BriefPayload | null
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mthryve OS";

  // --- Metrics sheet ---
  const ws = wb.addWorksheet("Metrics");
  ws.columns = [
    { width: 30 }, { width: 18 }, { width: 16 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 40 },
  ];
  const title = ws.getCell("A1");
  title.value = `Account Review — ${review.scope.department}${review.scope.brand_name ? ` · ${review.scope.brand_name}` : ""}`;
  title.font = { name: "Arial", size: 14, bold: true };
  ws.mergeCells("A1:G1");
  const sub = ws.getCell("A2");
  sub.value = `Period ${review.scope.period_start} → ${review.scope.period_end} · Health: ${review.rollup.label}${review.rollup.score !== null ? ` (${review.rollup.score}/100)` : ""}`;
  sub.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF666666" } };
  ws.mergeCells("A2:G2");
  ws.addRow([]);

  const header = ws.addRow(COLUMNS.map((c) => c.header));
  header.eachCell((c) => {
    c.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TEAL } };
    c.alignment = { vertical: "middle", horizontal: "left" };
    c.border = ALL_BORDERS;
  });
  for (const e of review.entries) {
    const r = ws.addRow(COLUMNS.map((c) => c.get(e)));
    r.eachCell({ includeEmpty: true }, (c) => {
      c.font = ARIAL;
      c.alignment = { vertical: "top", wrapText: true };
      c.border = ALL_BORDERS;
    });
  }
  ws.views = [{ state: "frozen", ySplit: 4 }];

  if (review.mismatch_flags.length) {
    ws.addRow([]);
    const fh = ws.addRow(["Data quality flags"]);
    fh.getCell(1).font = { name: "Arial", size: 11, bold: true };
    for (const f of review.mismatch_flags) {
      const fr = ws.addRow([f]);
      fr.getCell(1).font = ARIAL;
      fr.getCell(1).alignment = { wrapText: true };
    }
  }

  // --- Brief sheet ---
  const bs = wb.addWorksheet("Brief");
  bs.columns = [{ width: 26 }, { width: 90 }];
  const bTitle = bs.getCell("A1");
  bTitle.value = "AI Account Review Brief";
  bTitle.font = { name: "Arial", size: 14, bold: true };
  bs.mergeCells("A1:B1");

  if (!brief) {
    bs.getCell("A3").value = "No brief was attached to this export.";
    bs.getCell("A3").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF666666" } };
  } else {
    let row = 3;
    const kv = (label: string, value: string) => {
      const rr = bs.getRow(row);
      rr.getCell(1).value = label;
      rr.getCell(1).font = { name: "Arial", size: 10, bold: true };
      rr.getCell(1).alignment = { vertical: "top" };
      rr.getCell(2).value = value || DASH;
      rr.getCell(2).font = ARIAL;
      rr.getCell(2).alignment = { vertical: "top", wrapText: true };
      row++;
    };
    const section = (label: string) => {
      const rr = bs.getRow(row);
      rr.getCell(1).value = label;
      rr.getCell(1).font = { name: "Arial", size: 11, bold: true, color: { argb: TEAL } };
      row++;
    };

    section("Executive summary");
    kv("Summary", brief.executive_summary);
    kv("Grounded", brief.meta?.grounded ? `Yes — ${brief.meta.metrics_with_data}/${brief.meta.metrics_total} real metrics${brief.meta.model ? ` · ${brief.meta.model}` : ""}` : `No${brief.meta?.note ? ` — ${brief.meta.note}` : ""}`);
    row++;

    section("Overall performance");
    kv("Sales trend", brief.overall_performance.sales_trend);
    kv("Traffic trend", brief.overall_performance.traffic_trend);
    kv("Conversion trend", brief.overall_performance.conversion_trend);
    kv("Operational efficiency", brief.overall_performance.operational_efficiency);
    row++;

    section("Highlights");
    if (brief.highlights.length) brief.highlights.forEach((h, i) => kv(`#${i + 1}`, h));
    else kv("—", "No highlights the data supports.");
    row++;

    section("Concerns");
    if (brief.concerns.length) brief.concerns.forEach((c, i) => kv(`#${i + 1}`, c));
    else kv("—", "No concerns the data supports.");
    row++;

    section("Recommendations (advisory — require approval)");
    if (brief.recommendations.length) {
      brief.recommendations.forEach((r, i) =>
        kv(`#${i + 1} [${r.priority}] → ${r.target_department}`, `${r.action}${r.rationale ? ` — ${r.rationale}` : ""}`)
      );
    } else {
      kv("—", "No recommendations.");
    }
    row++;

    section("Scenarios (best / base / worst — grounded projections)");
    const scenarios = brief.scenarios ?? [];
    if (scenarios.length) {
      if (brief.scenario_meta?.low_data) {
        kv("Note", `Limited data — projections are directional; confidence capped.${brief.scenario_meta.note ? ` ${brief.scenario_meta.note}` : ""}`);
      }
      scenarios.forEach((sc) =>
        kv(
          `${sc.name.toUpperCase()} · ${Math.round((sc.confidence ?? 0) * 100)}% conf.`,
          `Premise: ${sc.premise} Outcome: ${sc.projected_outcome}${sc.drivers.length ? ` · Drivers: ${sc.drivers.join(", ")}` : ""}`
        )
      );
    } else {
      kv("—", brief.scenario_meta?.note ?? "No grounded scenarios for this scope.");
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

// ── PDF ───────────────────────────────────────────────────────────────────────

const INK = "#111111";
const MUTED = "#555555";
const HAIRLINE = "#c8c8c8";
const TEAL_HEX = "#0f766e";

const s = StyleSheet.create({
  page: { paddingTop: 32, paddingBottom: 32, paddingHorizontal: 28, fontSize: 9, color: INK },
  headerBand: { borderBottomWidth: 2, borderBottomColor: INK, paddingBottom: 6, marginBottom: 12 },
  h1: { fontSize: 16, fontWeight: 700 },
  sub: { fontSize: 9, color: MUTED, marginTop: 3 },
  rollup: { marginTop: 6, fontSize: 9, color: TEAL_HEX, fontWeight: 700 },
  sectionTitle: { fontSize: 11, fontWeight: 700, marginTop: 14, marginBottom: 5, color: TEAL_HEX },
  row: { flexDirection: "row" },
  th: { fontSize: 8, fontWeight: 700, color: "#ffffff", backgroundColor: TEAL_HEX, padding: 4, borderWidth: 0.5, borderColor: HAIRLINE },
  td: { fontSize: 8, padding: 4, borderWidth: 0.5, borderColor: HAIRLINE },
  cMetric: { width: "26%" },
  cVal: { width: "15%" },
  cTgt: { width: "13%" },
  cVar: { width: "11%" },
  cHealth: { width: "12%" },
  cValid: { width: "23%" },
  para: { fontSize: 9, lineHeight: 1.35, marginBottom: 4 },
  kvLabel: { fontSize: 9, fontWeight: 700 },
  bullet: { fontSize: 9, lineHeight: 1.35, marginBottom: 3 },
  flag: { fontSize: 8, color: "#9a3412", marginBottom: 2 },
  recTitle: { fontSize: 9, fontWeight: 700 },
  recMeta: { fontSize: 7.5, color: MUTED, marginBottom: 3 },
});

function BriefPdf({ review, brief }: { review: ReviewData; brief: BriefPayload | null }) {
  const { scope, entries, rollup, mismatch_flags } = review;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <View style={s.headerBand}>
          <Text style={s.h1}>
            Account Review — {scope.department}
            {scope.brand_name ? ` · ${scope.brand_name}` : ""}
          </Text>
          <Text style={s.sub}>
            Period {scope.period_start} → {scope.period_end} · M-THRYVE OS
          </Text>
          <Text style={s.rollup}>
            Health: {rollup.label}
            {rollup.score !== null ? ` (${rollup.score}/100 over ${rollup.scored} scored metric${rollup.scored === 1 ? "" : "s"})` : ""} · {rollup.good} on track / {rollup.watch} watch / {rollup.risk} at risk / {rollup.none} no-data
          </Text>
        </View>

        <Text style={s.sectionTitle}>Metrics</Text>
        <View style={s.row}>
          <Text style={[s.th, s.cMetric]}>Metric</Text>
          <Text style={[s.th, s.cVal]}>Value</Text>
          <Text style={[s.th, s.cTgt]}>Target</Text>
          <Text style={[s.th, s.cVar]}>Var.</Text>
          <Text style={[s.th, s.cHealth]}>Health</Text>
          <Text style={[s.th, s.cValid]}>Validation</Text>
        </View>
        {entries.map((e) => (
          <View style={s.row} key={e.key} wrap={false}>
            <Text style={[s.td, s.cMetric]}>{e.label}</Text>
            <Text style={[s.td, s.cVal]}>{formatMetricValue(e)}</Text>
            <Text style={[s.td, s.cTgt]}>{formatTarget(e)}</Text>
            <Text style={[s.td, s.cVar]}>{formatVariance(e)}</Text>
            <Text style={[s.td, s.cHealth]}>{HEALTH_LABEL[e.health]}</Text>
            <Text style={[s.td, s.cValid]}>{VALIDATION_LABEL[e.validation_status]}</Text>
          </View>
        ))}

        {mismatch_flags.length > 0 && (
          <View>
            <Text style={s.sectionTitle}>Data quality flags</Text>
            {mismatch_flags.map((f, i) => (
              <Text style={s.flag} key={i}>
                • {f}
              </Text>
            ))}
          </View>
        )}

        <Text style={s.sectionTitle}>Executive summary</Text>
        {brief ? (
          <>
            <Text style={s.para}>{brief.executive_summary || DASH}</Text>
            <Text style={s.recMeta}>
              {brief.meta?.grounded
                ? `Grounded on ${brief.meta.metrics_with_data}/${brief.meta.metrics_total} real metrics${brief.meta.model ? ` · ${brief.meta.model}` : ""}`
                : `Not model-grounded${brief.meta?.note ? ` — ${brief.meta.note}` : ""}`}
            </Text>

            <Text style={s.sectionTitle}>Overall performance</Text>
            <Text style={s.para}>
              <Text style={s.kvLabel}>Sales: </Text>
              {brief.overall_performance.sales_trend}
            </Text>
            <Text style={s.para}>
              <Text style={s.kvLabel}>Traffic: </Text>
              {brief.overall_performance.traffic_trend}
            </Text>
            <Text style={s.para}>
              <Text style={s.kvLabel}>Conversion: </Text>
              {brief.overall_performance.conversion_trend}
            </Text>
            <Text style={s.para}>
              <Text style={s.kvLabel}>Operational efficiency: </Text>
              {brief.overall_performance.operational_efficiency}
            </Text>

            {brief.highlights.length > 0 && (
              <>
                <Text style={s.sectionTitle}>Highlights</Text>
                {brief.highlights.map((h, i) => (
                  <Text style={s.bullet} key={i}>
                    • {h}
                  </Text>
                ))}
              </>
            )}

            {brief.concerns.length > 0 && (
              <>
                <Text style={s.sectionTitle}>Concerns</Text>
                {brief.concerns.map((c, i) => (
                  <Text style={s.bullet} key={i}>
                    • {c}
                  </Text>
                ))}
              </>
            )}

            {brief.recommendations.length > 0 && (
              <>
                <Text style={s.sectionTitle}>Recommendations (advisory — require human approval)</Text>
                {brief.recommendations.map((r, i) => (
                  <View key={i} wrap={false}>
                    <Text style={s.recTitle}>
                      {i + 1}. {r.action}
                    </Text>
                    <Text style={s.recMeta}>
                      {r.priority} priority · target: {r.target_department}
                    </Text>
                    {r.rationale ? <Text style={s.para}>{r.rationale}</Text> : null}
                  </View>
                ))}
              </>
            )}

            {(brief.scenarios ?? []).length > 0 && (
              <>
                <Text style={s.sectionTitle}>Scenarios (best / base / worst — grounded projections)</Text>
                {brief.scenario_meta?.low_data && (
                  <Text style={s.flag}>
                    • Limited data — projections are directional and confidence is capped honestly.
                    {brief.scenario_meta.note ? ` ${brief.scenario_meta.note}` : ""}
                  </Text>
                )}
                {(brief.scenarios ?? []).map((sc, i) => (
                  <View key={i} wrap={false}>
                    <Text style={s.recTitle}>
                      {sc.name.toUpperCase()} case · {Math.round((sc.confidence ?? 0) * 100)}% confidence
                    </Text>
                    {sc.drivers.length > 0 ? (
                      <Text style={s.recMeta}>Drivers: {sc.drivers.join(", ")}</Text>
                    ) : null}
                    <Text style={s.para}>
                      <Text style={s.kvLabel}>Premise: </Text>
                      {sc.premise}
                    </Text>
                    <Text style={s.para}>
                      <Text style={s.kvLabel}>Projected outcome: </Text>
                      {sc.projected_outcome}
                    </Text>
                  </View>
                ))}
              </>
            )}
          </>
        ) : (
          <Text style={s.para}>No brief attached to this export — the grounded metrics above are the record.</Text>
        )}
      </Page>
    </Document>
  );
}

async function buildPdf(review: ReviewData, brief: BriefPayload | null): Promise<Buffer> {
  return renderToBuffer(<BriefPdf review={review} brief={brief} />);
}
