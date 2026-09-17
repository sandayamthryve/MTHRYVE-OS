// Creative performance — read-only aggregations over content_items (+ their
// content_assets cost) for the Creative Studio → Performance tab and the compact
// summary tile fed into the Creative department scorecard.
//
// Everything here is a pure read: we NEVER write, and we do NOT own or touch the
// schema or RLS. content_items' SELECT policy is org-scoped only (every member
// can read all org content), so the "leadership sees all / members see their
// own" split is enforced HERE, in the query layer — leadership aggregates the
// whole org; a team member's view is filtered to assignee_id = their own id.
//
// A "window" is one calendar month (matching the rest of the studio, which is
// month-driven). Counts are grounded in real columns only, and unknown values
// stay null — an empty studio reports "—", never a fabricated 0.

// Metrics for one group (the whole scope, one brand, or one member).
export type CreativeMetrics = {
  // Pieces STARTED in the window (content_items.created_at inside the window).
  produced: number;
  // Pieces whose planned publish_date is in the window, by status.
  scheduled: number;
  published: number;
  // Current snapshot (window-independent): pieces sitting in `production` now.
  inProduction: number;
  // Planned for the window, already due (publish_date ≤ today) but not published
  // and not archived — i.e. missed their date.
  overdue: number;
  // On-time publish rate = published ÷ (published + overdue) over DUE, non-
  // archived pieces planned in the window. null when nothing was due yet.
  onTimeRate: number | null;
  onTimeDue: number; // denominator (due, non-archived)
  onTimePublished: number; // numerator
  // Average idea→published lead time in days (created_at → publish_date) over
  // published pieces in the window that have both dates. null when none.
  avgIdeaToPublishDays: number | null;
  // Production cost (USD) from content_assets created in the window, attributed
  // to the piece's brand / assignee. null when no asset carries a known cost —
  // honest: absent cost data never renders as $0.00.
  costUsd: number | null;
  costAssetCount: number;
};

// One brand or member row.
export type CreativePerfRow = {
  key: string;
  name: string;
  metrics: CreativeMetrics;
};

export type CreativePerformance = {
  month: string; // YYYY-MM
  monthLabel: string;
  scope: "all" | "self"; // leadership vs the member's own view
  overall: CreativeMetrics;
  byBrand: CreativePerfRow[];
  // Populated for leadership; null when the caller is scoped to their own work
  // (a member has no "other members" to break down).
  byMember: CreativePerfRow[] | null;
  hasAnyData: boolean;
};

// --- Date helpers (company timezone = Asia/Manila, matching the studio) ------

export function currentMonth(): string {
  return manilaYmd(new Date()).slice(0, 7);
}

export function todayManila(): string {
  return manilaYmd(new Date());
}

function manilaYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function isMonth(s: string | undefined | null): s is string {
  if (!s || !/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

// [start, end) ISO date bounds for a month; end is the 1st of the next month.
function monthRange(month: string): { start: string; end: string } {
  return { start: `${month}-01`, end: `${shiftMonth(month, 1)}-01` };
}

// Whole days between an idea's creation and its publish date, or null when the
// order is inverted (bad data) or a date is missing.
function ideaToPublishDays(createdAt: string | null, publishDate: string | null): number | null {
  if (!createdAt || !publishDate) return null;
  const created = createdAt.slice(0, 10); // date part of the timestamptz
  if (!/^\d{4}-\d{2}-\d{2}$/.test(created)) return null;
  const a = Date.parse(`${created}T00:00:00Z`);
  const b = Date.parse(`${publishDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const days = Math.round((b - a) / 86_400_000);
  return days >= 0 ? days : null; // published-before-created is data noise → skip
}

// --- Loose read client (content_items / content_assets aren't in the generated
// Supabase types; same cast idiom the studio's Library/Plan reads use) --------
type PerfQuery = {
  eq: (c: string, v: string) => PerfQuery;
  gte: (c: string, v: string) => PerfQuery;
  lt: (c: string, v: string) => PerfQuery;
  neq: (c: string, v: string) => PerfQuery;
  in: (c: string, v: string[]) => PerfQuery;
  limit: (n: number) => PerfQuery;
} & PromiseLike<{ data: unknown[] | null; error: unknown }>;
type PerfReadDb = { from: (t: string) => { select: (c: string) => PerfQuery } };

// A defensive cap so a runaway table can't blow up the request; well above any
// realistic month of creative work for this org.
const ROW_CAP = 5000;

const UNASSIGNED = "__unassigned__";
const NO_BRAND = "__nobrand__";

type ItemRow = {
  id: string;
  brand_id: string | null;
  assignee_id: string | null;
  status: string | null;
  publish_date: string | null;
  created_at: string | null;
};
type AssetRow = {
  content_item_id: string | null;
  brand_id: string | null;
  cost_usd: number | string | null;
};

// Mutable accumulator mirroring CreativeMetrics; folded down at the end.
type Acc = {
  produced: number;
  scheduled: number;
  published: number;
  inProduction: number;
  overdue: number;
  onTimeDue: number;
  onTimePublished: number;
  leadSum: number;
  leadCount: number;
  costUsd: number;
  costKnown: number;
  costAssets: number;
};
const newAcc = (): Acc => ({
  produced: 0,
  scheduled: 0,
  published: 0,
  inProduction: 0,
  overdue: 0,
  onTimeDue: 0,
  onTimePublished: 0,
  leadSum: 0,
  leadCount: 0,
  costUsd: 0,
  costKnown: 0,
  costAssets: 0,
});
function finalize(a: Acc): CreativeMetrics {
  return {
    produced: a.produced,
    scheduled: a.scheduled,
    published: a.published,
    inProduction: a.inProduction,
    overdue: a.overdue,
    onTimeRate: a.onTimeDue > 0 ? a.onTimePublished / a.onTimeDue : null,
    onTimeDue: a.onTimeDue,
    onTimePublished: a.onTimePublished,
    avgIdeaToPublishDays: a.leadCount > 0 ? a.leadSum / a.leadCount : null,
    costUsd: a.costKnown > 0 ? a.costUsd : null,
    costAssetCount: a.costAssets,
  };
}

export type CreativePerfOptions = {
  month: string; // YYYY-MM window
  brandId?: string | null; // optional brand filter
  viewerId: string; // the caller (for self-scoping)
  canSeeAll: boolean; // leadership → aggregate the org; else own work only
};

// Fetch + aggregate. One module, reused by the Performance tab and the
// department scorecard tile. Never throws for a query error — a failed read
// degrades to zero rows (and an honest empty state) rather than a crash.
export async function getCreativePerformance(
  supabase: unknown,
  opts: CreativePerfOptions
): Promise<CreativePerformance> {
  const db = supabase as PerfReadDb;
  const { start, end } = monthRange(opts.month);
  const today = todayManila();
  const brand = (opts.brandId ?? "").trim();
  const self = !opts.canSeeAll;

  const ITEM_COLS = "id, brand_id, assignee_id, status, publish_date, created_at";
  const scope = <Q extends PerfQuery>(q: Q): Q => {
    let out = q;
    if (brand) out = out.eq("brand_id", brand) as Q;
    if (self) out = out.eq("assignee_id", opts.viewerId) as Q;
    return out;
  };

  // Pieces planned in the window (scheduled / published / overdue / lead time).
  const windowQ = scope(
    db.from("content_items").select(ITEM_COLS).gte("publish_date", start).lt("publish_date", end)
  ).limit(ROW_CAP);
  // Pieces created (started) in the window.
  const producedQ = scope(
    db.from("content_items").select(ITEM_COLS).gte("created_at", start).lt("created_at", end)
  ).limit(ROW_CAP);
  // Current in-production snapshot (window-independent).
  const productionQ = scope(
    db.from("content_items").select(ITEM_COLS).eq("status", "production")
  ).limit(ROW_CAP);
  // Assets created in the window that carry cost, excluding removed/failed rows.
  const assetsQ = (() => {
    let q = db
      .from("content_assets")
      .select("content_item_id, brand_id, cost_usd, status, created_at")
      .gte("created_at", start)
      .lt("created_at", end)
      .neq("status", "removed")
      .neq("status", "failed");
    if (brand) q = q.eq("brand_id", brand);
    return q.limit(ROW_CAP);
  })();

  const [windowRes, producedRes, productionRes, assetsRes] = await Promise.all([
    windowQ,
    producedQ,
    productionQ,
    assetsQ,
  ]);

  const windowItems = (windowRes.data ?? []) as unknown as ItemRow[];
  const producedItems = (producedRes.data ?? []) as unknown as ItemRow[];
  const productionItems = (productionRes.data ?? []) as unknown as ItemRow[];
  const assets = (assetsRes.data ?? []) as unknown as AssetRow[];

  // Resolve each cost-bearing asset's piece → assignee/brand for attribution.
  // (An asset stores brand_id directly; the assignee comes from its content
  // item.) In self view we keep only assets whose piece is the viewer's.
  const assetItemIds = Array.from(
    new Set(assets.map((a) => a.content_item_id).filter((v): v is string => !!v))
  );
  const itemAssignee = new Map<string, string | null>();
  const itemBrand = new Map<string, string | null>();
  if (assetItemIds.length > 0) {
    const { data: linked } = await db
      .from("content_items")
      .select("id, assignee_id, brand_id")
      .in("id", assetItemIds)
      .limit(ROW_CAP);
    for (const r of (linked ?? []) as unknown as {
      id: string;
      assignee_id: string | null;
      brand_id: string | null;
    }[]) {
      itemAssignee.set(r.id, r.assignee_id);
      itemBrand.set(r.id, r.brand_id);
    }
  }

  // Accumulators: overall + per brand + per member.
  const overall = newAcc();
  const brandAcc = new Map<string, Acc>();
  const memberAcc = new Map<string, Acc>();
  const brandOf = (id: string | null) => id ?? NO_BRAND;
  const memberOf = (id: string | null) => id ?? UNASSIGNED;
  const get = (m: Map<string, Acc>, k: string) => {
    let a = m.get(k);
    if (!a) m.set(k, (a = newAcc()));
    return a;
  };
  // Apply `fn` to overall + this row's brand + member buckets at once.
  const bump = (brandId: string | null, memberId: string | null, fn: (a: Acc) => void) => {
    fn(overall);
    fn(get(brandAcc, brandOf(brandId)));
    fn(get(memberAcc, memberOf(memberId)));
  };

  for (const it of producedItems) {
    bump(it.brand_id, it.assignee_id, (a) => {
      a.produced += 1;
    });
  }

  for (const it of windowItems) {
    const status = it.status ?? "";
    const due = it.publish_date != null && it.publish_date <= today && status !== "archived";
    bump(it.brand_id, it.assignee_id, (a) => {
      if (status === "scheduled") a.scheduled += 1;
      if (status === "published") {
        a.published += 1;
        const lead = ideaToPublishDays(it.created_at, it.publish_date);
        if (lead != null) {
          a.leadSum += lead;
          a.leadCount += 1;
        }
      }
      if (due) {
        a.onTimeDue += 1;
        if (status === "published") a.onTimePublished += 1;
        else a.overdue += 1; // due, non-archived, not published → missed
      }
    });
  }

  for (const it of productionItems) {
    bump(it.brand_id, it.assignee_id, (a) => {
      a.inProduction += 1;
    });
  }

  for (const as of assets) {
    const memberId = as.content_item_id ? itemAssignee.get(as.content_item_id) ?? null : null;
    // Prefer the asset's own brand_id; fall back to its piece's brand.
    const brandId =
      as.brand_id ?? (as.content_item_id ? itemBrand.get(as.content_item_id) ?? null : null);
    if (self && memberId !== opts.viewerId) continue; // member sees only own cost
    const n = as.cost_usd == null || as.cost_usd === "" ? null : Number(as.cost_usd);
    const known = n != null && Number.isFinite(n);
    bump(brandId, memberId, (a) => {
      a.costAssets += 1;
      if (known) {
        a.costUsd += n as number;
        a.costKnown += 1;
      }
    });
  }

  const brandName = new Map<string, string>();
  const memberName = new Map<string, string>();
  await Promise.all([
    resolveNames(db, "brands", brandAcc, NO_BRAND, "No brand", brandName),
    resolveNames(db, "users", memberAcc, UNASSIGNED, "Unassigned", memberName),
  ]);

  const rows = (m: Map<string, Acc>, names: Map<string, string>): CreativePerfRow[] =>
    Array.from(m.entries())
      .map(([key, acc]) => ({ key, name: names.get(key) ?? "—", metrics: finalize(acc) }))
      .sort(
        (x, y) =>
          rowVolume(y.metrics) - rowVolume(x.metrics) || x.name.localeCompare(y.name)
      );

  const overallMetrics = finalize(overall);
  const hasAnyData =
    overallMetrics.produced +
      overallMetrics.scheduled +
      overallMetrics.published +
      overallMetrics.inProduction +
      overallMetrics.overdue +
      overallMetrics.costAssetCount >
    0;

  return {
    month: opts.month,
    monthLabel: monthLabel(opts.month),
    scope: self ? "self" : "all",
    overall: overallMetrics,
    byBrand: rows(brandAcc, brandName),
    byMember: self ? null : rows(memberAcc, memberName),
    hasAnyData,
  };
}

// Rank rows by how much they carry, so the busiest brand/member floats up.
function rowVolume(m: CreativeMetrics): number {
  return m.produced + m.scheduled + m.published + m.inProduction + m.overdue;
}

// Resolve display names for the keys we actually accumulated (skipping the
// synthetic "no brand" / "unassigned" sentinels, which get a fixed label).
async function resolveNames(
  db: PerfReadDb,
  table: string,
  accs: Map<string, Acc>,
  sentinel: string,
  sentinelLabel: string,
  out: Map<string, string>
): Promise<void> {
  out.set(sentinel, sentinelLabel);
  const ids = Array.from(accs.keys()).filter((k) => k !== sentinel);
  if (ids.length === 0) return;
  const col = table === "users" ? "id, full_name" : "id, name";
  const { data } = await db.from(table).select(col).in("id", ids).limit(ROW_CAP);
  for (const r of (data ?? []) as unknown as Record<string, string>[]) {
    out.set(r.id, (table === "users" ? r.full_name : r.name) ?? "—");
  }
}

// --- Small formatters shared by the tab + the scorecard tile ----------------

export function formatPct(rate: number | null): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function formatDays(days: number | null): string {
  if (days == null) return "—";
  const r = Math.round(days * 10) / 10;
  return `${r} ${r === 1 ? "day" : "days"}`;
}

export function formatCost(cost: number | null): string {
  if (cost == null) return "—";
  return `$${cost.toFixed(2)}`;
}
