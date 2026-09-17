// Shared data loading + display helpers for the Content Calendar exports
// (Excel + PDF route handlers under app/api/content-calendar/export/*).
//
// Both exporters read the SAME org-scoped content_items — through a caller's
// @supabase/ssr session so RLS applies — for a given brand (or "all") and month
// (YYYY-MM). To stay honest with the on-screen calendar the two lenses differ:
//   • the calendar GRID shows only items whose publish_date falls in the month;
//   • the LIST shows those PLUS any undated items (null publish_date), the same
//     way the page folds undated ideas/briefs into its pipeline board.
// Brand / assignee / initiative ids are resolved to human names here so the
// exporters only deal with display strings.

import type { createServerSupabaseClient } from "@/lib/supabase/server";

type Supabase = ReturnType<typeof createServerSupabaseClient>;

// --- Display labels (mirror the content_items check constraints) ------------
export const TYPE_LABEL: Record<string, string> = {
  video: "Video",
  live: "Live",
  graphic: "Graphic",
  carousel: "Carousel",
  photo: "Photo",
  story: "Story",
  other: "Other",
};
export const STATUS_LABEL: Record<string, string> = {
  idea: "Idea",
  brief: "Brief",
  production: "Production",
  scheduled: "Scheduled",
  published: "Published",
  archived: "Archived",
};
export const PLATFORM_LABEL: Record<string, string> = {
  tiktok_shop: "TikTok Shop",
  shopee: "Shopee",
  tiktok: "TikTok",
  facebook: "Facebook",
  instagram: "Instagram",
  other: "Other",
};
export const SALES_LABEL: Record<string, string> = {
  live: "Live",
  video: "Video",
  affiliate: "Affiliate",
  shop: "Shop",
  product_card: "Product card",
};

// The status buckets counted on the Summary sheet (archived lives off-pipeline).
export const SUMMARY_STATUSES = [
  "idea",
  "brief",
  "production",
  "scheduled",
  "published",
] as const;
export const CONTENT_TYPES = [
  "video",
  "live",
  "graphic",
  "carousel",
  "photo",
  "story",
  "other",
] as const;

export function typeLabel(v: string | null): string {
  return (v && TYPE_LABEL[v]) || v || "";
}
export function statusLabel(v: string | null): string {
  return (v && STATUS_LABEL[v]) || v || "";
}
export function platformLabel(v: string | null): string {
  return (v && PLATFORM_LABEL[v]) || v || "";
}
export function salesLabel(v: string | null): string {
  return (v && SALES_LABEL[v]) || v || "";
}

// --- Date helpers (UTC, matching the page's month grid maths) ---------------
export function isMonth(s?: string): boolean {
  if (!s || !/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}
// Current month (YYYY-MM) in the company timezone (Asia/Manila), so a download
// with no ?month= matches the page's default view rather than drifting on UTC.
export function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
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
// Build Mon–Sun week rows for a month; leading/trailing blanks are null.
export function buildWeeks(month: string): (number | null)[][] {
  const [y, m] = month.split("-").map(Number);
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun … 6=Sat
  const lead = (firstDow + 6) % 7; // 0 when the 1st is a Monday
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
export const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// A filename-safe brand slug for the Content-Disposition header.
export function brandSlug(brand: string): string {
  return brand === "all" || !brand ? "all" : brand.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

// --- Row shape the exporters consume (names already resolved) ---------------
export type CalendarRow = {
  id: string;
  publish_date: string | null; // YYYY-MM-DD or null
  day: number | null; // day-of-month for the grid, null when undated
  brand: string;
  title: string;
  content_type: string; // raw enum
  status: string; // raw enum
  platform: string; // display label
  sales_source: string; // display label
  pillar: string;
  assignee: string;
  initiative: string;
  canva_url: string;
  heygen_url: string;
  capcut_url: string;
  asset_url: string;
  notes: string;
};

export type CalendarData = {
  brand: string; // "all" or a brand id
  brandName: string; // "All Brands" or the resolved brand name
  month: string; // YYYY-MM
  monthName: string; // "July 2026"
  rows: CalendarRow[]; // dated-in-month + undated (the List)
  datedRows: CalendarRow[]; // dated-in-month only (the calendar grid)
  byDay: Map<number, CalendarRow[]>; // day-of-month → dated rows on that day
};

const COLS =
  "id, brand_id, initiative_id, title, content_type, status, platform, sales_source, pillar, assignee_id, publish_date, canva_url, heygen_url, capcut_url, asset_url, notes";

type RawItem = {
  id: string;
  brand_id: string | null;
  initiative_id: string | null;
  title: string | null;
  content_type: string | null;
  status: string | null;
  platform: string | null;
  sales_source: string | null;
  pillar: string | null;
  assignee_id: string | null;
  publish_date: string | null;
  canva_url: string | null;
  heygen_url: string | null;
  capcut_url: string | null;
  asset_url: string | null;
  notes: string | null;
};

// Load and shape everything both exporters need. Every query rides the caller's
// session, so RLS on content_items scopes the result to the user's org; the
// explicit brand filter narrows further when a single brand is selected.
export async function loadCalendarData(
  supabase: Supabase,
  brandParam: string,
  month: string
): Promise<CalendarData> {
  const brand = brandParam && brandParam !== "all" ? brandParam : "all";
  const monthStart = `${month}-01`;
  const monthEnd = `${shiftMonth(month, 1)}-01`; // exclusive upper bound

  const datedQuery = () => {
    let q = supabase
      .from("content_items")
      .select(COLS)
      .gte("publish_date", monthStart)
      .lt("publish_date", monthEnd);
    if (brand !== "all") q = q.eq("brand_id", brand);
    return q.order("publish_date", { ascending: true });
  };
  const undatedQuery = () => {
    let q = supabase.from("content_items").select(COLS).is("publish_date", null);
    if (brand !== "all") q = q.eq("brand_id", brand);
    return q.order("title", { ascending: true });
  };

  const [brandsRes, usersRes, initiativesRes, datedRes, undatedRes] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
    supabase.from("brand_initiatives").select("id, name").order("name"),
    datedQuery(),
    undatedQuery(),
  ]);

  const brands = (brandsRes.data ?? []) as unknown as { id: string; name: string }[];
  const people = (usersRes.data ?? []) as unknown as { id: string; full_name: string }[];
  const initiatives = (initiativesRes.data ?? []) as unknown as { id: string; name: string }[];
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const personName = new Map(people.map((p) => [p.id, p.full_name]));
  const initiativeName = new Map(initiatives.map((i) => [i.id, i.name]));

  const shape = (it: RawItem): CalendarRow => ({
    id: it.id,
    publish_date: it.publish_date ? it.publish_date.slice(0, 10) : null,
    day: it.publish_date ? Number(it.publish_date.slice(8, 10)) || null : null,
    brand: it.brand_id ? brandName.get(it.brand_id) ?? "" : "",
    title: it.title ?? "",
    content_type: it.content_type ?? "",
    status: it.status ?? "",
    platform: platformLabel(it.platform),
    sales_source: salesLabel(it.sales_source),
    pillar: it.pillar ?? "",
    assignee: it.assignee_id ? personName.get(it.assignee_id) ?? "" : "",
    initiative: it.initiative_id ? initiativeName.get(it.initiative_id) ?? "" : "",
    canva_url: it.canva_url ?? "",
    heygen_url: it.heygen_url ?? "",
    capcut_url: it.capcut_url ?? "",
    asset_url: it.asset_url ?? "",
    notes: it.notes ?? "",
  });

  const datedRows = ((datedRes.data ?? []) as unknown as RawItem[]).map(shape);
  const undatedRows = ((undatedRes.data ?? []) as unknown as RawItem[]).map(shape);
  // List = dated (chronological) then undated (by title); grid = dated only.
  const rows = [...datedRows, ...undatedRows];

  const byDay = new Map<number, CalendarRow[]>();
  for (const r of datedRows) {
    if (r.day == null) continue;
    const arr = byDay.get(r.day) ?? [];
    arr.push(r);
    byDay.set(r.day, arr);
  }

  return {
    brand,
    brandName: brand === "all" ? "All Brands" : brandName.get(brand) ?? "Unknown brand",
    month,
    monthName: monthLabel(month),
    rows,
    datedRows,
    byDay,
  };
}
