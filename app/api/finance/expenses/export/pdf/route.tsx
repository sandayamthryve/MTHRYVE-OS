import { NextResponse } from "next/server";
import React from "react";
import { Document, Page, View, Text, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { auditDataExport } from "@/lib/security/audit";
import { loadLookups, loadExpenses, summarize } from "@/lib/expenses/data";
import { parseExpenseFiltersFromURL } from "@/lib/expenses/filters";
import { toExportRows } from "@/lib/expenses/export";
import { canManageExpense } from "@/lib/expenses/types";

// GET /api/expenses/export/pdf?<filters> — server-generated PDF of the filtered
// expense ledger, A4 landscape, clean black-on-white. Node runtime for
// @react-pdf/renderer. Same filter parser as the records view, so the document
// matches what's on screen. ceo/coo only; RLS scopes every row. An empty result
// still renders a valid document (headers + a "no rows" note).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INK = "#111111";
const MUTED = "#555555";
const HAIRLINE = "#c8c8c8";

// A compact subset of columns for the printed page (the full column set lives in
// the Excel/CSV exports; a landscape PDF stays readable with the key fields).
type PdfCol = { label: string; w: number; src: number; money?: boolean };
const PDF_COLS: PdfCol[] = [
  { label: "Code", w: 66, src: 0 },
  { label: "Date", w: 52, src: 1 },
  { label: "Type", w: 34, src: 2 },
  { label: "Category", w: 90, src: 4 },
  { label: "Vendor", w: 90, src: 5 },
  { label: "Brand", w: 70, src: 6 },
  { label: "Gross", w: 62, src: 10, money: true },
  { label: "VAT", w: 52, src: 11, money: true },
  { label: "Net", w: 62, src: 12, money: true },
  { label: "Pay", w: 56, src: 13 },
  { label: "Status", w: 52, src: 14 },
] as const;

const styles = StyleSheet.create({
  page: { paddingTop: 26, paddingBottom: 26, paddingHorizontal: 22, fontSize: 7.5, color: INK },
  headerBand: {
    borderBottomWidth: 2,
    borderBottomColor: INK,
    paddingBottom: 6,
    marginBottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  title: { fontSize: 14, fontWeight: 700 },
  sub: { fontSize: 8, color: MUTED },
  headRow: { flexDirection: "row", backgroundColor: "#f0f0f0", borderBottomWidth: 1, borderBottomColor: HAIRLINE },
  headCell: { paddingVertical: 3, paddingHorizontal: 3, fontWeight: 700 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: HAIRLINE },
  cell: { paddingVertical: 2.5, paddingHorizontal: 3 },
  totals: { marginTop: 8, flexDirection: "row", justifyContent: "flex-end", gap: 18 },
  totalItem: { fontSize: 9, fontWeight: 700 },
  note: { marginTop: 14, fontSize: 9, color: MUTED },
});

function peso(v: string): string {
  if (v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(n)
    : v;
}

export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canManageExpense(profile.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const filters = parseExpenseFiltersFromURL(new URL(request.url).searchParams);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as { from: (t: string) => any };
  const lookups = await loadLookups(db, profile.org_id);
  const rows = await loadExpenses(db, lookups, filters, 5000);
  const data = toExportRows(rows);
  const summary = summarize(rows);

  const rangeLabel =
    filters.start || filters.end ? `${filters.start ?? "…"} → ${filters.end ?? "…"}` : "All dates";

  const doc = (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page} wrap>
        <View style={styles.headerBand}>
          <View>
            <Text style={styles.title}>Expense Ledger</Text>
            <Text style={styles.sub}>{rangeLabel}</Text>
          </View>
          <View>
            <Text style={styles.sub}>Mthryve Marketing Inc.</Text>
            <Text style={styles.sub}>{rows.length} rows</Text>
          </View>
        </View>

        <View style={styles.headRow} fixed>
          {PDF_COLS.map((c) => (
            <Text
              key={c.label}
              style={{ ...styles.headCell, width: c.w, textAlign: c.money ? "right" : "left" }}
            >
              {c.label}
            </Text>
          ))}
        </View>

        {data.length === 0 ? (
          <Text style={styles.note}>No expenses match these filters.</Text>
        ) : (
          data.map((r, i) => (
            <View style={styles.row} key={i} wrap={false}>
              {PDF_COLS.map((c) => {
                const raw = r[c.src] ?? "";
                return (
                  <Text
                    key={c.label}
                    style={{ ...styles.cell, width: c.w, textAlign: c.money ? "right" : "left" }}
                  >
                    {c.money ? peso(raw) : raw || "—"}
                  </Text>
                );
              })}
            </View>
          ))
        )}

        {data.length > 0 && (
          <View style={styles.totals}>
            <Text style={styles.totalItem}>
              VAT input: {summary.count === 0 ? "—" : peso(String(summary.vat))}
            </Text>
            <Text style={styles.totalItem}>
              Total (excl. cancelled): {summary.count === 0 ? "—" : peso(String(summary.totalGross))}
            </Text>
          </View>
        )}
      </Page>
    </Document>
  );

  const buffer = await renderToBuffer(doc);

  await auditDataExport(supabase, {
    module: "expenses",
    format: "pdf",
    filters: filters as unknown as Record<string, unknown>,
    row_count: rows.length,
    total_gross: summary.totalGross,
  });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="expenses_export.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
