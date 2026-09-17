import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { auditDataExport } from "@/lib/security/audit";
import { loadLookups, loadExpenses, summarize } from "@/lib/expenses/data";
import { parseExpenseFiltersFromURL } from "@/lib/expenses/filters";
import { EXPORT_COLUMNS, MONEY_COLUMN_INDEXES, toExportRows } from "@/lib/expenses/export";
import { canManageExpense } from "@/lib/expenses/types";

// GET /api/expenses/export/xlsx?<filters> — server-generated .xlsx of the
// filtered expense ledger (Node runtime for exceljs). Same filter parser as the
// records view, so the workbook matches what's on screen. ceo/coo only; RLS
// scopes every row. An empty result still yields a valid workbook (headers + a
// totals row), never an error.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARIAL = { name: "Arial", size: 10 } as const;
const MONEY_FMT = "#,##0.00";

export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canManageExpense(profile.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const filters = parseExpenseFiltersFromURL(new URL(request.url).searchParams);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as { from: (t: string) => any };
  const lookups = await loadLookups(db, profile.org_id);
  const rows = await loadExpenses(db, lookups, filters, 50000);
  const data = toExportRows(rows);
  const summary = summarize(rows);
  const moneyCols = new Set(MONEY_COLUMN_INDEXES.map((i) => i + 1)); // 1-based

  const wb = new ExcelJS.Workbook();
  wb.creator = "Mthryve OS";
  const ws = wb.addWorksheet("Expenses");

  ws.columns = EXPORT_COLUMNS.map((c) => ({
    header: c,
    width: c.length < 10 ? 12 : Math.min(28, c.length + 6),
  }));
  const head = ws.getRow(1);
  head.font = { ...ARIAL, bold: true };
  head.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } };
  });

  for (const r of data) {
    const row = ws.addRow(r);
    row.font = ARIAL;
    for (const idx of moneyCols) {
      const cell = row.getCell(idx);
      // Cells are strings; coerce numeric money cells so Excel sums them. An
      // empty cell (honest null) stays blank, never 0.
      const raw = cell.value;
      if (raw != null && raw !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          cell.value = n;
          cell.numFmt = MONEY_FMT;
        }
      }
    }
  }

  // Totals row (excludes cancelled — matches the dashboard/records math).
  ws.addRow([]);
  const totalRow = ws.addRow([
    "TOTAL (excl. cancelled)",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    summary.count === 0 ? "" : summary.totalGross,
    summary.count === 0 ? "" : summary.vat,
    summary.count === 0 ? "" : summary.net,
  ]);
  totalRow.font = { ...ARIAL, bold: true };
  for (const idx of moneyCols) {
    const c = totalRow.getCell(idx);
    if (typeof c.value === "number") c.numFmt = MONEY_FMT;
  }

  const buffer = await wb.xlsx.writeBuffer();

  await auditDataExport(supabase, {
    module: "expenses",
    format: "xlsx",
    filters: filters as unknown as Record<string, unknown>,
    row_count: rows.length,
    total_gross: summary.totalGross,
  });

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="expenses_export.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
