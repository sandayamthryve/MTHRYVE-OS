import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, StatTile, TableShell, Badge, rowClass, type BadgeTone } from "@/components/ui";
import { requireDepartment } from "@/lib/auth/session";
import { ECOMMERCE_OPS_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { pesoOrDash } from "@/lib/metrics/format";
import { OrderId } from "@/components/tiktok-orders/OrderId";

// /tiktok-orders — the individual TikTok order ledger. This is the surface TikTok
// App Review asked for: real store order IDs (18-digit, starting 57/58), pulled
// by the daily orders sync and landed one-row-per-order in public.tiktok_orders.
//
// DELIBERATELY SIMPLE (the brief says "no other features"): newest-first, 50 per
// page, order_id shown prominently and copyable. Reads are org-scoped by RLS;
// the route gate here narrows WHO reaches it — E-Commerce Ops + leadership.
// Bounded query — an exact count + .range() page window, never an unbounded scan.

export const dynamic = "force-dynamic";

const PER_PAGE = 50;

type SearchParams = { page?: string };

type Shim = { from: (t: string) => any };

type OrderRow = {
  id: string;
  shop_id: string;
  brand_id: string | null;
  order_id: string;
  status: string | null;
  amount: number | null;
  currency: string | null;
  order_created_at: string | null;
  synced_at: string;
};
type Brand = { id: string; name: string };

// TikTok order statuses vary by API version; tone defensively by keyword so a
// new/unknown status renders neutral rather than mislabelled.
function statusTone(status: string | null): BadgeTone {
  if (!status) return "muted";
  const s = status.toLowerCase();
  if (/cancel|refund|return|fail|reject/.test(s)) return "red";
  if (/complet|deliver|paid|settle/.test(s)) return "teal";
  if (/unpaid|await|pend|process|ship/.test(s)) return "amber";
  return "muted";
}
function statusLabel(status: string | null): string {
  if (!status) return "—";
  return status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Render a stored UTC instant as a stable, locale-free "YYYY-MM-DD HH:mm UTC".
function fmtInstant(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

function pageHref(page: number): string {
  return page <= 1 ? "/tiktok-orders" : `/tiktok-orders?page=${page}`;
}

export default async function TikTokOrdersPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  // E-Commerce Ops + leadership reach the page; RLS scopes the rows to the org.
  const profile = await requireModule("/tiktok-orders");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const pageNum = Math.max(1, Number.parseInt(searchParams?.page ?? "1", 10) || 1);
  const from = (pageNum - 1) * PER_PAGE;
  const to = from + PER_PAGE - 1;

  // Bounded read: exact count for an honest pager + a single page window.
  // Newest first; rows with no create time sort last, not first.
  const { data, count } = await db
    .from("tiktok_orders")
    .select(
      "id, shop_id, brand_id, order_id, status, amount, currency, order_created_at, synced_at",
      { count: "exact" }
    )
    .order("order_created_at", { ascending: false, nullsFirst: false })
    .order("synced_at", { ascending: false })
    .range(from, to);

  const rows = (data ?? []) as OrderRow[];
  const total = typeof count === "number" ? count : rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const hasPrev = pageNum > 1;
  const hasNext = pageNum < totalPages;

  // Resolve brand names for the visible page in one org-scoped round-trip.
  const brandIds = Array.from(
    new Set(rows.map((r) => r.brand_id).filter((id): id is string => !!id))
  );
  let brands: Brand[] = [];
  if (brandIds.length) {
    const { data: bData } = await db.from("brands").select("id, name").in("id", brandIds);
    brands = (bData ?? []) as Brand[];
  }
  const brandName = (id: string | null) => (id ? brands.find((b) => b.id === id)?.name ?? "—" : "—");

  return (
    <AppShell breadcrumb={["Mthryve OS", "Commerce", "TikTok Orders"]} profile={profile}>
      <PageHeader
        title="TikTok Orders"
        subtitle="Individual TikTok Shop orders pulled by the daily sync. Each row is a real store order — its TikTok order ID is shown in full and copyable. Newest first."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Orders (total)" value={total} />
        <StatTile label="This page" value={rows.length} />
        <StatTile label="Page" value={`${pageNum} / ${totalPages}`} />
        <StatTile label="Per page" value={PER_PAGE} />
      </div>

      <TableShell columns={["Order ID", "Status", "Amount", "Order created", "Shop", "Brand"]}>
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="p-4 text-ink-muted">
              No TikTok orders landed yet. They appear here after the daily orders sync runs.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.id} className={rowClass}>
            <td className="p-3">
              <OrderId orderId={r.order_id} />
            </td>
            <td className="p-3">
              <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
            </td>
            <td className="p-3 font-mono text-xs text-ink-muted">
              {pesoOrDash(r.amount, r.currency ?? "PHP")}
            </td>
            <td className="p-3 font-mono text-xs text-ink-muted">{fmtInstant(r.order_created_at)}</td>
            <td className="p-3 font-mono text-[11px] text-ink-muted">{r.shop_id}</td>
            <td className="p-3 text-ink-muted">{brandName(r.brand_id)}</td>
          </tr>
        ))}
      </TableShell>

      <div className="mt-4 flex items-center justify-between text-sm">
        {hasPrev ? (
          <Link
            href={pageHref(pageNum - 1)}
            className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-charcoal-700"
          >
            ← Prev
          </Link>
        ) : (
          <span className="px-3 py-1.5 text-xs text-ink-dim">← Prev</span>
        )}
        <span className="font-mono text-xs text-ink-muted">
          {total === 0 ? "0 of 0" : `Showing ${from + 1}–${from + rows.length} of ${total}`}
        </span>
        {hasNext ? (
          <Link
            href={pageHref(pageNum + 1)}
            className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-charcoal-700"
          >
            Next →
          </Link>
        ) : (
          <span className="px-3 py-1.5 text-xs text-ink-dim">Next →</span>
        )}
      </div>
    </AppShell>
  );
}
