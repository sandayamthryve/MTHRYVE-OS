import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { auditDataExport } from "@/lib/security/audit";
import { loadLookups, loadExpenses, summarize } from "@/lib/expenses/data";
import { parseExpenseFiltersFromURL } from "@/lib/expenses/filters";
import { EXPORT_COLUMNS, toExportRows } from "@/lib/expenses/export";
import { canManageExpense } from "@/lib/expenses/types";

// GET /api/expenses/export/csv?<filters> — CSV of the filtered expense ledger.
// Same filter parser as the records view, so an export matches exactly what's on
// screen. ceo/coo only (RLS also scopes every row). Honest nulls: an unknown
// value is an empty cell, never a fabricated 0.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Wrap and escape a CSV cell so values with commas/quotes/newlines stay in one
// column (same convention as the metrics export).
function cell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return new Response("Not signed in.", { status: 401 });
  if (!canManageExpense(profile.role)) return new Response("Forbidden.", { status: 403 });

  const params = new URL(request.url).searchParams;
  const filters = parseExpenseFiltersFromURL(params);

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as { from: (t: string) => any };
  const lookups = await loadLookups(db, profile.org_id);
  const rows = await loadExpenses(db, lookups, filters, 50000);

  const lines = [EXPORT_COLUMNS.map(cell).join(",")];
  for (const r of toExportRows(rows)) lines.push(r.map(cell).join(","));
  const csv = lines.join("\r\n");

  await auditDataExport(supabase, {
    module: "expenses",
    format: "csv",
    filters: filters as unknown as Record<string, unknown>,
    row_count: rows.length,
    total_gross: summarize(rows).totalGross,
  });

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv;charset=utf-8;",
      "content-disposition": `attachment; filename="expenses_export.csv"`,
      "cache-control": "no-store",
    },
  });
}
