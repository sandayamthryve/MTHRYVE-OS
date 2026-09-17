import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { auditDataExport } from "@/lib/security/audit";
import {
  loadCalendarData,
  isMonth,
  currentMonth,
  buildWeeks,
  brandSlug,
  typeLabel,
  statusLabel,
  SUMMARY_STATUSES,
  CONTENT_TYPES,
  STATUS_LABEL,
  TYPE_LABEL,
  WEEKDAY_HEADERS,
  type CalendarData,
  type CalendarRow,
} from "@/lib/content/calendar-export";

// Server-generated .xlsx of the Content Calendar (Summary / Calendar / Content
// List). Node runtime for exceljs; the session is read via @supabase/ssr so RLS
// scopes every row to the caller's org. An empty month still produces a valid
// workbook (headers + an empty grid), never an error.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARIAL = { name: "Arial", size: 10 } as const;
const THIN = { style: "thin" as const, color: { argb: "FFD0D0D0" } };
const ALL_BORDERS = { top: THIN, left: THIN, bottom: THIN, right: THIN };

export async function GET(req: NextRequest) {
  const supabase = createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const url = new URL(req.url);
  const brandParam = (url.searchParams.get("brand") ?? "all").trim() || "all";
  const monthParam = (url.searchParams.get("month") ?? "").trim();
  const month = isMonth(monthParam) ? monthParam : currentMonth();

  const data = await loadCalendarData(supabase, brandParam, month);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Mthryve OS";
  buildSummarySheet(wb, data);
  buildCalendarSheet(wb, data);
  buildListSheet(wb, data);

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `content-calendar_${brandSlug(data.brand)}_${month}.xlsx`;

  // Audit the export (best-effort) — module, format, and scope only.
  await auditDataExport(supabase, {
    module: "content_calendar",
    format: "xlsx",
    brand: brandParam,
    month,
  });

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// --- Summary ----------------------------------------------------------------
function buildSummarySheet(wb: ExcelJS.Workbook, data: CalendarData) {
  const ws = wb.addWorksheet("Summary");
  ws.columns = [{ width: 28 }, { width: 16 }];

  const title = ws.getCell("A1");
  title.value = `Mthryve Content Calendar — ${data.brandName} — ${data.monthName}`;
  title.font = { name: "Arial", size: 14, bold: true };
  ws.mergeCells("A1:B1");

  const gen = ws.getCell("A2");
  // Timestamp in the company timezone so it reads sensibly for the team.
  gen.value = `Generated ${new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date())} (Asia/Manila)`;
  gen.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF666666" } };
  ws.mergeCells("A2:B2");

  ws.getCell("A3").value = `Total items in list: ${data.rows.length}`;
  ws.getCell("A3").font = ARIAL;

  let row = 5;
  const sectionHeader = (label: string) => {
    const c = ws.getCell(`A${row}`);
    c.value = label;
    c.font = { name: "Arial", size: 11, bold: true };
    row += 1;
  };
  const countRow = (label: string, count: number) => {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = ARIAL;
    ws.getCell(`B${row}`).value = count;
    ws.getCell(`B${row}`).font = ARIAL;
    row += 1;
  };

  sectionHeader("By status");
  for (const s of SUMMARY_STATUSES) {
    countRow(STATUS_LABEL[s], data.rows.filter((r) => r.status === s).length);
  }
  row += 1;

  sectionHeader("By content type");
  for (const t of CONTENT_TYPES) {
    const count = data.rows.filter((r) => r.content_type === t).length;
    if (count > 0 || TYPE_LABEL[t]) countRow(TYPE_LABEL[t], count);
  }
}

// --- Calendar grid ----------------------------------------------------------
function buildCalendarSheet(wb: ExcelJS.Workbook, data: CalendarData) {
  const ws = wb.addWorksheet("Calendar");
  ws.properties.defaultRowHeight = 15;
  ws.columns = WEEKDAY_HEADERS.map(() => ({ width: 24 }));

  const titleRow = ws.addRow([
    `${data.brandName} — ${data.monthName}`,
  ]);
  titleRow.font = { name: "Arial", size: 13, bold: true };
  ws.mergeCells(1, 1, 1, 7);
  ws.addRow([]); // spacer

  // Weekday header row.
  const header = ws.addRow(WEEKDAY_HEADERS as unknown as string[]);
  header.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = ALL_BORDERS;
  });

  const weeks = buildWeeks(data.month);
  for (const week of weeks) {
    const values = week.map((day) => {
      if (day === null) return "";
      const items = data.byDay.get(day) ?? [];
      const lines = [String(day)];
      for (const it of items) {
        lines.push(`• ${it.title} [${typeLabel(it.content_type)} · ${statusLabel(it.status)}]`);
      }
      return lines.join("\n");
    });
    const r = ws.addRow(values);
    // Room for a day number plus a few stacked items; wrap does the rest.
    r.height = 84;
    r.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = ARIAL;
      cell.alignment = { wrapText: true, vertical: "top", horizontal: "left" };
      cell.border = ALL_BORDERS;
    });
  }
}

// --- Content List -----------------------------------------------------------
type ListCol = { header: string; width: number; get: (r: CalendarRow) => string };

const LIST_COLS: ListCol[] = [
  { header: "Publish date", width: 14, get: (r) => r.publish_date ?? "" },
  { header: "Brand", width: 18, get: (r) => r.brand },
  { header: "Title", width: 40, get: (r) => r.title },
  { header: "Content type", width: 14, get: (r) => typeLabel(r.content_type) },
  { header: "Status", width: 13, get: (r) => statusLabel(r.status) },
  { header: "Platform", width: 14, get: (r) => r.platform },
  { header: "Sales source", width: 14, get: (r) => r.sales_source },
  { header: "Pillar", width: 16, get: (r) => r.pillar },
  { header: "Assignee", width: 20, get: (r) => r.assignee },
  { header: "Canva URL", width: 30, get: (r) => r.canva_url },
  { header: "HeyGen URL", width: 30, get: (r) => r.heygen_url },
  { header: "CapCut URL", width: 30, get: (r) => r.capcut_url },
  { header: "Asset URL", width: 30, get: (r) => r.asset_url },
  { header: "Notes", width: 44, get: (r) => r.notes },
];

function buildListSheet(wb: ExcelJS.Workbook, data: CalendarData) {
  const ws = wb.addWorksheet("Content List");
  ws.columns = LIST_COLS.map((c) => ({ width: c.width }));

  const header = ws.addRow(LIST_COLS.map((c) => c.header));
  header.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = ALL_BORDERS;
  });

  for (const r of data.rows) {
    const row = ws.addRow(LIST_COLS.map((c) => c.get(r)));
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = ARIAL;
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = ALL_BORDERS;
    });
  }

  // Frozen header + filter across the full column span (even when empty).
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: LIST_COLS.length },
  };
}
