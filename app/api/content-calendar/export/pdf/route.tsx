import { NextRequest, NextResponse } from "next/server";
import React from "react";
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
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
  WEEKDAY_HEADERS,
  type CalendarData,
} from "@/lib/content/calendar-export";

// Server-generated PDF of the Content Calendar (month grid + a Content List
// page), A4 landscape, clean black-on-white with hairline borders. Node runtime
// for @react-pdf/renderer's renderToBuffer; the session is read via
// @supabase/ssr so RLS scopes every row to the caller's org. An empty month
// still renders a valid document with an empty grid.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HAIRLINE = "#c8c8c8";
const INK = "#111111";
const MUTED = "#555555";

const styles = StyleSheet.create({
  page: { paddingTop: 28, paddingBottom: 28, paddingHorizontal: 24, fontSize: 8, color: INK },
  headerBand: {
    borderBottomWidth: 2,
    borderBottomColor: INK,
    paddingBottom: 6,
    marginBottom: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  brandTitle: { fontSize: 15, fontWeight: 700 },
  headerRight: { textAlign: "right" },
  headerBrand: { fontSize: 10, fontWeight: 700 },
  headerMonth: { fontSize: 9, color: MUTED },

  weekRowHead: { flexDirection: "row" },
  weekdayCell: {
    flex: 1,
    backgroundColor: "#f0f0f0",
    borderWidth: 0.5,
    borderColor: HAIRLINE,
    paddingVertical: 3,
    textAlign: "center",
    fontSize: 8,
    fontWeight: 700,
  },
  weekRow: { flexDirection: "row", minHeight: 78 },
  dayCell: {
    flex: 1,
    borderWidth: 0.5,
    borderColor: HAIRLINE,
    padding: 3,
  },
  dayCellEmpty: {
    flex: 1,
    borderWidth: 0.5,
    borderColor: HAIRLINE,
    backgroundColor: "#fafafa",
  },
  dayNum: { fontSize: 8, color: MUTED, marginBottom: 2, textAlign: "right" },
  item: { marginBottom: 2 },
  itemTitle: { fontSize: 7.5, lineHeight: 1.15 },
  tag: { fontSize: 6, color: MUTED },

  listTitle: { fontSize: 13, fontWeight: 700, marginBottom: 8 },
  tRow: { flexDirection: "row" },
  tHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK },
  tCell: {
    borderRightWidth: 0.5,
    borderRightColor: HAIRLINE,
    borderBottomWidth: 0.5,
    borderBottomColor: HAIRLINE,
    paddingVertical: 2.5,
    paddingHorizontal: 3,
    fontSize: 7.5,
  },
  tHeadCell: { fontWeight: 700, fontSize: 7.5, backgroundColor: "#f0f0f0" },
  emptyNote: { fontSize: 9, color: MUTED, marginTop: 12 },
});

// Content List column layout (flex weights sum is arbitrary; landscape A4).
const LIST_COLS: { header: string; flex: number; get: (r: CalendarData["rows"][number]) => string }[] = [
  { header: "Publish date", flex: 1.1, get: (r) => r.publish_date ?? "" },
  { header: "Brand", flex: 1.4, get: (r) => r.brand },
  { header: "Title", flex: 3, get: (r) => r.title },
  { header: "Type", flex: 1, get: (r) => typeLabel(r.content_type) },
  { header: "Status", flex: 1, get: (r) => statusLabel(r.status) },
  { header: "Platform", flex: 1.2, get: (r) => r.platform },
  { header: "Assignee", flex: 1.6, get: (r) => r.assignee },
];

function CalendarDoc({ data }: { data: CalendarData }) {
  const weeks = buildWeeks(data.month);

  return (
    <Document title={`Content Calendar — ${data.brandName} — ${data.monthName}`}>
      {/* Page 1 — month grid */}
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.headerBand}>
          <Text style={styles.brandTitle}>MTHRYVE — Content Calendar</Text>
          <View style={styles.headerRight}>
            <Text style={styles.headerBrand}>{data.brandName}</Text>
            <Text style={styles.headerMonth}>{data.monthName}</Text>
          </View>
        </View>

        <View style={styles.weekRowHead}>
          {WEEKDAY_HEADERS.map((w) => (
            <Text key={w} style={styles.weekdayCell}>
              {w}
            </Text>
          ))}
        </View>

        {weeks.map((week, wi) => (
          <View key={wi} style={styles.weekRow} wrap={false}>
            {week.map((day, di) => {
              if (day === null) {
                return <View key={di} style={styles.dayCellEmpty} />;
              }
              const items = data.byDay.get(day) ?? [];
              return (
                <View key={di} style={styles.dayCell}>
                  <Text style={styles.dayNum}>{day}</Text>
                  {items.map((it) => (
                    <View key={it.id} style={styles.item}>
                      <Text style={styles.itemTitle}>{it.title}</Text>
                      <Text style={styles.tag}>
                        {typeLabel(it.content_type)} · {statusLabel(it.status)}
                      </Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        ))}
      </Page>

      {/* Page 2 — content list */}
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.listTitle}>
          Content List — {data.brandName} — {data.monthName}
        </Text>

        <View style={styles.tHead} fixed>
          {LIST_COLS.map((c) => (
            <Text key={c.header} style={[styles.tCell, styles.tHeadCell, { flex: c.flex }]}>
              {c.header}
            </Text>
          ))}
        </View>

        {data.rows.length === 0 ? (
          <Text style={styles.emptyNote}>No content items for this selection.</Text>
        ) : (
          data.rows.map((r) => (
            <View key={r.id} style={styles.tRow} wrap={false}>
              {LIST_COLS.map((c) => (
                <Text key={c.header} style={[styles.tCell, { flex: c.flex }]}>
                  {c.get(r)}
                </Text>
              ))}
            </View>
          ))
        )}
      </Page>
    </Document>
  );
}

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
  const buffer = await renderToBuffer(<CalendarDoc data={data} />);
  const filename = `content-calendar_${brandSlug(data.brand)}_${month}.pdf`;

  // Audit the export (best-effort) — module, format, and scope only.
  await auditDataExport(supabase, {
    module: "content_calendar",
    format: "pdf",
    brand: brandParam,
    month,
  });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
