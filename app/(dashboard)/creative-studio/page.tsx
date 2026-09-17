import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { AppShell } from "@/components/layout/AppShell";
import {
  PageHeader,
  SectionCard,
  StatTile,
  Badge,
  TableShell,
  rowClass,
  type BadgeTone,
} from "@/components/ui";
import { requireProfile, requireRole } from "@/lib/auth/session";
import type { SessionProfile } from "@/lib/auth/session";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { checkPolicy } from "@/lib/governance/policy";
import { defaultTierFor, TIER_MODEL } from "@/lib/ai/models";
import { BrandFilter } from "@/components/content-calendar/FilterBar";
import { InlineStatusSelect } from "@/components/content-calendar/InlineStatusSelect";
import {
  GenerateBriefButton,
  SaveButton,
  DeleteContentButton,
  CreateInCanvaButton,
} from "@/components/content-calendar/EditorButtons";
import {
  AttachAssetButton,
  SaveCapcutButton,
  RemoveAssetButton,
} from "@/components/creative-studio/KitButtons";
import { LibraryFilters } from "@/components/creative-studio/LibraryFilters";
import { MediaUploader } from "@/components/creative-studio/MediaUploader";
import { PerfSnapFill } from "@/components/creative-studio/PerfSnapFill";
import {
  PlanCalendar,
  type PlanItem,
  type PlanInitiative,
  type PlanLiveSession,
  type BrandContext,
} from "@/components/creative-studio/PlanCalendar";
import { getLatestAccountBriefing } from "@/lib/briefings/read";
import { isCanvaConfigured } from "@/lib/canva/config";
import { getCanvaConnectionStatus, getCanvaToken } from "@/lib/canva/vault";
import { createCanvaDesign } from "@/lib/canva/designs";
import {
  isHeygenConfigured,
  listAvatars,
  listVoices,
  generateVideo,
  getWallet,
  type HeygenAvatar,
  type HeygenVoice,
} from "@/lib/heygen/client";
import { coerceTier, estimateCostUsd, formatUsd } from "@/lib/heygen/cost";
import { HeygenGeneratePanel } from "@/components/content-calendar/HeygenGeneratePanel";
import { isFalConfigured, submitVideo } from "@/lib/fal/client";
import {
  coerceFalModel,
  coerceDuration,
  assetKindForModel,
  estimateFalCostUsd,
  durationParam,
} from "@/lib/fal/models";
import { FalVideoPanel } from "@/components/creative-studio/FalVideoPanel";
import { isJson2VideoConfigured, submitMovie } from "@/lib/json2video/client";
import {
  coerceResolution,
  selectAssemblyAssets,
  estimateAssemblyDurationSeconds,
  estimateAssemblyCostUsd,
  hasRenderableScenes,
  type AssemblySourceAsset,
} from "@/lib/json2video/assembly";
import { buildMovie } from "@/lib/json2video/template";
import { AssemblyPanel } from "@/components/creative-studio/AssemblyPanel";
import {
  ASSET_KINDS,
  ASSET_COLS,
  ASSET_KIND_LABEL,
  ASSET_KIND_SINGULAR,
  ASSET_KIND_ICON,
  ASSET_REMOVED_STATUS,
  assetStatusTone,
  formatAssetCost,
  type ContentAsset,
} from "@/lib/content/assets";
import {
  getCreativePerformance,
  formatPct,
  formatDays,
  formatCost,
  type CreativePerfRow,
} from "@/lib/content/performance";
import {
  buildCreativeSystemSuffix,
  PILLAR_OPTIONS,
  resolvePillar,
} from "@/lib/content/creative-guides";
import { safeUrl } from "@/lib/security/sanitize";
import { VesperJobForm } from "@/components/creative-studio/VesperJobForm";
import { readJobs, insertJob, readJob, updateJob, readClipsForJobs } from "@/lib/vesper/jobs";
import {
  resolveOptions,
  jobStatusTone,
  JOB_STATUS_LABEL,
  ACTIVE_JOB_STATUSES,
  type ClipJob,
  type JobOptions,
} from "@/lib/vesper/types";
import { selectHighlights } from "@/lib/vesper/segment";

// Creative Studio — the unified planning + production workspace. One parent
// surface with four tabs over the same org-scoped content_items:
//   • Plan     — the month calendar, pipeline board, summary tiles, brand/month
//                filters, the AI brief generator and the Excel/PDF exports.
//   • Produce  — the content-item editor: every field, the Canva + HeyGen
//                actions, and the "Creative Kit" (content_assets for this item).
//   • Library  — an org-wide, read-only gallery over content_assets.
//   • Performance — a placeholder until the creative-analytics brief lands.
//
// The calendar was previously its own /content-calendar page; it moves in here
// unchanged under the Plan tab, and /content-calendar now redirects to
// ?tab=plan (deep links via ?brand= / ?month= keep working). Everything is
// URL-driven — the active tab, filters and the open item all live in the query
// string — so server actions can redirect back to the exact view they touched
// and nothing depends on client state surviving a round-trip.

// Force per-request (runtime) rendering on the Node.js runtime so server env
// vars — including Vercel "Sensitive" (runtime-only) vars like CANVA_CLIENT_ID /
// CANVA_CLIENT_SECRET — are read fresh on every request rather than inlined at
// build time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

// --- Enums (mirror the provisioned content_items check constraints) ---------
const CONTENT_TYPES = ["video", "live", "graphic", "carousel", "photo", "story", "other"] as const;
const STATUSES = ["idea", "brief", "production", "scheduled", "published", "archived"] as const;
const PLATFORMS = ["tiktok_shop", "shopee", "tiktok", "facebook", "instagram", "other"] as const;
const SALES_SOURCES = ["live", "video", "affiliate", "shop", "product_card"] as const;

// The five pipeline stages shown as board columns; `archived` lives off-board.
const BOARD_STAGES = ["idea", "brief", "production", "scheduled", "published"] as const;

// --- Media Library folders (mirror media_assets.folder CHECK constraint) -----
const MEDIA_FOLDERS = ["raw", "edited", "graphics", "brand_assets"] as const;
type MediaFolder = (typeof MEDIA_FOLDERS)[number];
const MEDIA_FOLDER_LABEL: Record<MediaFolder, string> = {
  raw: "Raw Files",
  edited: "Edited Videos",
  graphics: "Graphics",
  brand_assets: "Brand Assets",
};

// --- Performance metric fields (mirror content_performance columns) ----------
// `int` columns take whole numbers; `num` columns (rates, durations, GMV) accept
// decimals. A blank input stays NULL — never coerced to 0.
const PERF_INT_FIELDS = [
  "views", "reach", "likes", "comments", "shares", "saves",
  "clicks", "watch_time_seconds", "conversions", "orders",
] as const;
const PERF_NUM_FIELDS = [
  "engagement_rate", "ctr", "avg_view_duration_seconds", "gmv",
] as const;

// The full manual-entry metric set, in form + table order. `step` marks decimal
// fields (rates, durations, GMV); the rest are whole numbers.
const PERF_METRIC_FIELDS: { name: string; label: string; short: string; step?: string; money?: boolean }[] = [
  { name: "views", label: "Views", short: "Views" },
  { name: "reach", label: "Reach", short: "Reach" },
  { name: "likes", label: "Likes", short: "Likes" },
  { name: "comments", label: "Comments", short: "Cmts" },
  { name: "shares", label: "Shares", short: "Shares" },
  { name: "saves", label: "Saves", short: "Saves" },
  { name: "engagement_rate", label: "Engagement rate (%)", short: "ER", step: "0.01" },
  { name: "clicks", label: "Clicks", short: "Clicks" },
  { name: "ctr", label: "CTR (%)", short: "CTR", step: "0.01" },
  { name: "watch_time_seconds", label: "Watch time (s)", short: "Watch(s)" },
  { name: "avg_view_duration_seconds", label: "Avg view duration (s)", short: "AvgView(s)", step: "0.1" },
  { name: "conversions", label: "Conversions", short: "Conv" },
  { name: "orders", label: "Orders", short: "Orders" },
  { name: "gmv", label: "GMV", short: "GMV", step: "0.01", money: true },
];

// Performance sub-tabs: real metrics (primary) vs the Brief→Published pipeline
// tracker (secondary — kept so it stops masquerading as performance).
type PerfView = "metrics" | "pipeline";
function perfViewOf(v?: string): PerfView {
  return v === "pipeline" ? "pipeline" : "metrics";
}

// The workspace tabs.
const TABS = ["plan", "produce", "library", "vesper", "performance"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  plan: "Plan",
  produce: "Produce",
  library: "Library",
  vesper: "Vesper",
  performance: "Performance",
};

type ContentType = (typeof CONTENT_TYPES)[number];
type Status = (typeof STATUSES)[number];

const TYPE_ICON: Record<ContentType, string> = {
  video: "🎬",
  live: "🔴",
  graphic: "🎨",
  carousel: "🖼️",
  photo: "📷",
  story: "✨",
  other: "📄",
};
const TYPE_LABEL: Record<ContentType, string> = {
  video: "Video",
  live: "Live",
  graphic: "Graphic",
  carousel: "Carousel",
  photo: "Photo",
  story: "Story",
  other: "Other",
};
const STATUS_LABEL: Record<Status, string> = {
  idea: "Idea",
  brief: "Brief",
  production: "Production",
  scheduled: "Scheduled",
  published: "Published",
  archived: "Archived",
};
// Chip / column accent per status — on-brand palette (teal primary, gold WIP,
// green done, violet info, charcoal neutral).
const STATUS_CHIP: Record<Status, string> = {
  idea: "border-charcoal-700 bg-charcoal-800 text-ink-muted",
  brief: "border-violet-500/40 bg-violet-500/15 text-violet-300",
  production: "border-gold-500/40 bg-gold-500/15 text-gold-400",
  scheduled: "border-teal-500/40 bg-teal-500/15 text-teal-300",
  published: "border-green-500/40 bg-green-500/15 text-green-400",
  archived: "border-charcoal-700 bg-charcoal-900 text-ink-dim",
};
const PLATFORM_LABEL: Record<string, string> = {
  tiktok_shop: "TikTok Shop",
  shopee: "Shopee",
  tiktok: "TikTok",
  facebook: "Facebook",
  instagram: "Instagram",
  other: "Other",
};
const SALES_LABEL: Record<string, string> = {
  live: "Live",
  video: "Video",
  affiliate: "Affiliate",
  shop: "Shop",
  product_card: "Product card",
};

// The workspace's query-string surface — the whole view state lives here.
type StudioSearchParams = {
  tab?: string;
  brand?: string;
  month?: string;
  edit?: string;
  kind?: string;
  berr?: string;
  canva?: string;
  canva_error?: string;
  canva_connected?: string;
  heygen?: string;
  video?: string;
  assemble?: string;
  kit?: string;
  // Sub-view within a tab (Performance: metrics|pipeline · Library: media|assets).
  view?: string;
  // Media Library folder filter.
  folder?: string;
  // Performance: the metrics row being edited, and flow flags.
  editperf?: string;
  perf?: string;
  media?: string;
  // Vesper Studio flow flag.
  vesper?: string;
  // Archive filter for the Plan board ("1" = show archived content items).
  archived?: string;
};

type ContentItem = {
  id: string;
  org_id: string;
  brand_id: string | null;
  initiative_id: string | null;
  title: string;
  content_type: string;
  status: string;
  platform: string | null;
  sales_source: string | null;
  pillar: string | null;
  assignee_id: string | null;
  publish_date: string | null;
  brief: string | null;
  canva_url: string | null;
  heygen_url: string | null;
  capcut_url: string | null;
  asset_url: string | null;
  notes: string | null;
  created_by: string | null;
  archived_at: string | null;
};
type Brand = { id: string; name: string };
type Initiative = { id: string; name: string };
type Person = { id: string; full_name: string };
// A row of the heygen_generations ledger, as read for the "HeyGen Videos" list.
type HeygenGeneration = {
  id: string;
  content_item_id: string | null;
  brand_id: string | null;
  title: string | null;
  status: string;
  video_url: string | null;
  thumbnail_url: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  duration_seconds: number | null;
  error_message: string | null;
  created_at: string;
};
// A lightweight row for the Produce picker (choose an item to work on).
type PickerItem = {
  id: string;
  title: string;
  brand_id: string | null;
  content_type: string;
  status: string;
  publish_date: string | null;
};

// content_items / content_assets aren't in the generated Supabase types, so
// writes go through this shim — same idiom as Attendance / Brands. RLS still
// scopes every row.
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => {
      select: (c: string) => {
        single: () => Promise<{ data: { id: string } | null; error: unknown }>;
      };
    };
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => Promise<{ error: unknown }>;
    };
    delete: () => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
  };
};

// Loosely-typed read client for content_assets (not in the generated types).
// Supports the small chain of filters the Kit / Library reads use; every method
// returns the same awaitable builder.
type AssetQuery = {
  eq: (c: string, v: string) => AssetQuery;
  neq: (c: string, v: string) => AssetQuery;
  in: (c: string, v: string[]) => AssetQuery;
  order: (c: string, o: { ascending: boolean }) => AssetQuery;
  limit: (n: number) => AssetQuery;
} & PromiseLike<{ data: unknown[] | null; error: unknown }>;
type AssetReadDb = { from: (t: string) => { select: (c: string) => AssetQuery } };

// Loose write client for tables not in the generated types (media_assets,
// content_performance). RLS still scopes every row; org_id/created_by are stamped
// from the session on insert so the RLS with_check passes.
type LooseWriteDb = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<{ error: unknown }>;
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => Promise<{ error: unknown }>;
    };
    delete: () => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
  };
};

const fieldCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink placeholder:text-ink-dim";

// --- Small parsing / date helpers -------------------------------------------
function pick<T extends readonly string[]>(list: T, v: unknown): T[number] | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T[number]) : null;
}
function trimOrNull(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v ? v : null;
}
// Parse a whole-number metric field. Blank → NULL (never coerced to 0).
function intOrNull(formData: FormData, key: string): number | null {
  const v = String(formData.get(key) ?? "").trim();
  if (!v) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}
// Parse a decimal metric field (rates, durations, GMV). Blank → NULL.
function numOrNull(formData: FormData, key: string): number | null {
  const v = String(formData.get(key) ?? "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function isMonth(s?: string): boolean {
  if (!s || !/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}
function tabOf(v?: string): Tab {
  return (TABS as readonly string[]).includes(v ?? "") ? (v as Tab) : "plan";
}
// Current month (YYYY-MM) in the company timezone, matching how the rest of the
// app derives "today" (Asia/Manila) so the default view never drifts on UTC.
function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
}
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}
// Canonical workspace URL preserving the active tab + filters, optionally
// opening an item or scoping the Library to a kind. `plan` (the default tab) is
// omitted from the query so the base URL stays clean.
function studioUrl(opts: {
  tab?: Tab;
  brand?: string;
  month?: string;
  edit?: string;
  kind?: string;
  view?: string;
  folder?: string;
  editperf?: string;
}): string {
  const p = new URLSearchParams();
  if (opts.tab && opts.tab !== "plan") p.set("tab", opts.tab);
  if (opts.brand) p.set("brand", opts.brand);
  if (opts.month) p.set("month", opts.month);
  if (opts.edit) p.set("edit", opts.edit);
  if (opts.kind) p.set("kind", opts.kind);
  if (opts.view) p.set("view", opts.view);
  if (opts.folder) p.set("folder", opts.folder);
  if (opts.editperf) p.set("editperf", opts.editperf);
  const qs = p.toString();
  return qs ? `/creative-studio?${qs}` : "/creative-studio";
}
// Link to a server-generated export route, carrying the on-screen brand + month
// so the downloaded file matches the current view. An empty brand → "all".
function exportUrl(kind: "xlsx" | "pdf", brand: string, month: string): string {
  const p = new URLSearchParams({ brand: brand || "all", month });
  return `/api/content-calendar/export/${kind}?${p.toString()}`;
}

// --- Server actions ---------------------------------------------------------

// Insert or update a content item. Any authed org member may write (per RLS);
// org_id + created_by are stamped from the session on insert, never trusted from
// the form. Optional selects/URLs left blank stay null (honest — never 0/"").
async function saveContentItem(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const id = String(formData.get("id") ?? "").trim();
  const brandFilter = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return; // title is required in the form; guard the action too.

  const payload: Record<string, unknown> = {
    brand_id: trimOrNull(formData, "brand_id"),
    initiative_id: trimOrNull(formData, "initiative_id"),
    title,
    content_type: pick(CONTENT_TYPES, formData.get("content_type")) ?? "video",
    status: pick(STATUSES, formData.get("status")) ?? "idea",
    platform: pick(PLATFORMS, formData.get("platform")),
    sales_source: pick(SALES_SOURCES, formData.get("sales_source")),
    pillar: trimOrNull(formData, "pillar"),
    assignee_id: trimOrNull(formData, "assignee_id"),
    publish_date: trimOrNull(formData, "publish_date"),
    brief: trimOrNull(formData, "brief"),
    canva_url: trimOrNull(formData, "canva_url"),
    heygen_url: trimOrNull(formData, "heygen_url"),
    capcut_url: trimOrNull(formData, "capcut_url"),
    asset_url: trimOrNull(formData, "asset_url"),
    notes: trimOrNull(formData, "notes"),
  };

  let savedId = id;
  if (id) {
    await db.from("content_items").update(payload).eq("id", id);
  } else {
    const { data } = await db
      .from("content_items")
      .insert({ ...payload, org_id: profile.org_id, created_by: profile.id })
      .select("id")
      .single();
    savedId = data?.id ?? "";
  }

  revalidatePath("/creative-studio");
  // Keep the editor open on the saved item so its tools stay available.
  redirect(studioUrl({ tab: "produce", brand: brandFilter, month, edit: savedId || undefined }));
}

// Delete a content item (leadership + department heads only). Returns to the
// Plan board on the same filtered view.
async function deleteContentItem(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head"]);
  const supabase = createServerSupabaseClient();
  const id = String(formData.get("id") ?? "");
  const brand = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  if (!id) return;
  await (supabase as unknown as DbShim).from("content_items").delete().eq("id", id);
  revalidatePath("/creative-studio");
  redirect(studioUrl({ tab: "plan", brand, month }));
}

// Inline status change from a board card (any authed member).
async function updateItemStatus(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const id = String(formData.get("id") ?? "");
  const status = pick(STATUSES, formData.get("status"));
  const brand = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  if (!id || !status) return;

  // Client-content publish gate, from the Policy Registry: AI cannot publish
  // client content directly. A human moving a card to "published" is allowed;
  // an AI-driven flow would be denied. Consulting here keeps the publish rule in
  // one editable place instead of hardcoded in the board.
  if (status === "published") {
    const gate = await checkPolicy("publish", {
      orgId: profile.org_id,
      isAi: false,
      actorId: profile.id,
      actorRole: profile.role,
      detail: { content_item_id: id, brand },
    });
    if (gate.decision !== "allow") {
      redirect(studioUrl({ tab: "plan", brand, month }));
    }
  }

  await (supabase as unknown as DbShim).from("content_items").update({ status }).eq("id", id);
  revalidatePath("/creative-studio");
  redirect(studioUrl({ tab: "plan", brand, month }));
}

// --- Media Library actions --------------------------------------------------
// Upload one or more files into the private creative-media bucket at
// {org_id}/{folder}/{uuid}-{filename} and insert a media_assets row per file.
// The storage RLS policy requires the first path segment to be the caller's
// org_id, so the path is always prefixed from the session (never trusted from
// the form). Any authed org member may upload (per RLS).
async function uploadMediaAssets(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  const folderRaw = String(formData.get("folder") ?? "raw");
  const folder = (MEDIA_FOLDERS as readonly string[]).includes(folderRaw) ? folderRaw : "raw";
  const brandId = trimOrNull(formData, "brand_id");
  const brandFilter = String(formData.get("brand") ?? "");
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);

  const back = (flag?: string) => {
    const p = new URLSearchParams();
    p.set("tab", "library");
    p.set("view", "media");
    if (brandFilter) p.set("brand", brandFilter);
    if (folder) p.set("folder", folder);
    if (flag) p.set("media", flag);
    redirect(`/creative-studio?${p.toString()}`);
  };
  if (files.length === 0) back("nofiles");

  const db = supabase as unknown as LooseWriteDb;
  let ok = 0;
  for (const file of files) {
    const safe = (file.name.replace(/[^\w.\-]+/g, "_") || "file").slice(-120);
    const path = `${profile.org_id}/${folder}/${crypto.randomUUID()}-${safe}`;
    const { error: upErr } = await supabase.storage
      .from("creative-media")
      .upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (upErr) continue;
    const { error: insErr } = await db.from("media_assets").insert({
      org_id: profile.org_id,
      brand_id: brandId,
      folder,
      title: file.name,
      storage_path: path,
      mime_type: file.type || null,
      size_bytes: file.size,
      uploaded_by: profile.id,
    });
    if (insErr) {
      // Roll back the orphaned object so a retry stays clean.
      await supabase.storage.from("creative-media").remove([path]);
      continue;
    }
    ok++;
  }
  revalidatePath("/creative-studio");
  back(ok === 0 ? "failed" : ok === files.length ? "ok" : "partial");
}

// Delete a media asset: remove the storage object first, then the row. RLS
// scopes both to the caller's org. Any authed org member may delete (per RLS).
async function deleteMediaAsset(formData: FormData) {
  "use server";
  await requireProfile();
  const supabase = createServerSupabaseClient();
  const id = String(formData.get("id") ?? "");
  const brandFilter = String(formData.get("brand") ?? "");
  const folder = String(formData.get("folder") ?? "");
  if (!id) return;

  const { data } = await (supabase as unknown as AssetReadDb)
    .from("media_assets")
    .select("storage_path")
    .eq("id", id);
  const path = ((data ?? [])[0] as { storage_path?: string } | undefined)?.storage_path;
  if (path) await supabase.storage.from("creative-media").remove([path]);
  await (supabase as unknown as LooseWriteDb).from("media_assets").delete().eq("id", id);

  revalidatePath("/creative-studio");
  redirect(studioUrl({ tab: "library", view: "media", brand: brandFilter, folder }));
}

// --- Vesper Studio actions --------------------------------------------------
// Enqueue an auto-clip job (any authed member). Accepts either a raw media_assets
// id already in creative-media, or a URL the worker will fetch. This ONLY writes
// the vesper_clip_jobs row (status 'queued') — no video is processed in this
// runtime; the out-of-runtime worker (worker/vesper-clipper.mjs) picks it up.
async function enqueueVesperJob(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  const brandFilter = String(formData.get("brand") ?? "");
  const back = (flag?: string) => {
    const p = new URLSearchParams();
    p.set("tab", "vesper");
    if (brandFilter) p.set("brand", brandFilter);
    if (flag) p.set("vesper", flag);
    redirect(`/creative-studio?${p.toString()}`);
  };

  const sourceAssetId = String(formData.get("source_asset_id") ?? "").trim();
  const sourceUrlRaw = String(formData.get("source_url") ?? "").trim();
  const brandId = trimOrNull(formData, "brand_id");
  const options: JobOptions = resolveOptions({
    max_clips: Number(formData.get("max_clips") ?? 6),
    aspect: (String(formData.get("aspect") ?? "9:16") as JobOptions["aspect"]),
  });

  // Validate a URL if one was given; a raw-asset pick takes precedence.
  let sourceUrl: string | null = null;
  if (!sourceAssetId && sourceUrlRaw) {
    try {
      const u = new URL(sourceUrlRaw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("proto");
      sourceUrl = u.toString();
    } catch {
      back("badurl");
    }
  }
  if (!sourceAssetId && !sourceUrl) back("nosource");

  // Confirm the raw asset exists in the org (RLS-scoped) and grab its title.
  let sourceTitle: string | null = null;
  let resolvedAssetId: string | null = null;
  if (sourceAssetId) {
    const { data } = await (supabase as unknown as AssetReadDb)
      .from("media_assets")
      .select("id, title")
      .eq("id", sourceAssetId);
    const asset = ((data ?? [])[0] as { id: string; title: string | null } | undefined) ?? null;
    if (!asset) back("nosource");
    resolvedAssetId = asset!.id;
    sourceTitle = asset!.title;
  }

  const jobId = await insertJob(supabase, {
    org_id: profile.org_id,
    requested_by: profile.id,
    brand_id: brandId,
    source_asset_id: resolvedAssetId,
    source_url: sourceUrl,
    source_title: sourceTitle,
    options: options as unknown as Record<string, unknown>,
  });

  revalidatePath("/creative-studio");
  back(jobId ? "queued" : "failed");
}

// Run the Anthropic segment-selection step in-app for a job that already carries
// a transcript (produced by the worker). This is the testable in-runtime slice of
// the pipeline; the model is chosen by the caller's role tier.
async function runVesperSegmentation(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  const brandFilter = String(formData.get("brand") ?? "");
  const jobId = String(formData.get("job_id") ?? "").trim();
  const back = (flag?: string) => {
    const p = new URLSearchParams();
    p.set("tab", "vesper");
    if (brandFilter) p.set("brand", brandFilter);
    if (flag) p.set("vesper", flag);
    redirect(`/creative-studio?${p.toString()}`);
  };
  if (!jobId) back("nosource");

  const job = await readJob(supabase, jobId);
  if (!job) back("notfound");
  const transcript = job!.transcript;
  if (!transcript || !transcript.cues?.length) back("notranscript");

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) back("config");

  const model = TIER_MODEL[defaultTierFor(profile.role)];
  await updateJob(supabase, jobId, { status: "segmenting", stage_detail: "Selecting highlights (Anthropic)" });
  const result = await selectHighlights(transcript!, job!.options, { apiKey: apiKey!, model });

  if (result.error && result.highlights.length === 0) {
    await updateJob(supabase, jobId, { status: "failed", error: `Segment selection failed: ${result.error}` });
    revalidatePath("/creative-studio");
    back("segfail");
  }

  await updateJob(supabase, jobId, {
    segments: result.highlights,
    segment_model: result.model,
    status: result.highlights.length > 0 ? "clipping" : "done",
    stage_detail:
      result.highlights.length > 0
        ? `${result.highlights.length} highlight(s) selected — worker will cut them`
        : "No clip-worthy highlights found",
    ...(result.highlights.length === 0 ? { completed_at: new Date().toISOString() } : {}),
  });
  revalidatePath("/creative-studio");
  back("segmented");
}

// --- Performance actions ----------------------------------------------------
// Insert or update a manual content_performance row. Every metric is optional
// and a blank stays NULL (never 0). source='manual' and external_id stays null
// so a future platform sync can upsert on (org_id, external_id) without touching
// manual rows.
async function savePerformance(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  const id = String(formData.get("id") ?? "").trim();
  const brandFilter = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();

  const postedRaw = trimOrNull(formData, "posted_at");
  const payload: Record<string, unknown> = {
    brand_id: trimOrNull(formData, "brand_id"),
    content_item_id: trimOrNull(formData, "content_item_id"),
    platform: pick(PLATFORMS, formData.get("platform")),
    posted_at: postedRaw ? new Date(postedRaw).toISOString() : null,
    notes: trimOrNull(formData, "notes"),
    source: "manual",
  };
  for (const f of PERF_INT_FIELDS) payload[f] = intOrNull(formData, f);
  for (const f of PERF_NUM_FIELDS) payload[f] = numOrNull(formData, f);

  const db = supabase as unknown as LooseWriteDb;
  if (id) {
    payload.updated_at = new Date().toISOString();
    await db.from("content_performance").update(payload).eq("id", id);
  } else {
    await db
      .from("content_performance")
      .insert({ ...payload, org_id: profile.org_id, created_by: profile.id });
  }
  revalidatePath("/creative-studio");
  redirect(studioUrl({ tab: "performance", view: "metrics", brand: brandFilter, month }));
}

// Delete a manual performance row (any authed org member, per RLS).
async function deletePerformance(formData: FormData) {
  "use server";
  await requireProfile();
  const supabase = createServerSupabaseClient();
  const id = String(formData.get("id") ?? "");
  const brandFilter = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  if (!id) return;
  await (supabase as unknown as LooseWriteDb).from("content_performance").delete().eq("id", id);
  revalidatePath("/creative-studio");
  redirect(studioUrl({ tab: "performance", view: "metrics", brand: brandFilter, month }));
}

// AI brief generator (any authed member). Gathers the item's brand name,
// content type, platform, sales source and pillar, then asks Claude (model by
// caller role tier) for a hook + short script/outline + caption tailored to the
// sales channel. Grounded strictly in those fields — no invented numbers. If the
// context is too thin, saves a short honest note instead of padding.
async function generateContentBrief(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const id = String(formData.get("id") ?? "").trim();
  const brandFilter = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  const back = (extra?: Record<string, string>) => {
    const p = new URLSearchParams();
    p.set("tab", "produce");
    if (brandFilter) p.set("brand", brandFilter);
    if (month) p.set("month", month);
    if (id) p.set("edit", id);
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    redirect(`/creative-studio?${p.toString()}`);
  };
  if (!id) redirect(studioUrl({ tab: "produce", brand: brandFilter, month }));

  const { data: itemData } = await supabase
    .from("content_items")
    .select("id, brand_id, title, content_type, platform, sales_source, pillar")
    .eq("id", id)
    .maybeSingle();
  const item = itemData as unknown as {
    id: string;
    brand_id: string | null;
    title: string;
    content_type: string;
    platform: string | null;
    sales_source: string | null;
    pillar: string | null;
  } | null;
  if (!item) redirect(studioUrl({ tab: "produce", brand: brandFilter, month }));

  let brandName = "";
  if (item!.brand_id) {
    const { data: b } = await supabase
      .from("brands")
      .select("name")
      .eq("id", item!.brand_id)
      .maybeSingle();
    brandName = ((b as unknown as { name?: string } | null)?.name ?? "").trim();
  }

  // Too thin to say anything useful → an honest note, not filler.
  if (!brandName && !item!.pillar && !item!.sales_source && !item!.platform) {
    await db
      .from("content_items")
      .update({
        brief:
          "Not enough context to write a useful brief yet. Add a brand, platform, sales source, or content pillar, then generate again.",
      })
      .eq("id", id);
    revalidatePath("/creative-studio");
    back();
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) back({ berr: "config" });

  const model = TIER_MODEL[defaultTierFor(profile.role)];
  const channelHint =
    item!.sales_source === "live"
      ? "This is for LIVE selling — write a live-stream selling script: a strong opening hook, product intro, 2–3 key selling points, one objection handled, and a clear call to buy now."
      : item!.sales_source === "video"
        ? "This is for short-form video — open with a scroll-stopping hook in the first ~2 seconds, then a tight beat-by-beat outline, ending on a call to action."
        : item!.sales_source === "affiliate"
          ? "This is for affiliate/creator outreach — make it easy for a creator to produce: a hook plus talking points they can adapt in their own voice."
          : item!.sales_source === "shop"
            ? "This is for a shop/marketplace angle — benefit-led and conversion-focused."
            : item!.sales_source === "product_card"
              ? "This is for a product card — punchy: a one-line hook and a benefit-led caption."
              : "Tailor the hook, outline and caption to the platform.";

  const details = [
    brandName ? `Brand: ${brandName}` : null,
    `Content type: ${TYPE_LABEL[(item!.content_type as ContentType) ?? "other"] ?? item!.content_type}`,
    item!.platform ? `Platform: ${PLATFORM_LABEL[item!.platform] ?? item!.platform}` : null,
    item!.sales_source ? `Sales channel: ${SALES_LABEL[item!.sales_source] ?? item!.sales_source}` : null,
    item!.pillar ? `Content pillar: ${item!.pillar}` : null,
    item!.title ? `Working title: ${item!.title}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Ground the brief in the same pillar/format/product constraints the rest of
  // the studio uses: the content pillar drives tone (over any default sell), the
  // sales channel maps to a script format, and the title anchors the product.
  const formatFromSales =
    item!.sales_source === "live"
      ? "live_selling"
      : item!.sales_source === "video"
        ? "short_form"
        : item!.sales_source === "affiliate"
          ? "ugc"
          : "";
  const creativeSuffix = buildCreativeSystemSuffix({
    pillar: item!.pillar ?? "",
    format: formatFromSales,
    product_name: item!.title ?? "",
    brand_summary: brandName,
  });
  const system =
    "You are a content strategist for a Southeast Asian social-commerce agency. " +
    "Write a concise, platform-appropriate content brief grounded ONLY in the details provided. " +
    "Never invent performance numbers, view counts, GMV, dates, prices, or any fact not given. " +
    "If a detail is missing, work around it — do not fabricate. Keep it tight and production-ready." +
    creativeSuffix;
  const userPrompt =
    `Write a content brief for this item.\n\n${details}\n\n${channelHint}\n\n` +
    "Return exactly three short sections with these headings:\n" +
    "1. Hook — one or two lines.\n" +
    "2. Script / Outline — a short beat-by-beat outline (bullets).\n" +
    "3. Caption — a ready-to-post caption with a couple of relevant hashtags.";

  let brief = "";
  let failed = false;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    const data = (await res.json()) as {
      content?: { type: string; text: string }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      failed = true;
    } else {
      brief = (data.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    }
  } catch {
    failed = true;
  }

  // redirect() throws, so it must live outside the try/catch above.
  if (failed || !brief) back({ berr: "api" });

  await db.from("content_items").update({ brief }).eq("id", id);
  revalidatePath("/creative-studio");
  back();
}

// "Create in Canva" (any authed member). Fetches a valid org access token from
// the locked vault (refreshing if needed), creates a blank design via the Canva
// Connect API, then saves the returned edit URL into canva_url (and the
// thumbnail into asset_url when empty). It ALSO writes a content_assets row
// (kind canva_design) so the design shows up in the item's Creative Kit and the
// org Library — in addition to the canva_url field. Every failure funnels back
// to the editor with a friendly ?canva=<reason> flag — it never crashes.
async function createInCanva(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const id = String(formData.get("id") ?? "").trim();
  const brandFilter = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  const back = (flag?: string) => {
    const p = new URLSearchParams();
    p.set("tab", "produce");
    if (brandFilter) p.set("brand", brandFilter);
    if (month) p.set("month", month);
    if (id) p.set("edit", id);
    if (flag) p.set("canva", flag);
    redirect(`/creative-studio?${p.toString()}`);
  };
  if (!id) redirect(studioUrl({ tab: "produce", brand: brandFilter, month }));

  if (!isCanvaConfigured()) back("notconfigured");

  const token = await getCanvaToken(profile.org_id);
  if (!token) back("needsconnect");

  // Title the design after the saved item (RLS scopes this read to the org).
  const { data: itemData } = await supabase
    .from("content_items")
    .select("id, title, brand_id, canva_url, asset_url")
    .eq("id", id)
    .maybeSingle();
  const item = itemData as unknown as {
    id: string;
    title: string;
    brand_id: string | null;
    canva_url: string | null;
    asset_url: string | null;
  } | null;
  if (!item) back("error");

  const design = await createCanvaDesign(token!, item!.title || "Mthryve OS content");
  // redirect() throws, so the failure branch must sit outside any try/catch.
  if (!design?.editUrl) back("error");

  const update: Record<string, unknown> = { canva_url: design!.editUrl };
  // Fill asset_url from the thumbnail only when it's empty — never clobber one.
  if (design!.thumbnailUrl && !item!.asset_url) update.asset_url = design!.thumbnailUrl;
  await db.from("content_items").update(update).eq("id", id);

  // Mirror the design into the Creative Kit (best-effort — the canva_url write
  // above is the source of truth; a failed Kit insert never blocks the flow).
  try {
    await db
      .from("content_assets")
      .insert({
        org_id: profile.org_id,
        content_item_id: id,
        brand_id: item!.brand_id,
        kind: "canva_design",
        provider: "canva",
        title: item!.title || "Canva design",
        url: design!.editUrl,
        thumbnail_url: design!.thumbnailUrl ?? null,
        status: "ready",
        created_by: profile.id,
        meta: { design_id: design!.designId ?? null, view_url: design!.viewUrl ?? null },
      })
      .select("id")
      .single();
  } catch (e) {
    console.error("[canva] creative-kit asset insert failed", e);
  }

  revalidatePath("/creative-studio");
  back("created");
}

// "Approve & Generate" a HeyGen video (LEADERSHIP ONLY — this is the approval
// gate, enforced server-side). HeyGen spends real money per render, so the whole
// flow funnels through here: re-check the role, re-compute the cost from the
// SAME shared module the preview used, record the job in the heygen_generations
// ledger as `pending`, then submit to HeyGen. On a successful submit the ledger
// row flips to `processing` and we ALSO write a content_assets row (kind
// heygen_video, status generating) linked to this item + generation, so the Kit
// shows the render immediately; the completion writer fills its URL/cost later.
async function generateHeygenVideo(formData: FormData) {
  "use server";
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const id = String(formData.get("id") ?? "").trim();
  const brandFilter = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  const back = (flag?: string) => {
    const p = new URLSearchParams();
    p.set("tab", "produce");
    if (brandFilter) p.set("brand", brandFilter);
    if (month) p.set("month", month);
    if (id) p.set("edit", id);
    if (flag) p.set("heygen", flag);
    redirect(`/creative-studio?${p.toString()}`);
  };
  if (!id) redirect(studioUrl({ tab: "produce", brand: brandFilter, month }));

  // Defense-in-depth: the submit must come from the explicit approve flow.
  if (String(formData.get("approved") ?? "") !== "yes") back("notapproved");
  if (!isHeygenConfigured()) back("notconfigured");

  const script = String(formData.get("script") ?? "").trim();
  const avatarId = String(formData.get("avatar_id") ?? "").trim();
  const voiceId = String(formData.get("voice_id") ?? "").trim();
  const tier = coerceTier(formData.get("tier"));
  if (!script || !avatarId || !voiceId) back("missingfields");

  // Cost is recomputed here — authoritative — from the shared module, never the
  // client-posted amount.
  const estimatedCost = estimateCostUsd(script, tier);

  // Title + brand come from the saved item (RLS scopes the read to the org).
  const { data: itemData } = await supabase
    .from("content_items")
    .select("id, title, brand_id")
    .eq("id", id)
    .maybeSingle();
  const item = itemData as unknown as { id: string; title: string; brand_id: string | null } | null;
  if (!item) back("error");
  const title = (item!.title || "Mthryve OS video").slice(0, 255);

  console.log(
    "[heygen] approve+generate by",
    profile.id,
    "item",
    id,
    "estCostUsd",
    estimatedCost,
    "tier",
    tier
  );

  // Record the job BEFORE submitting so a mid-flight crash still leaves a trace.
  const { data: rowData, error: insertErr } = await db
    .from("heygen_generations")
    .insert({
      org_id: profile.org_id,
      content_item_id: id,
      brand_id: item!.brand_id,
      title,
      script,
      avatar_id: avatarId,
      voice_id: voiceId,
      status: "pending",
      estimated_cost_usd: estimatedCost,
      requested_by: profile.id,
    })
    .select("id")
    .single();
  if (insertErr || !rowData?.id) {
    console.error("[heygen] ledger insert failed", insertErr);
    back("error");
  }
  const rowId = rowData!.id;

  // Submit to HeyGen (async). generateVideo never throws for an API error — it
  // returns { videoId, error }.
  const result = await generateVideo({ title, script, avatar_id: avatarId, voice_id: voiceId });

  if (result.videoId) {
    console.log("[heygen] submitted", rowId, "video_id", result.videoId);
    await db
      .from("heygen_generations")
      .update({
        heygen_video_id: result.videoId,
        status: "processing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);

    // Mirror into the Creative Kit as a still-rendering asset. Linked to this
    // generation via meta.heygen_generation_id so the completion writer can fill
    // its URL/thumbnail/cost when the render finishes. Best-effort.
    try {
      await db
        .from("content_assets")
        .insert({
          org_id: profile.org_id,
          content_item_id: id,
          brand_id: item!.brand_id,
          kind: "heygen_video",
          provider: "heygen",
          title,
          status: "generating",
          cost_usd: estimatedCost,
          created_by: profile.id,
          meta: { heygen_generation_id: rowId, heygen_video_id: result.videoId },
        })
        .select("id")
        .single();
    } catch (e) {
      console.error("[heygen] creative-kit asset insert failed", e);
    }

    revalidatePath("/creative-studio");
    back("submitted");
  }

  console.error("[heygen] submit failed", rowId, result.error);
  await db
    .from("heygen_generations")
    .update({
      status: "failed",
      error_message: result.error ?? "HeyGen submit failed.",
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);
  revalidatePath("/creative-studio");
  back("failed");
}

// "Approve & Generate" a fal.ai video (LEADERSHIP ONLY — the approval gate,
// enforced server-side). fal spends real money per clip, so the whole flow
// funnels through here: re-check the role, re-compute the cost from the SAME
// shared module the preview used, submit to fal's async queue, then record the
// job DIRECTLY in content_assets as status='processing' (kind veo_clip for hero
// models, broll for drafts; provider 'fal'). content_assets IS the ledger — no
// separate table, no schema/RLS changes. The completion writer (webhook / status
// poll) fills the url/thumbnail/duration and flips it to 'ready' later. We pass a
// per-request ?fal_webhook so fal calls us back; the poll is the fallback. The
// FAL_KEY is read at call time inside the client and never reaches the browser.
async function generateFalVideo(formData: FormData) {
  "use server";
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const id = String(formData.get("id") ?? "").trim();
  const brandFilter = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  const back = (flag?: string) => {
    const p = new URLSearchParams();
    p.set("tab", "produce");
    if (brandFilter) p.set("brand", brandFilter);
    if (month) p.set("month", month);
    if (id) p.set("edit", id);
    if (flag) p.set("video", flag);
    redirect(`/creative-studio?${p.toString()}`);
  };
  if (!id) redirect(studioUrl({ tab: "produce", brand: brandFilter, month }));

  // Defense-in-depth: the submit must come from the explicit approve flow.
  if (String(formData.get("approved") ?? "") !== "yes") back("notapproved");
  if (!isFalConfigured()) back("notconfigured");

  const prompt = String(formData.get("prompt") ?? "").trim();
  const imageUrl = String(formData.get("image_url") ?? "").trim();
  const model = coerceFalModel(formData.get("model"));
  const duration = coerceDuration(model, formData.get("duration"));
  // Need at least a prompt or a reference image.
  if (!prompt && !imageUrl) back("missingfields");

  // Cost is recomputed here — authoritative — from the shared module, never the
  // client-posted amount.
  const estimatedCost = estimateFalCostUsd(model, duration);

  // Title + brand come from the saved item (RLS scopes the read to the org).
  const { data: itemData } = await supabase
    .from("content_items")
    .select("id, title, brand_id")
    .eq("id", id)
    .maybeSingle();
  const item = itemData as unknown as { id: string; title: string; brand_id: string | null } | null;
  if (!item) back("error");
  const title = (item!.title || "Mthryve OS clip").slice(0, 255);

  // Image→video when an image is supplied and the model supports it; else text.
  const slug = imageUrl && model.imageSlug ? model.imageSlug : model.slug;
  const input: Record<string, unknown> = {
    prompt: prompt || title,
    duration: durationParam(model, duration),
  };
  if (imageUrl && model.imageSlug) input.image_url = imageUrl;

  // Build a per-request webhook URL (fal calls us back on completion). Derived
  // from the incoming request headers; guarded by FAL_WEBHOOK_SECRET when set.
  // If the origin can't be resolved we submit without a webhook and rely on the
  // /status poll — completion still lands.
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const secret = process.env.FAL_WEBHOOK_SECRET?.trim();
  const webhookUrl = host
    ? `${proto}://${host}/api/integrations/video/webhook${secret ? `?secret=${encodeURIComponent(secret)}` : ""}`
    : null;

  console.log(
    "[fal] approve+generate by",
    profile.id,
    "item",
    id,
    "model",
    model.id,
    "duration",
    duration,
    "estCostUsd",
    estimatedCost
  );

  // Submit to fal's queue (async). submitVideo never throws for an API error —
  // it returns { requestId, statusUrl, responseUrl, error }.
  const result = await submitVideo({ slug, input, webhookUrl });

  const kind = assetKindForModel(model);
  const baseMeta = {
    fal_model_id: model.id,
    fal_model_label: model.label,
    fal_slug: slug,
    prompt: prompt || null,
    image_url: imageUrl || null,
    duration_requested_seconds: duration,
    estimated: true as boolean,
  };

  if (result.requestId) {
    console.log("[fal] submitted", result.requestId, "→ content_assets", kind);
    // Record the job DIRECTLY as a processing asset — content_assets is the
    // ledger. The completion writer finds this row by meta.fal_request_id.
    try {
      await db
        .from("content_assets")
        .insert({
          org_id: profile.org_id,
          content_item_id: id,
          brand_id: item!.brand_id,
          kind,
          provider: "fal",
          title,
          status: "processing",
          cost_usd: estimatedCost,
          duration_seconds: duration,
          created_by: profile.id,
          meta: {
            ...baseMeta,
            fal_request_id: result.requestId,
            fal_status_url: result.statusUrl,
            fal_response_url: result.responseUrl,
          },
        })
        .select("id")
        .single();
    } catch (e) {
      console.error("[fal] creative-kit asset insert failed", e);
    }
    revalidatePath("/creative-studio");
    back("submitted");
  }

  // Submit failed — record a failed asset row for an honest trace, then report.
  console.error("[fal] submit failed", id, result.error);
  try {
    await db
      .from("content_assets")
      .insert({
        org_id: profile.org_id,
        content_item_id: id,
        brand_id: item!.brand_id,
        kind,
        provider: "fal",
        title,
        status: "failed",
        cost_usd: estimatedCost,
        created_by: profile.id,
        meta: { ...baseMeta, error: result.error ?? "fal submit failed." },
      })
      .select("id")
      .single();
  } catch (e) {
    console.error("[fal] failed-asset insert failed", e);
  }
  revalidatePath("/creative-studio");
  back("failed");
}

// "Approve & Render" an assembled listing video with JSON2Video (LEADERSHIP ONLY
// — the approval gate, enforced server-side). JSON2Video spends real money per
// render, so the whole flow funnels through here: re-check the role, re-read the
// item's ready Creative Kit assets, re-select + re-price them with the SAME
// shared module the preview used, compose them into a movie template, submit to
// JSON2Video's async API, then record the job DIRECTLY in content_assets as
// status='processing' (kind 'assembled_video', provider 'json2video').
// content_assets IS the ledger — no separate table, no schema/RLS changes. The
// completion writer (webhook / status poll) fills the url/duration and flips it to
// 'ready' later, and mirrors the finished MP4 onto content_items.asset_url. We
// pass a per-request webhook so JSON2Video calls us back; the poll is the
// fallback. The JSON2VIDEO_API_KEY is read at call time inside the client and
// never reaches the browser.
async function assembleListingVideo(formData: FormData) {
  "use server";
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const id = String(formData.get("id") ?? "").trim();
  const brandFilter = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  const back = (flag?: string) => {
    const p = new URLSearchParams();
    p.set("tab", "produce");
    if (brandFilter) p.set("brand", brandFilter);
    if (month) p.set("month", month);
    if (id) p.set("edit", id);
    if (flag) p.set("assemble", flag);
    redirect(`/creative-studio?${p.toString()}`);
  };
  if (!id) redirect(studioUrl({ tab: "produce", brand: brandFilter, month }));

  // Defense-in-depth: the submit must come from the explicit approve flow.
  if (String(formData.get("approved") ?? "") !== "yes") back("notapproved");
  if (!isJson2VideoConfigured()) back("notconfigured");

  const resolution = coerceResolution(formData.get("resolution"));

  // Title + brand come from the saved item (RLS scopes the read to the org).
  const { data: itemData } = await supabase
    .from("content_items")
    .select("id, title, brand_id")
    .eq("id", id)
    .maybeSingle();
  const item = itemData as unknown as { id: string; title: string; brand_id: string | null } | null;
  if (!item) back("error");
  const title = (item!.title || "Mthryve OS listing").slice(0, 255);

  // Re-read the item's ready Creative Kit (RLS-scoped) and re-select authoritatively
  // — never trust anything the client posted about which assets to compose.
  const { data: assetData } = await (supabase as unknown as AssetReadDb)
    .from("content_assets")
    .select(ASSET_COLS)
    .eq("content_item_id", id)
    .neq("status", ASSET_REMOVED_STATUS)
    .order("created_at", { ascending: true });
  const sourceAssets = ((assetData ?? []) as unknown as ContentAsset[])
    // Only finished assets are composable; the assembled_video kind can't feed itself.
    .filter((a) => a.kind !== "assembled_video")
    .filter((a) => ["ready", "completed", "done"].includes((a.status ?? "").toLowerCase()))
    .map(
      (a): AssemblySourceAsset => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        url: a.url,
        duration_seconds: a.duration_seconds,
      })
    );

  const selection = selectAssemblyAssets(sourceAssets);
  if (!hasRenderableScenes(selection)) back("empty");

  // Cost is recomputed here — authoritative — from the shared module, never the
  // client-posted amount.
  const estimatedCost = estimateAssemblyCostUsd(selection, resolution);
  const estimatedSeconds = estimateAssemblyDurationSeconds(selection);

  // Build a per-request webhook URL (JSON2Video calls us back on completion).
  // Derived from the incoming request headers; guarded by JSON2VIDEO_WEBHOOK_SECRET
  // when set. If the origin can't be resolved we submit without a webhook and rely
  // on the /status poll — completion still lands.
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const secret = process.env.JSON2VIDEO_WEBHOOK_SECRET?.trim();
  const webhookUrl = host
    ? `${proto}://${host}/api/integrations/assembly/webhook${secret ? `?secret=${encodeURIComponent(secret)}` : ""}`
    : null;

  console.log(
    "[json2video] approve+render by",
    profile.id,
    "item",
    id,
    "resolution",
    resolution.id,
    "scenes",
    selection.clips.length + selection.visuals.length,
    "estSeconds",
    estimatedSeconds,
    "estCostUsd",
    estimatedCost
  );

  const movie = buildMovie(selection, {
    resolution,
    title,
    webhookUrl,
    clientData: { content_item_id: id },
  });

  // Submit to JSON2Video (async). submitMovie never throws for an API error — it
  // returns { projectId, error }.
  const result = await submitMovie(movie);

  const baseMeta = {
    json2video_resolution: resolution.id,
    resolution_value: resolution.value,
    estimated_seconds: estimatedSeconds,
    source_asset_ids: sourceAssets.map((a) => a.id),
    clip_count: selection.clips.length,
    visual_count: selection.visuals.length,
    caption_count: selection.captions.length,
    has_music: Boolean(selection.music),
    has_voiceover: Boolean(selection.voiceover),
    estimated: true as boolean,
  };

  if (result.projectId) {
    console.log("[json2video] submitted", result.projectId, "→ content_assets assembled_video");
    // Record the job DIRECTLY as a processing asset — content_assets is the
    // ledger. The completion writer finds this row by meta.json2video_project.
    try {
      await db
        .from("content_assets")
        .insert({
          org_id: profile.org_id,
          content_item_id: id,
          brand_id: item!.brand_id,
          kind: "assembled_video",
          provider: "json2video",
          title: `${title} — assembled`.slice(0, 255),
          status: "processing",
          cost_usd: estimatedCost,
          duration_seconds: estimatedSeconds,
          created_by: profile.id,
          meta: { ...baseMeta, json2video_project: result.projectId },
        })
        .select("id")
        .single();
    } catch (e) {
      console.error("[json2video] assembled-video asset insert failed", e);
    }
    revalidatePath("/creative-studio");
    back("submitted");
  }

  // Submit failed — record a failed asset row for an honest trace, then report.
  console.error("[json2video] submit failed", id, result.error);
  try {
    await db
      .from("content_assets")
      .insert({
        org_id: profile.org_id,
        content_item_id: id,
        brand_id: item!.brand_id,
        kind: "assembled_video",
        provider: "json2video",
        title: `${title} — assembled`.slice(0, 255),
        status: "failed",
        cost_usd: estimatedCost,
        created_by: profile.id,
        meta: { ...baseMeta, error: result.error ?? "JSON2Video submit failed." },
      })
      .select("id")
      .single();
  } catch (e) {
    console.error("[json2video] failed-asset insert failed", e);
  }
  revalidatePath("/creative-studio");
  back("failed");
}

// "Attach asset" (any authed member) — manually add a content_assets row so an
// existing link (e.g. a CapCut export URL, a voiceover, a music track) can be
// captured in the Kit. org_id + created_by are stamped from the session; the
// kind is validated against the known set. Returns to the item's editor.
async function attachAsset(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const itemId = String(formData.get("item_id") ?? "").trim();
  const brand = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  const back = (flag?: string) => {
    const p = new URLSearchParams();
    p.set("tab", "produce");
    if (brand) p.set("brand", brand);
    if (month) p.set("month", month);
    if (itemId) p.set("edit", itemId);
    if (flag) p.set("kit", flag);
    redirect(`/creative-studio?${p.toString()}`);
  };
  if (!itemId) redirect(studioUrl({ tab: "produce", brand, month }));

  const kind = pick(ASSET_KINDS, formData.get("kind")) ?? "script";
  const title = trimOrNull(formData, "title");
  const url = trimOrNull(formData, "url");
  const provider = trimOrNull(formData, "provider");
  // Require at least a title or a URL so we never save an empty ghost row.
  if (!title && !url) back("empty");

  // Inherit the item's brand so the Library brand filter finds it.
  const { data: itemData } = await supabase
    .from("content_items")
    .select("id, brand_id")
    .eq("id", itemId)
    .maybeSingle();
  const item = itemData as unknown as { id: string; brand_id: string | null } | null;

  await db
    .from("content_assets")
    .insert({
      org_id: profile.org_id,
      content_item_id: itemId,
      brand_id: item?.brand_id ?? null,
      kind,
      provider,
      title,
      url,
      status: "ready",
      created_by: profile.id,
    })
    .select("id")
    .single();

  revalidatePath("/creative-studio");
  back("attached");
}

// Remove an asset from the Kit (LEADERSHIP + department heads only). content_
// assets has no DELETE RLS policy, so this is a soft-remove: an org-update that
// flips status to 'removed' (the Kit and Library both hide removed rows). We do
// NOT touch RLS or the schema.
async function removeAsset(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head"]);
  const supabase = createServerSupabaseClient();
  const assetId = String(formData.get("asset_id") ?? "").trim();
  const itemId = String(formData.get("item_id") ?? "").trim();
  const brand = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  if (!assetId) redirect(studioUrl({ tab: "produce", brand, month, edit: itemId || undefined }));
  await (supabase as unknown as DbShim)
    .from("content_assets")
    .update({ status: ASSET_REMOVED_STATUS, updated_at: new Date().toISOString() })
    .eq("id", assetId);
  revalidatePath("/creative-studio");
  redirect(studioUrl({ tab: "produce", brand, month, edit: itemId || undefined }));
}

// Save a CapCut link onto the content item (any authed member). Kept as its own
// action so the "Open in CapCut" control in the Kit can save/replace the link
// without submitting the whole editor.
async function saveCapcut(formData: FormData) {
  "use server";
  await requireProfile();
  const supabase = createServerSupabaseClient();
  const itemId = String(formData.get("item_id") ?? "").trim();
  const brand = String(formData.get("brand") ?? "");
  const month = String(formData.get("month") ?? "") || currentMonth();
  const capcut = trimOrNull(formData, "capcut_url");
  if (!itemId) redirect(studioUrl({ tab: "produce", brand, month }));
  await (supabase as unknown as DbShim)
    .from("content_items")
    .update({ capcut_url: capcut })
    .eq("id", itemId);
  revalidatePath("/creative-studio");
  redirect(studioUrl({ tab: "produce", brand, month, edit: itemId }));
}

// --- Page -------------------------------------------------------------------

export default async function CreativeStudioPage({
  searchParams,
}: {
  searchParams: StudioSearchParams;
}) {
  const profile = await requireModule("/creative-studio");
  const supabase = createServerSupabaseClient();

  const canDelete =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  // Same leadership set may connect Canva, approve HeyGen renders, and remove
  // Kit assets. The page-level checks in each action are the real guard; these
  // booleans just shape the UI.
  const canManageCanva = canDelete;
  const canGenerateHeygen = canDelete;
  const canGenerateFal = canDelete;
  const canAssemble = canDelete;
  const canManageAssets = canDelete;
  const heygenConfigured = isHeygenConfigured();
  const falConfigured = isFalConfigured();
  const json2videoConfigured = isJson2VideoConfigured();

  const tab = tabOf(searchParams.tab);
  const month = isMonth(searchParams.month) ? (searchParams.month as string) : currentMonth();
  const brand = (searchParams.brand ?? "").trim();
  const editParam = (searchParams.edit ?? "").trim();
  const kindParam = (searchParams.kind ?? "").trim();

  // The brand selector always lists every brand (RLS scopes to the org).
  const { data: brandsData } = await supabase.from("brands").select("id, name").order("name");
  const brands = (brandsData ?? []) as unknown as Brand[];
  const brandName = new Map(brands.map((b) => [b.id, b.name]));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Creative Studio", TAB_LABEL[tab]]} profile={profile}>
     <PageHeader
  title="Creative Studio"
  action={
          tab === "plan" || tab === "produce" ? (
            <Link
              href={studioUrl({ tab: "produce", brand, month, edit: "new" })}
              className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400"
            >
              + New content
            </Link>
          ) : undefined
        }
      />

      <StudioTabBar active={tab} brand={brand} month={month} />

      {tab === "plan" && (
        <PlanTab
          supabase={supabase}
          profile={profile}
          brands={brands}
          brandName={brandName}
          brand={brand}
          month={month}
          canManageCanva={canManageCanva}
          heygenConfigured={heygenConfigured}
          searchParams={searchParams}
          updateItemStatus={updateItemStatus}
        />
      )}

      {tab === "produce" && (
        <ProduceTab
          supabase={supabase}
          profile={profile}
          brands={brands}
          brandName={brandName}
          brand={brand}
          month={month}
          editParam={editParam}
          canDelete={canDelete}
          canManageCanva={canManageCanva}
          canManageAssets={canManageAssets}
          canGenerateHeygen={canGenerateHeygen}
          heygenConfigured={heygenConfigured}
          canGenerateFal={canGenerateFal}
          falConfigured={falConfigured}
          canAssemble={canAssemble}
          json2videoConfigured={json2videoConfigured}
          searchParams={searchParams}
        />
      )}

      {tab === "library" && (
        <LibraryTab
          supabase={supabase}
          brands={brands}
          brandName={brandName}
          brand={brand}
          kind={kindParam}
          view={libViewOf(searchParams.view)}
          folder={(searchParams.folder ?? "").trim()}
          mediaFlag={(searchParams.media ?? "").trim()}
          uploadAction={uploadMediaAssets}
          deleteMediaAction={deleteMediaAsset}
        />
      )}

      {tab === "vesper" && (
        <VesperTab
          supabase={supabase}
          brands={brands}
          brandName={brandName}
          brand={brand}
          flag={(searchParams.vesper ?? "").trim()}
          enqueueAction={enqueueVesperJob}
          segmentAction={runVesperSegmentation}
        />
      )}

      {tab === "performance" && (
        <PerformanceTab
          supabase={supabase}
          profile={profile}
          brands={brands}
          brandName={brandName}
          brand={brand}
          month={month}
          canSeeAll={canDelete}
          view={perfViewOf(searchParams.view)}
          editPerfId={(searchParams.editperf ?? "").trim()}
          saveAction={savePerformance}
          deleteAction={deletePerformance}
        />
      )}
    </AppShell>
  );
}

// --- Tab bar ----------------------------------------------------------------
// A plain (server) component — the active tab is known from props, so no client
// hook is needed. Brand + month ride along so context persists across tabs.
function StudioTabBar({ active, brand, month }: { active: Tab; brand: string; month: string }) {
  return (
    <div className="mb-6 flex flex-wrap gap-1 border-b border-charcoal-700/60">
      {TABS.map((t) => {
        const isActive = t === active;
        return (
          <Link
            key={t}
            href={studioUrl({ tab: t, brand, month })}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px rounded-t-md border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              isActive
                ? "border-teal-400 text-teal-300"
                : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {TAB_LABEL[t]}
          </Link>
        );
      })}
    </div>
  );
}

// --- Plan tab (calendar + board + ledger) -----------------------------------
async function PlanTab({
  supabase,
  profile,
  brands,
  brandName,
  brand,
  month,
  canManageCanva,
  heygenConfigured,
  searchParams,
  updateItemStatus,
}: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  profile: SessionProfile;
  brands: Brand[];
  brandName: Map<string, string>;
  brand: string;
  month: string;
  canManageCanva: boolean;
  heygenConfigured: boolean;
  searchParams: StudioSearchParams;
  updateItemStatus: (formData: FormData) => Promise<void>;
}) {
  const monthStart = `${month}-01`;
  const monthEnd = `${shiftMonth(month, 1)}-01`; // exclusive upper bound
  // Active list by default; the Archived view flips both content_items reads.
  const archived = searchParams?.archived === "1";

  const COLS =
    "id, org_id, brand_id, initiative_id, title, content_type, status, platform, sales_source, pillar, assignee_id, publish_date, brief, canva_url, heygen_url, capcut_url, asset_url, notes, created_by, archived_at";
  const monthQuery = () => {
    let q = supabase
      .from("content_items")
      .select(COLS)
      .gte("publish_date", monthStart)
      .lt("publish_date", monthEnd);
    if (brand) q = q.eq("brand_id", brand);
    q = archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
    return q.order("publish_date", { ascending: true });
  };
  const undatedQuery = () => {
    let q = supabase.from("content_items").select(COLS).is("publish_date", null);
    if (brand) q = q.eq("brand_id", brand);
    q = archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
    return q.order("title", { ascending: true });
  };
  // Initiatives overlapping the visible month (nullable dates count as open-ended),
  // brand-scoped when a brand filter is active. RLS scopes reads to the org.
  // Always active-only — archived initiatives never surface on the calendar.
  const initiativesQuery = () => {
    let q = supabase
      .from("brand_initiatives")
      .select("id, brand_id, platform, type, name, start_date, end_date, status, note")
      .or(`start_date.is.null,start_date.lt.${monthEnd}`)
      .or(`end_date.is.null,end_date.gte.${monthStart}`)
      .is("archived_at", null);
    if (brand) q = q.eq("brand_id", brand);
    return q.order("start_date", { ascending: true, nullsFirst: true });
  };

  // Scheduled live sessions (Live Ops schedules live selling on this same
  // calendar). Only status='scheduled' rows belong on the planning view — once a
  // live goes 'live'/'ended' on the Live Selling page it moves off. Brand-scoped
  // when a brand filter is active; read loosely (live_sessions/anchors aren't in
  // the generated types) but still RLS-scoped to the org. The calendar buckets
  // each session by its Manila start day, so a scheduled row landing in another
  // month is simply carried and filtered client-side.
  const u = supabase as unknown as { from: (t: string) => any };
  const liveQuery = () => {
    let q = u
      .from("live_sessions")
      .select("id, org_id, brand_id, anchor_id, platform, title, status, started_at, duration_minutes, notes")
      .eq("status", "scheduled");
    if (brand) q = q.eq("brand_id", brand);
    return q.order("started_at", { ascending: true, nullsFirst: false });
  };

  const [usersRes, monthRes, undatedRes, initiativesRes, liveRes, anchorsRes] = await Promise.all([
    supabase.from("users").select("id, full_name").order("full_name"),
    monthQuery(),
    undatedQuery(),
    initiativesQuery(),
    liveQuery(),
    u.from("anchors").select("id, name").eq("status", "active").order("name"),
  ]);

  const people = (usersRes.data ?? []) as unknown as Person[];
  const monthItems = (monthRes.data ?? []) as unknown as ContentItem[];
  const undatedItems = (undatedRes.data ?? []) as unknown as ContentItem[];
  const planInitiatives = (initiativesRes.data ?? []) as unknown as PlanInitiative[];
  const planLiveSessions = (liveRes.data ?? []) as unknown as PlanLiveSession[];
  const planAnchors = (anchorsRes.data ?? []) as unknown as { id: string; name: string }[];
  const personName = new Map(people.map((p) => [p.id, p.full_name]));

  // Brand grounding for the calendar's AI "Generate" panel — the brand's latest
  // account_briefing summary, composed server-side (RLS-scoped) and keyed by
  // brand_id. Covers every brand with a calendar item plus the active filter, so
  // the panel can ground each item in its own brand's real situation. Best-effort:
  // brands with no briefing simply fall back to item-only grounding.
  const groundBrandIds = Array.from(
    new Set([...monthItems.map((i) => i.brand_id), brand].filter(Boolean) as string[])
  );
  const brandContext: Record<string, BrandContext> = {};
  await Promise.all(
    groundBrandIds.map(async (id) => {
      const brief = await getLatestAccountBriefing(supabase, id);
      brandContext[id] = {
        name: brandName.get(id) ?? "",
        summary: brief?.summary ?? null,
        confidence: brief?.data_confidence ?? null,
      };
    })
  );

  // Canva connection state — read process.env inside the request scope so the
  // runtime-only "Sensitive" vars are visible per request. Never throws.
  const hasCanvaClientId = Boolean(process.env.CANVA_CLIENT_ID);
  const hasCanvaClientSecret = Boolean(process.env.CANVA_CLIENT_SECRET);
  const canvaConfigured = hasCanvaClientId && hasCanvaClientSecret;
  const canvaMissingVar = !hasCanvaClientId
    ? "client id"
    : !hasCanvaClientSecret
      ? "client secret"
      : null;
  const canvaStatus = await getCanvaConnectionStatus(profile.org_id);
  const canvaConnected = canvaStatus.connected;

  // HeyGen ledger — this org's generations (RLS scopes to the org).
  const HEYGEN_COLS =
    "id, content_item_id, brand_id, title, status, video_url, thumbnail_url, estimated_cost_usd, actual_cost_usd, duration_seconds, error_message, created_at";
  const { data: heygenRowsData } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        order: (
          c: string,
          o: { ascending: boolean }
        ) => { limit: (n: number) => Promise<{ data: unknown[] | null }> };
      };
    };
  })
    .from("heygen_generations")
    .select(HEYGEN_COLS)
    .order("created_at", { ascending: false })
    .limit(50);
  const heygenRows = (heygenRowsData ?? []) as unknown as HeygenGeneration[];
  const heygenInFlight = heygenRows.some(
    (r) => r.status === "pending" || r.status === "processing"
  );

  const summary = {
    total: monthItems.length,
    scheduled: monthItems.filter((i) => i.status === "scheduled").length,
    published: monthItems.filter((i) => i.status === "published").length,
    production: monthItems.filter((i) => i.status === "production").length,
  };

  const boardItems = [...monthItems, ...undatedItems];
  const boardByStage = new Map<string, ContentItem[]>();
  for (const stage of BOARD_STAGES) boardByStage.set(stage, []);
  for (const i of boardItems) {
    const bucket = boardByStage.get(i.status);
    if (bucket) bucket.push(i);
  }

  // Canva post-flow banner (OAuth flags take precedence over the action flag).
  const CANVA_ERROR_REASON: Record<string, string> = {
    missing_client_id: "the Canva client ID isn’t configured (CANVA_CLIENT_ID).",
    missing_client_secret: "the Canva client secret isn’t configured (CANVA_CLIENT_SECRET).",
    missing_verifier:
      "the security cookie expired or was missing — start the connection again from this page.",
    missing_code: "Canva didn’t return an authorization code.",
    invalid_state: "the security check failed (state mismatch) — please try connecting again.",
    exchange_failed:
      "the token exchange with Canva failed. Confirm the redirect URI registered in your Canva app matches this deployment (see /api/canva/diag).",
    save_failed: "the token couldn’t be saved to the vault (service-role / database issue).",
    access_denied: "authorization was declined.",
  };
  const canvaError = (searchParams.canva_error ?? "").trim();
  const canvaConnectedFlag = searchParams.canva_connected === "1";
  const canvaBanner: { tone: "ok" | "warn" | "error"; text: string } | null = canvaConnectedFlag
    ? { tone: "ok", text: "Canva connected ✓ — you can now create designs from any content item." }
    : canvaError
      ? {
          tone: "error",
          text: `Canva connection failed: ${
            CANVA_ERROR_REASON[canvaError] ?? `Canva reported “${canvaError}”.`
          }`,
        }
      : searchParams.canva === "connected"
        ? { tone: "ok", text: "Canva connected ✓ — you can now create designs from any content item." }
        : searchParams.canva === "created"
          ? { tone: "ok", text: "Design created in Canva — the edit link is saved on this item." }
          : searchParams.canva === "needsconnect"
            ? { tone: "warn", text: "Connect Canva first, then try creating the design again." }
            : searchParams.canva === "notconfigured"
              ? { tone: "warn", text: "Canva isn’t set up yet (missing configuration)." }
              : searchParams.canva === "error"
                ? { tone: "warn", text: "Something went wrong talking to Canva. Please try again." }
                : null;

  return (
    <>
      {/* Filter bar: brand + month nav + Canva + exports */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <BrandFilter brands={brands} selected={brand} month={month} />
        <div className="flex items-center gap-2">
          <Link
            href={studioUrl({ tab: "plan", brand, month: shiftMonth(month, -1) })}
            aria-label="Previous month"
            className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-800"
          >
            ←
          </Link>
          <span className="min-w-[10rem] text-center text-sm font-semibold text-ink">
            {monthLabel(month)}
          </span>
          <Link
            href={studioUrl({ tab: "plan", brand, month: shiftMonth(month, 1) })}
            aria-label="Next month"
            className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-800"
          >
            →
          </Link>
          {month !== currentMonth() && (
            <Link
              href={studioUrl({ tab: "plan", brand, month: currentMonth() })}
              className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-xs text-ink-muted hover:bg-charcoal-800"
            >
              Today
            </Link>
          )}
        </div>

        <div className="flex items-center gap-2 sm:ml-auto">
          {!canvaConfigured ? (
            <span
              title="Set CANVA_CLIENT_ID / CANVA_CLIENT_SECRET to enable"
              className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-xs text-ink-dim"
            >
              🎨 Canva not set up yet{canvaMissingVar ? ` (missing ${canvaMissingVar})` : ""}
            </span>
          ) : canvaConnected ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-400">
              🎨 Canva connected ✓
            </span>
          ) : canManageCanva ? (
            <a
              href="/api/canva/connect"
              className="inline-flex items-center gap-1.5 rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-xs font-medium text-teal-300 hover:bg-teal-500/20"
            >
              🎨 Connect Canva
            </a>
          ) : (
            <span className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-xs text-ink-dim">
              🎨 Canva not connected
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <a
            href={exportUrl("xlsx", brand, month)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-800"
          >
            ⬇ Download Excel
          </a>
          <a
            href={exportUrl("pdf", brand, month)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-800"
          >
            ⬇ Download PDF
          </a>
        </div>
      </div>

      {canvaBanner && (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            canvaBanner.tone === "ok"
              ? "border-green-500/40 bg-green-500/10 text-green-300"
              : canvaBanner.tone === "error"
                ? "border-red-500/40 bg-red-500/10 text-red-300"
                : "border-gold-500/40 bg-gold-500/10 text-gold-300"
          }`}
        >
          {canvaBanner.text}
        </div>
      )}

      {/* Summary tiles */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Items this month" value={summary.total} hint={monthLabel(month)} />
        <StatTile
          label="Scheduled"
          value={summary.scheduled}
          valueClassName="text-teal-300"
          hint="Queued to publish"
        />
        <StatTile
          label="Published"
          value={summary.published}
          valueClassName="text-green-400"
          hint="Live this month"
        />
        <StatTile
          label="In production"
          value={summary.production}
          valueClassName="text-gold-400"
          hint="Being made"
        />
      </div>

      {/* Initiatives band + editable month calendar. Keyed by month+brand so it
          remounts (and re-seeds its optimistic state) when the view changes. */}
      <PlanCalendar
        key={`${month}:${brand}`}
        orgId={profile.org_id}
        userId={profile.id}
        role={profile.role}
        month={month}
        monthLabel={monthLabel(month)}
        brand={brand}
        brands={brands.map((b) => ({ id: b.id, name: b.name }))}
        people={people.map((p) => ({ id: p.id, name: p.full_name }))}
        anchors={planAnchors.map((a) => ({ id: a.id, name: a.name }))}
        items={monthItems as unknown as PlanItem[]}
        initiatives={planInitiatives}
        liveSessions={planLiveSessions}
        brandContext={brandContext}
      />

      {/* Status board — the pipeline */}
      <SectionCard
        title="Status board"
        bodyClassName="overflow-x-auto"
        action={
          <ArchivedToggle
            basePath="/creative-studio"
            archived={archived}
            params={{
              tab: "plan",
              month,
              ...(brand ? { brand } : {}),
              ...(searchParams.view ? { view: searchParams.view } : {}),
            }}
          />
        }
      >
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="grid min-w-[56rem] grid-cols-5 gap-3">
          {BOARD_STAGES.map((stage) => {
            const cards = boardByStage.get(stage) ?? [];
            return (
              <div key={stage} className="flex flex-col gap-2">
                <div className="flex items-center justify-between px-1">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_CHIP[stage]}`}
                  >
                    {STATUS_LABEL[stage]}
                  </span>
                  <span className="font-mono text-[11px] text-ink-dim">{cards.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {cards.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-charcoal-700 p-3 text-center text-[11px] text-ink-dim">
                      Empty
                    </p>
                  ) : (
                    cards.map((i) => (
                      <div
                        key={i.id}
                        className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-2.5"
                      >
                        <Link
                          href={studioUrl({ tab: "produce", brand, month, edit: i.id })}
                          className="block truncate text-sm font-medium text-ink hover:text-teal-300"
                        >
                          <span aria-hidden className="mr-1">
                            {TYPE_ICON[(i.content_type as ContentType) ?? "other"] ?? "📄"}
                          </span>
                          {i.title}
                        </Link>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Badge tone="muted">
                            {TYPE_LABEL[(i.content_type as ContentType) ?? "other"] ?? i.content_type}
                          </Badge>
                          {i.brand_id && brandName.get(i.brand_id) && (
                            <span className="text-[11px] text-ink-muted">
                              {brandName.get(i.brand_id)}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-ink-dim">
                            {i.publish_date ? i.publish_date.slice(0, 10) : "No date"}
                          </span>
                          {i.assignee_id && personName.get(i.assignee_id) && (
                            <span className="truncate text-[10px] text-ink-muted">
                              {personName.get(i.assignee_id)}
                            </span>
                          )}
                        </div>
                        <div className="mt-2">
                          <InlineStatusSelect
                            id={i.id}
                            status={i.status}
                            brand={brand}
                            month={month}
                            action={updateItemStatus}
                          />
                        </div>
                        <div className="mt-2 border-t border-charcoal-800/60 pt-2">
                          <RowActions
                            {...rowActionProps(
                              "content_items",
                              i as unknown as Record<string, unknown>,
                              profile
                            )}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </div>
        {boardItems.length === 0 && (
          <p className="mt-4 text-center text-sm text-ink-muted">
            No content items yet{brand ? ` for ${brandName.get(brand) ?? "this brand"}` : ""}. Use
            “+ New content” to add the first one.
          </p>
        )}
      </SectionCard>

      {/* HeyGen Videos ledger */}
      <SectionCard
        title="HeyGen Videos"
        className="mt-6"
        bodyClassName="overflow-x-auto"
        action={
          heygenInFlight ? (
            <a
              href={`/api/integrations/heygen/status?redirect=${encodeURIComponent(
                studioUrl({ tab: "plan", brand, month })
              )}`}
              className="text-xs text-teal-300 hover:text-teal-200"
            >
              ↻ Refresh statuses
            </a>
          ) : undefined
        }
      >
        {heygenRows.length === 0 ? (
          <p className="py-2 text-sm text-ink-muted">
            No HeyGen videos yet. Open a content item on the Produce tab and use{" "}
            <span className="text-ink">Generate video with HeyGen</span> to create one
            {heygenConfigured ? "" : " (needs HEYGEN_API_KEY)"}.
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-charcoal-700/60 text-left font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                <th className="px-2 py-2 font-normal">Preview</th>
                <th className="px-2 py-2 font-normal">Title</th>
                <th className="px-2 py-2 font-normal">Brand</th>
                <th className="px-2 py-2 font-normal">Status</th>
                <th className="px-2 py-2 font-normal">Est. / Actual</th>
                <th className="px-2 py-2 font-normal">Video</th>
              </tr>
            </thead>
            <tbody>
              {heygenRows.map((g) => {
                const tone: BadgeTone =
                  g.status === "completed"
                    ? "teal"
                    : g.status === "failed"
                      ? "red"
                      : g.status === "processing"
                        ? "amber"
                        : "muted";
                return (
                  <tr key={g.id} className="border-b border-charcoal-800/60 align-middle">
                    <td className="px-2 py-2">
                      {g.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={g.thumbnail_url}
                          alt=""
                          className="h-10 w-16 rounded object-cover"
                        />
                      ) : (
                        <div className="flex h-10 w-16 items-center justify-center rounded bg-charcoal-800 text-ink-dim">
                          🎬
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <span className="text-ink">{g.title || "Untitled"}</span>
                      {g.status === "failed" && g.error_message && (
                        <span className="mt-0.5 block max-w-[18rem] truncate text-[11px] text-red-300/80">
                          {g.error_message}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-ink-muted">
                      {(g.brand_id && brandName.get(g.brand_id)) || "—"}
                    </td>
                    <td className="px-2 py-2">
                      <Badge tone={tone}>{g.status}</Badge>
                    </td>
                    <td className="px-2 py-2 font-mono text-[12px] text-ink-muted">
                      {formatUsd(g.estimated_cost_usd)}
                      {" / "}
                      <span className={g.actual_cost_usd != null ? "text-ink" : ""}>
                        {formatUsd(g.actual_cost_usd)}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      {safeUrl(g.video_url) ? (
                        <a
                          href={safeUrl(g.video_url)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-teal-300 hover:text-teal-200"
                        >
                          Open ↗
                        </a>
                      ) : (
                        <span className="text-ink-dim">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}

// --- Produce tab (item editor + Creative Kit) -------------------------------
async function ProduceTab({
  supabase,
  profile,
  brands,
  brandName,
  brand,
  month,
  editParam,
  canDelete,
  canManageCanva,
  canManageAssets,
  canGenerateHeygen,
  heygenConfigured,
  canGenerateFal,
  falConfigured,
  canAssemble,
  json2videoConfigured,
  searchParams,
}: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  profile: { org_id: string };
  brands: Brand[];
  brandName: Map<string, string>;
  brand: string;
  month: string;
  editParam: string;
  canDelete: boolean;
  canManageCanva: boolean;
  canManageAssets: boolean;
  canGenerateHeygen: boolean;
  heygenConfigured: boolean;
  canGenerateFal: boolean;
  falConfigured: boolean;
  canAssemble: boolean;
  json2videoConfigured: boolean;
  searchParams: StudioSearchParams;
}) {
  const isNew = editParam === "new";

  // Reference data for the editor selects.
  const [initiativesRes, usersRes] = await Promise.all([
    supabase.from("brand_initiatives").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
  ]);
  const initiatives = (initiativesRes.data ?? []) as unknown as Initiative[];
  const people = (usersRes.data ?? []) as unknown as Person[];

  // The editor target: an existing item (fetched fresh so it reflects the latest
  // brief/urls), the "new" sentinel, or nothing (→ picker).
  let editItem: ContentItem | null = null;
  if (editParam && !isNew) {
    const { data } = await supabase
      .from("content_items")
      .select(
        "id, org_id, brand_id, initiative_id, title, content_type, status, platform, sales_source, pillar, assignee_id, publish_date, brief, canva_url, heygen_url, capcut_url, asset_url, notes, created_by"
      )
      .eq("id", editParam)
      .maybeSingle();
    editItem = (data as unknown as ContentItem | null) ?? null;
  }
  const editorOpen = isNew || !!editItem;

  // When nothing is open, show a picker of recent items to work on.
  if (!editorOpen) {
    let pq = supabase
      .from("content_items")
      .select("id, title, brand_id, content_type, status, publish_date")
      .order("created_at", { ascending: false })
      .limit(100);
    if (brand) pq = pq.eq("brand_id", brand);
    const { data: pickerData } = await pq;
    const items = (pickerData ?? []) as unknown as PickerItem[];

    return (
      <SectionCard title="Choose an item to produce">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <BrandFilterProduce brands={brands} selected={brand} month={month} />
          <Link
            href={studioUrl({ tab: "produce", brand, month, edit: "new" })}
            className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400"
          >
            + New content
          </Link>
        </div>
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">
            No content items yet{brand ? ` for ${brandName.get(brand) ?? "this brand"}` : ""}. Use “+
            New content” to create the first one, or plan one on the Plan tab.
          </p>
        ) : (
          <ul className="divide-y divide-charcoal-800/60">
            {items.map((i) => (
              <li key={i.id}>
                <Link
                  href={studioUrl({ tab: "produce", brand, month, edit: i.id })}
                  className="flex items-center gap-3 px-1 py-2.5 hover:bg-charcoal-800/40"
                >
                  <span aria-hidden>{TYPE_ICON[(i.content_type as ContentType) ?? "other"] ?? "📄"}</span>
                  <span className="flex-1 truncate text-sm text-ink">{i.title}</span>
                  {i.brand_id && brandName.get(i.brand_id) && (
                    <span className="hidden text-xs text-ink-muted sm:inline">
                      {brandName.get(i.brand_id)}
                    </span>
                  )}
                  <Badge tone="muted">{STATUS_LABEL[(i.status as Status) ?? "idea"] ?? i.status}</Badge>
                  <span className="hidden font-mono text-[10px] text-ink-dim md:inline">
                    {i.publish_date ? i.publish_date.slice(0, 10) : "No date"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    );
  }

  // Editor is open — load HeyGen lists + wallet (only for a saved item) and the
  // item's Creative Kit assets.
  let heygenAvatars: HeygenAvatar[] = [];
  let heygenVoices: HeygenVoice[] = [];
  let heygenWalletEmpty = false;
  let assets: ContentAsset[] = [];
  if (editItem && heygenConfigured) {
    const [avatars, voices, wallet] = await Promise.all([listAvatars(), listVoices(), getWallet()]);
    heygenAvatars = avatars;
    heygenVoices = voices;
    heygenWalletEmpty = wallet.remainingQuota != null && wallet.remainingQuota <= 0;
  }
  if (editItem) {
    const { data: assetData } = await (supabase as unknown as AssetReadDb)
      .from("content_assets")
      .select(ASSET_COLS)
      .eq("content_item_id", editItem.id)
      .neq("status", ASSET_REMOVED_STATUS)
      .order("created_at", { ascending: false });
    assets = (assetData ?? []) as unknown as ContentAsset[];
  }

  // Canva state for the editor's "Create in Canva" action.
  const canvaConfigured =
    Boolean(process.env.CANVA_CLIENT_ID) && Boolean(process.env.CANVA_CLIENT_SECRET);
  const canvaStatus = await getCanvaConnectionStatus(profile.org_id);
  const canvaConnected = canvaStatus.connected;

  const briefError =
    searchParams.berr === "api"
      ? "Brief generation is temporarily unavailable. Try again in a moment."
      : searchParams.berr === "config"
        ? "The AI brief generator isn’t configured yet (missing ANTHROPIC_API_KEY)."
        : null;

  const heygenBanner: { tone: "ok" | "warn" | "error"; text: string } | null =
    searchParams.heygen === "submitted"
      ? {
          tone: "ok",
          text: "Video submitted to HeyGen — it’s rendering now. It appears in the Creative Kit and in HeyGen Videos on the Plan tab, and on this item when it finishes.",
        }
      : searchParams.heygen === "failed"
        ? { tone: "error", text: "HeyGen couldn’t start the render. See HeyGen Videos on the Plan tab for the error." }
        : searchParams.heygen === "notapproved"
          ? { tone: "warn", text: "Nothing was submitted — a HeyGen video needs an explicit Approve & Generate." }
          : searchParams.heygen === "notconfigured"
            ? { tone: "warn", text: "HeyGen isn’t set up yet (missing HEYGEN_API_KEY)." }
            : searchParams.heygen === "missingfields"
              ? { tone: "warn", text: "Pick an avatar and voice and provide a script before generating." }
              : searchParams.heygen === "error"
                ? { tone: "warn", text: "Something went wrong submitting to HeyGen. Please try again." }
                : null;

  const videoBanner: { tone: "ok" | "warn" | "error"; text: string } | null =
    searchParams.video === "submitted"
      ? {
          tone: "ok",
          text: "Clip submitted to fal — it’s rendering now. It appears in the Creative Kit as ‘processing’ and fills in when it finishes.",
        }
      : searchParams.video === "failed"
        ? { tone: "error", text: "fal couldn’t start the render. See the failed clip in the Creative Kit for the reason." }
        : searchParams.video === "notapproved"
          ? { tone: "warn", text: "Nothing was submitted — a fal video needs an explicit Approve & Generate." }
          : searchParams.video === "notconfigured"
            ? { tone: "warn", text: "fal isn’t set up yet (missing FAL_KEY)." }
            : searchParams.video === "missingfields"
              ? { tone: "warn", text: "Add a prompt or a reference image before generating." }
              : searchParams.video === "error"
                ? { tone: "warn", text: "Something went wrong submitting to fal. Please try again." }
                : null;

  const kitBanner: { tone: "ok" | "warn"; text: string } | null =
    searchParams.kit === "attached"
      ? { tone: "ok", text: "Asset attached to this item’s Creative Kit." }
      : searchParams.kit === "empty"
        ? { tone: "warn", text: "Give the asset a title or a URL before attaching." }
        : null;

  const assembleBanner: { tone: "ok" | "warn" | "error"; text: string } | null =
    searchParams.assemble === "submitted"
      ? {
          tone: "ok",
          text: "Listing video submitted to JSON2Video — it’s rendering now. It appears in the Creative Kit as ‘processing’ under Assembled videos and fills in when it finishes.",
        }
      : searchParams.assemble === "failed"
        ? { tone: "error", text: "JSON2Video couldn’t start the render. See the failed assembly in the Creative Kit for the reason." }
        : searchParams.assemble === "notapproved"
          ? { tone: "warn", text: "Nothing was submitted — an assembled video needs an explicit Approve & Render." }
          : searchParams.assemble === "notconfigured"
            ? { tone: "warn", text: "JSON2Video isn’t set up yet (missing JSON2VIDEO_API_KEY)." }
            : searchParams.assemble === "empty"
              ? { tone: "warn", text: "Add at least one finished clip or visual to the Creative Kit before assembling." }
              : searchParams.assemble === "error"
                ? { tone: "warn", text: "Something went wrong submitting to JSON2Video. Please try again." }
                : null;

  const canvaBanner: { tone: "ok" | "warn" | "error"; text: string } | null =
    searchParams.canva === "created"
      ? { tone: "ok", text: "Design created in Canva — saved to this item and its Creative Kit." }
      : searchParams.canva === "needsconnect"
        ? { tone: "warn", text: "Connect Canva first (on the Plan tab), then try again." }
        : searchParams.canva === "notconfigured"
          ? { tone: "warn", text: "Canva isn’t set up yet (missing configuration)." }
          : searchParams.canva === "error"
            ? { tone: "warn", text: "Something went wrong talking to Canva. Please try again." }
            : null;

  return (
    <>
      {canvaBanner && <FlowBanner tone={canvaBanner.tone} text={canvaBanner.text} />}
      {heygenBanner && <FlowBanner tone={heygenBanner.tone} text={heygenBanner.text} />}
      {videoBanner && <FlowBanner tone={videoBanner.tone} text={videoBanner.text} />}
      {assembleBanner && <FlowBanner tone={assembleBanner.tone} text={assembleBanner.text} />}
      {kitBanner && <FlowBanner tone={kitBanner.tone} text={kitBanner.text} />}

      <ContentEditor
        item={editItem}
        brands={brands}
        initiatives={initiatives}
        people={people}
        brand={brand}
        month={month}
        canDelete={canDelete}
        briefError={briefError}
        canvaConfigured={canvaConfigured}
        canvaConnected={canvaConnected}
        canManageCanva={canManageCanva}
        saveAction={saveContentItem}
        deleteAction={deleteContentItem}
        generateAction={generateContentBrief}
        createInCanvaAction={createInCanva}
        heygenConfigured={heygenConfigured}
        canGenerateHeygen={canGenerateHeygen}
        heygenAvatars={heygenAvatars}
        heygenVoices={heygenVoices}
        heygenWalletEmpty={heygenWalletEmpty}
        generateHeygenAction={generateHeygenVideo}
        falConfigured={falConfigured}
        canGenerateFal={canGenerateFal}
        generateFalAction={generateFalVideo}
      />

      {/* Creative Kit — only for a saved item (assets link to a content_item). */}
      {editItem && (
        <CreativeKit
          item={editItem}
          assets={assets}
          brand={brand}
          month={month}
          canManageAssets={canManageAssets}
          canAssemble={canAssemble}
          json2videoConfigured={json2videoConfigured}
          attachAction={attachAsset}
          removeAction={removeAsset}
          saveCapcutAction={saveCapcut}
          assembleAction={assembleListingVideo}
        />
      )}
    </>
  );
}

// --- Library tab (org-wide asset gallery) -----------------------------------
// Library sub-tabs: the Media Library (files in the creative-media bucket) is
// primary; the older content_assets "Asset Links" gallery is secondary.
type LibraryView = "media" | "assets";
function libViewOf(v?: string): LibraryView {
  return v === "assets" ? "assets" : "media";
}
function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}
function mediaIcon(mime: string | null): string {
  if (!mime) return "📄";
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  return "📄";
}

type MediaAsset = {
  id: string;
  brand_id: string | null;
  folder: string;
  title: string | null;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
};

async function LibraryTab({
  supabase,
  brands,
  brandName,
  brand,
  kind,
  view,
  folder,
  mediaFlag,
  uploadAction,
  deleteMediaAction,
}: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  brands: Brand[];
  brandName: Map<string, string>;
  brand: string;
  kind: string;
  view: LibraryView;
  folder: string;
  mediaFlag: string;
  uploadAction: (formData: FormData) => Promise<void>;
  deleteMediaAction: (formData: FormData) => Promise<void>;
}) {
  const subTab = (
    <div className="mb-5 flex flex-wrap gap-1.5">
      {(
        [
          ["media", "Media Library"],
          ["assets", "Asset Links"],
        ] as const
      ).map(([v, label]) => (
        <Link
          key={v}
          href={studioUrl({ tab: "library", brand, view: v === "media" ? undefined : v })}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
            view === v
              ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
              : "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
          }`}
        >
          {label}
        </Link>
      ))}
    </div>
  );

  if (view === "media") {
    return (
      <>
        {subTab}
        <MediaLibraryView
          supabase={supabase}
          brands={brands}
          brandName={brandName}
          brand={brand}
          folder={folder}
          mediaFlag={mediaFlag}
          uploadAction={uploadAction}
          deleteMediaAction={deleteMediaAction}
        />
      </>
    );
  }

  let q = (supabase as unknown as AssetReadDb)
    .from("content_assets")
    .select(ASSET_COLS)
    .neq("status", ASSET_REMOVED_STATUS);
  if (brand) q = q.eq("brand_id", brand);
  if (kind && (ASSET_KINDS as readonly string[]).includes(kind)) q = q.eq("kind", kind);
  const { data: assetData } = await q.order("created_at", { ascending: false }).limit(200);
  const assets = (assetData ?? []) as unknown as ContentAsset[];

  // Resolve linked content-item titles for the assets on screen.
  const itemIds = Array.from(
    new Set(assets.map((a) => a.content_item_id).filter((v): v is string => !!v))
  );
  const itemTitle = new Map<string, string>();
  if (itemIds.length > 0) {
    const { data: itemsData } = await (supabase as unknown as AssetReadDb)
      .from("content_items")
      .select("id, title")
      .in("id", itemIds);
    for (const row of (itemsData ?? []) as unknown as { id: string; title: string }[]) {
      itemTitle.set(row.id, row.title);
    }
  }

  return (
    <>
      {subTab}
      <SectionCard
      title="Asset Links"
      action={<LibraryFilters brands={brands} brand={brand} kind={kind} />}
    >
      {assets.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-muted">
          No assets{brand ? ` for ${brandName.get(brand) ?? "this brand"}` : ""}
          {kind ? ` of kind “${ASSET_KIND_SINGULAR[kind] ?? kind}”` : ""} yet. Assets appear here as
          you create designs, generate videos, or attach links from the Produce tab.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {assets.map((a) => (
            <div
              key={a.id}
              className="flex flex-col overflow-hidden rounded-lg border border-charcoal-700/60 bg-charcoal-950"
            >
              <div className="flex aspect-video items-center justify-center bg-charcoal-900">
                {a.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.thumbnail_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span aria-hidden className="text-3xl opacity-70">
                    {ASSET_KIND_ICON[a.kind] ?? "📦"}
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-1.5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                    {ASSET_KIND_SINGULAR[a.kind] ?? a.kind}
                  </span>
                  <Badge tone={assetStatusTone(a.status)}>{a.status}</Badge>
                </div>
                <p className="truncate text-sm font-medium text-ink" title={a.title ?? ""}>
                  {a.title || "Untitled asset"}
                </p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
                  {a.provider && <span>{a.provider}</span>}
                  {a.brand_id && brandName.get(a.brand_id) && (
                    <span>· {brandName.get(a.brand_id)}</span>
                  )}
                  <span>· {formatAssetCost(a.cost_usd)}</span>
                </div>
                {a.content_item_id && itemTitle.get(a.content_item_id) && (
                  <p className="truncate text-[11px] text-ink-dim" title={itemTitle.get(a.content_item_id)}>
                    ↳ {itemTitle.get(a.content_item_id)}
                  </p>
                )}
                <div className="mt-auto pt-1.5">
                  {safeUrl(a.url) ? (
                    <a
                      href={safeUrl(a.url)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-teal-300 hover:text-teal-200"
                    >
                      Open ↗
                    </a>
                  ) : (
                    <span className="text-xs text-ink-dim">No link</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </SectionCard>
    </>
  );
}

// --- Media Library (files in the private creative-media bucket) --------------
async function MediaLibraryView({
  supabase,
  brands,
  brandName,
  brand,
  folder,
  mediaFlag,
  uploadAction,
  deleteMediaAction,
}: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  brands: Brand[];
  brandName: Map<string, string>;
  brand: string;
  folder: string;
  mediaFlag: string;
  uploadAction: (formData: FormData) => Promise<void>;
  deleteMediaAction: (formData: FormData) => Promise<void>;
}) {
  const folderFilter = (MEDIA_FOLDERS as readonly string[]).includes(folder) ? folder : "";

  let q = (supabase as unknown as AssetReadDb)
    .from("media_assets")
    .select("id, brand_id, folder, title, storage_path, mime_type, size_bytes, uploaded_by, created_at");
  if (brand) q = q.eq("brand_id", brand);
  if (folderFilter) q = q.eq("folder", folderFilter);
  const { data: rows } = await q.order("created_at", { ascending: false }).limit(300);
  const assets = (rows ?? []) as unknown as MediaAsset[];

  // Signed URLs for preview + download (the bucket is private).
  const signed = new Map<string, string>();
  if (assets.length > 0) {
    const { data: urls } = await supabase.storage
      .from("creative-media")
      .createSignedUrls(assets.map((a) => a.storage_path), 3600);
    for (const u of urls ?? []) {
      if (u.signedUrl && u.path) signed.set(u.path, u.signedUrl);
    }
  }

  // Resolve uploader names.
  const uploaderIds = Array.from(
    new Set(assets.map((a) => a.uploaded_by).filter((v): v is string => !!v))
  );
  const uploaderName = new Map<string, string>();
  if (uploaderIds.length > 0) {
    const { data: people } = await (supabase as unknown as AssetReadDb)
      .from("users")
      .select("id, full_name")
      .in("id", uploaderIds);
    for (const p of (people ?? []) as unknown as { id: string; full_name: string }[]) {
      uploaderName.set(p.id, p.full_name);
    }
  }

  const flagBanner =
    mediaFlag === "ok"
      ? { tone: "ok" as const, text: "Upload complete." }
      : mediaFlag === "partial"
        ? { tone: "warn" as const, text: "Some files uploaded; others were skipped (check size/type and try again)." }
        : mediaFlag === "failed"
          ? { tone: "error" as const, text: "Upload failed — please try again." }
          : mediaFlag === "nofiles"
            ? { tone: "warn" as const, text: "No files were selected." }
            : null;

  const folderChip = (value: string, label: string) => (
    <Link
      href={studioUrl({ tab: "library", view: "media", brand, folder: value || undefined })}
      className={`rounded-md border px-2.5 py-1.5 text-xs ${
        folderFilter === value
          ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
          : "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-6">
      {flagBanner && <FlowBanner tone={flagBanner.tone} text={flagBanner.text} />}

      <SectionCard title="Upload media">
        <MediaUploader
          folders={MEDIA_FOLDERS.map((f) => ({ value: f, label: MEDIA_FOLDER_LABEL[f] }))}
          folder={folderFilter || "raw"}
          brands={brands}
          brand={brand}
          action={uploadAction}
        />
      </SectionCard>

      {/* Folder + brand filters. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {folderChip("", "All folders")}
          {MEDIA_FOLDERS.map((f) => folderChip(f, MEDIA_FOLDER_LABEL[f]))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          <Link
            href={studioUrl({ tab: "library", view: "media", folder: folderFilter || undefined })}
            className={`rounded-md border px-2.5 py-1.5 text-xs ${
              brand
                ? "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
                : "border-teal-500/40 bg-teal-500/10 text-teal-300"
            }`}
          >
            All brands
          </Link>
          {brands.map((b) => (
            <Link
              key={b.id}
              href={studioUrl({ tab: "library", view: "media", brand: b.id, folder: folderFilter || undefined })}
              className={`rounded-md border px-2.5 py-1.5 text-xs ${
                brand === b.id
                  ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
                  : "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
              }`}
            >
              {b.name}
            </Link>
          ))}
        </div>
      </div>

      <SectionCard
        title={`${folderFilter ? MEDIA_FOLDER_LABEL[folderFilter as MediaFolder] : "All media"}${
          brand ? ` · ${brandName.get(brand) ?? "brand"}` : ""
        }`}
      >
        {assets.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-muted">
            No media here yet. Drag files into the upload zone above — they land in the private
            creative-media bucket, org-scoped and secure.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {assets.map((a) => {
              const url = signed.get(a.storage_path);
              const isImage = (a.mime_type ?? "").startsWith("image/");
              const isVideo = (a.mime_type ?? "").startsWith("video/");
              return (
                <div
                  key={a.id}
                  className="flex flex-col overflow-hidden rounded-lg border border-charcoal-700/60 bg-charcoal-950"
                >
                  <div className="flex aspect-video items-center justify-center overflow-hidden bg-charcoal-900">
                    {isImage && url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url} alt={a.title ?? ""} className="h-full w-full object-cover" />
                    ) : isVideo && url ? (
                      <video src={url} className="h-full w-full object-cover" muted preload="metadata" />
                    ) : (
                      <span aria-hidden className="text-3xl opacity-70">
                        {mediaIcon(a.mime_type)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                        {MEDIA_FOLDER_LABEL[a.folder as MediaFolder] ?? a.folder}
                      </span>
                      <span className="font-mono text-[10px] text-ink-dim">{fmtBytes(a.size_bytes)}</span>
                    </div>
                    <p className="truncate text-sm font-medium text-ink" title={a.title ?? ""}>
                      {a.title || "Untitled"}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-muted">
                      {a.brand_id && brandName.get(a.brand_id) && <span>{brandName.get(a.brand_id)}</span>}
                      {a.uploaded_by && uploaderName.get(a.uploaded_by) && (
                        <span>· {uploaderName.get(a.uploaded_by)}</span>
                      )}
                      <span>· {fmtDate(a.created_at)}</span>
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2 pt-1.5">
                      {safeUrl(url) ? (
                        <a
                          href={safeUrl(url)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          download={a.title ?? undefined}
                          className="text-xs text-teal-300 hover:text-teal-200"
                        >
                          Download ↓
                        </a>
                      ) : (
                        <span className="text-xs text-ink-dim">Unavailable</span>
                      )}
                      <form action={deleteMediaAction}>
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="brand" value={brand} />
                        <input type="hidden" name="folder" value={folderFilter} />
                        <button
                          type="submit"
                          className="text-xs text-red-300/80 hover:text-red-300"
                          title="Delete file + record"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// --- Vesper Studio tab (in-house auto-clipping) ------------------------------
// Turns a long video / livestream into reviewable short-form clip DRAFTS. The UI
// enqueues jobs and shows their progress + produced drafts; the heavy pipeline
// (ffmpeg + transcription) runs in the out-of-runtime worker. Nothing here
// publishes — every clip lands as an 'idea' content item for human review.
async function VesperTab({
  supabase,
  brands,
  brandName,
  brand,
  flag,
  enqueueAction,
  segmentAction,
}: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  brands: Brand[];
  brandName: Map<string, string>;
  brand: string;
  flag: string;
  enqueueAction: (formData: FormData) => Promise<void>;
  segmentAction: (formData: FormData) => Promise<void>;
}) {
  // Raw videos available as sources (folder 'raw'), and the org's jobs.
  let rawQ = (supabase as unknown as AssetReadDb)
    .from("media_assets")
    .select("id, title, folder, mime_type, created_at")
    .eq("folder", "raw");
  if (brand) rawQ = rawQ.eq("brand_id", brand);
  const { data: rawData } = await rawQ.order("created_at", { ascending: false }).limit(100);
  const rawAssets = ((rawData ?? []) as unknown as { id: string; title: string | null }[]).map((a) => ({
    id: a.id,
    title: a.title ?? a.id,
  }));

  const jobs = await readJobs(supabase, { brand: brand || undefined, limit: 50 });
  const clipsByJob = await readClipsForJobs(supabase, jobs.map((j) => j.id));

  // Re-sign clip storage paths for fresh, playable URLs (the bucket is private).
  const paths = Array.from(
    new Set(
      Array.from(clipsByJob.values())
        .flat()
        .map((c) => (c.meta?.storage_path as string | undefined) ?? null)
        .filter((p): p is string => Boolean(p))
    )
  );
  const signed = new Map<string, string>();
  if (paths.length > 0) {
    const { data: urls } = await supabase.storage.from("creative-media").createSignedUrls(paths, 3600);
    for (const u of urls ?? []) if (u.signedUrl && u.path) signed.set(u.path, u.signedUrl);
  }

  const banner =
    flag === "queued"
      ? { tone: "ok" as const, text: "Job queued — the worker will transcribe, find highlights, and cut clips. Refresh to track progress." }
      : flag === "segmented"
        ? { tone: "ok" as const, text: "Highlights selected. The worker will cut them into clips." }
        : flag === "badurl"
          ? { tone: "error" as const, text: "That source URL isn’t a valid http(s) link." }
          : flag === "nosource"
            ? { tone: "warn" as const, text: "Pick a raw video or paste a source URL first." }
            : flag === "notranscript"
              ? { tone: "warn" as const, text: "That job has no transcript yet — the worker transcribes before highlights can be picked." }
              : flag === "config"
                ? { tone: "error" as const, text: "ANTHROPIC_API_KEY isn’t configured — segment selection is unavailable." }
                : flag === "segfail"
                  ? { tone: "error" as const, text: "Segment selection failed. Try again in a moment." }
                  : flag === "failed" || flag === "notfound"
                    ? { tone: "error" as const, text: "Something went wrong enqueuing that job. Please try again." }
                    : null;

  return (
    <div className="space-y-6">
      {banner && (
        <div
          className={`rounded-md border px-4 py-2.5 text-sm ${
            banner.tone === "ok"
              ? "border-green-500/40 bg-green-500/10 text-green-300"
              : banner.tone === "warn"
                ? "border-gold-500/40 bg-gold-500/10 text-gold-300"
                : "border-red-500/40 bg-red-500/10 text-red-300"
          }`}
        >
          {banner.text}
        </div>
      )}

      <SectionCard
        title="Vesper Studio — auto-clipping"
        action={
          <Link
            href={studioUrl({ tab: "vesper", brand })}
            className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-charcoal-800"
          >
            ↻ Refresh
          </Link>
        }
      >
        <p className="mb-4 text-sm text-ink-muted">
          Turn a livestream or long video into short-form clip drafts. Vesper transcribes the
          source (OpenAI Whisper), asks Claude to pick the strongest moments (hooks, product
          mentions, high-energy beats), cuts them into vertical clips (ffmpeg), and drops each one
          into <span className="text-ink">Produce</span> as a draft with a suggested hook &amp;
          caption. <span className="text-ink">Nothing publishes automatically.</span>
        </p>
        <VesperJobForm rawAssets={rawAssets} brands={brands} brand={brand} action={enqueueAction} />
        <p className="mt-3 text-[11px] text-ink-dim">
          Video processing runs in an out-of-runtime worker (ffmpeg isn’t available in the app
          runtime). Jobs are queued here and picked up by <code className="text-ink-muted">worker/vesper-clipper.mjs</code>. See{" "}
          <span className="text-ink-muted">docs/VESPER_STUDIO.md</span>.
        </p>
      </SectionCard>

      <SectionCard title={`Clip jobs${jobs.length ? ` (${jobs.length})` : ""}`}>
        {jobs.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-muted">
            No auto-clip jobs yet. Queue one above from a raw video or a URL.
          </p>
        ) : (
          <div className="space-y-4">
            {jobs.map((job) => (
              <VesperJobRow
                key={job.id}
                job={job}
                clips={clipsByJob.get(job.id) ?? []}
                signed={signed}
                brand={brand}
                brandName={brandName}
                segmentAction={segmentAction}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// One job's card: status, stage, the source, and its produced clip drafts.
function VesperJobRow({
  job,
  clips,
  signed,
  brand,
  brandName,
  segmentAction,
}: {
  job: ClipJob;
  clips: ContentAsset[];
  signed: Map<string, string>;
  brand: string;
  brandName: Map<string, string>;
  segmentAction: (formData: FormData) => Promise<void>;
}) {
  const opts = resolveOptions(job.options);
  const isActive = (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status);
  const hasTranscript = Boolean(job.transcript && job.transcript.cues?.length);
  const canSegment = hasTranscript && (job.status === "segmenting" || job.status === "failed");

  return (
    <div className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={jobStatusTone(job.status)}>{JOB_STATUS_LABEL[job.status]}</Badge>
            {isActive && <span className="text-[11px] text-ink-dim">working…</span>}
          </div>
          <p className="mt-1 truncate text-sm font-medium text-ink" title={job.source_title ?? ""}>
            {job.source_title || job.source_url || "Source video"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
            {job.brand_id && brandName.get(job.brand_id) && <span>{brandName.get(job.brand_id)}</span>}
            <span>· up to {opts.max_clips} · {opts.aspect}</span>
            {job.transcript_service && <span>· {job.transcript_service}</span>}
            {job.segment_model && <span>· {job.segment_model}</span>}
            <span>· {fmtDate(job.created_at)}</span>
          </div>
          {job.stage_detail && <p className="mt-1 text-[11px] text-ink-dim">{job.stage_detail}</p>}
          {job.status === "failed" && job.error && (
            <p className="mt-1 text-[11px] text-red-400">{job.error}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canSegment && (
            <form action={segmentAction}>
              <input type="hidden" name="job_id" value={job.id} />
              <input type="hidden" name="brand" value={brand} />
              <button
                type="submit"
                className="rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-500/20"
              >
                Find highlights (Claude)
              </button>
            </form>
          )}
        </div>
      </div>

      {clips.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {clips.map((c) => {
            const path = (c.meta?.storage_path as string | undefined) ?? null;
            const playUrl = (path && signed.get(path)) || c.url || null;
            const hook = (c.meta?.hook as string | undefined) ?? "";
            return (
              <div
                key={c.id}
                className="flex flex-col overflow-hidden rounded-md border border-charcoal-700/60 bg-charcoal-900"
              >
                <div className="flex aspect-[9/16] max-h-64 items-center justify-center bg-charcoal-950">
                  {c.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbnail_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span aria-hidden className="text-3xl opacity-70">
                      ✂️
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone={assetStatusTone(c.status)}>{c.status}</Badge>
                    {c.duration_seconds != null && (
                      <span className="font-mono text-[10px] text-ink-dim">
                        {Math.round(Number(c.duration_seconds))}s
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs font-medium text-ink" title={c.title ?? ""}>
                    {c.title || "Clip"}
                  </p>
                  {hook && <p className="line-clamp-2 text-[11px] text-ink-muted">{hook}</p>}
                  <div className="mt-auto flex items-center gap-3 pt-1.5">
                    {playUrl && (
                      <a
                        href={playUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-teal-300 hover:text-teal-200"
                      >
                        ▶ Play
                      </a>
                    )}
                    {c.content_item_id && (
                      <Link
                        href={studioUrl({ tab: "produce", brand, edit: c.content_item_id })}
                        className="text-[11px] text-teal-300 hover:text-teal-200"
                      >
                        Review draft →
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Performance tab ---------------------------------------------------------
function PerfSubTabBar({ active, brand, month }: { active: PerfView; brand: string; month: string }) {
  return (
    <div className="mb-5 flex flex-wrap gap-1.5">
      {(
        [
          ["metrics", "Metrics"],
          ["pipeline", "Pipeline"],
        ] as const
      ).map(([v, label]) => (
        <Link
          key={v}
          href={studioUrl({ tab: "performance", brand, month, view: v === "metrics" ? undefined : v })}
          className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
            active === v
              ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
              : "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
          }`}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

// Brand chips + month nav shared by both performance sub-views (view-aware).
function PerfWindowControls({
  brands,
  brand,
  month,
  view,
}: {
  brands: Brand[];
  brand: string;
  month: string;
  view: PerfView;
}) {
  const v = view === "pipeline" ? "pipeline" : undefined;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <BrandFilterPerformance brands={brands} selected={brand} month={month} view={view} />
      <div className="flex items-center gap-2 sm:ml-auto">
        <Link
          href={studioUrl({ tab: "performance", brand, month: shiftMonth(month, -1), view: v })}
          aria-label="Previous month"
          className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-800"
        >
          ←
        </Link>
        <span className="min-w-[10rem] text-center text-sm font-semibold text-ink">
          {monthLabel(month)}
        </span>
        <Link
          href={studioUrl({ tab: "performance", brand, month: shiftMonth(month, 1), view: v })}
          aria-label="Next month"
          className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-800"
        >
          →
        </Link>
        {month !== currentMonth() && (
          <Link
            href={studioUrl({ tab: "performance", brand, month: currentMonth(), view: v })}
            className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-xs text-ink-muted hover:bg-charcoal-800"
          >
            This month
          </Link>
        )}
      </div>
    </div>
  );
}

async function PerformanceTab({
  supabase,
  profile,
  brands,
  brandName,
  brand,
  month,
  canSeeAll,
  view,
  editPerfId,
  saveAction,
  deleteAction,
}: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  profile: { id: string };
  brands: Brand[];
  brandName: Map<string, string>;
  brand: string;
  month: string;
  canSeeAll: boolean;
  view: PerfView;
  editPerfId: string;
  saveAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  // Primary view: real, manual-now metrics backed by content_performance.
  if (view === "metrics") {
    return (
      <>
        <PerfWindowControls brands={brands} brand={brand} month={month} view="metrics" />
        <PerfSubTabBar active="metrics" brand={brand} month={month} />
        <PerformanceMetricsView
          supabase={supabase}
          brands={brands}
          brandName={brandName}
          brand={brand}
          month={month}
          editPerfId={editPerfId}
          saveAction={saveAction}
          deleteAction={deleteAction}
        />
      </>
    );
  }

  // Secondary view: the Brief→Published pipeline tracker (workflow, not metrics).
  const perf = await getCreativePerformance(supabase, {
    month,
    brandId: brand || null,
    viewerId: profile.id,
    canSeeAll,
  });
  const o = perf.overall;
  const brandLabel = brand ? brandName.get(brand) ?? "this brand" : null;

  return (
    <>
      <PerfWindowControls brands={brands} brand={brand} month={month} view="pipeline" />
      <PerfSubTabBar active="pipeline" brand={brand} month={month} />

      {/* Scope note — leadership sees the whole org; members see their own work. */}
      <p className="mb-6 text-xs text-ink-muted">
        {perf.scope === "all"
          ? "Org-wide creative output"
          : "Your own creative output (you see the pieces assigned to you)"}
        {brandLabel ? ` · ${brandLabel}` : ""} · {perf.monthLabel}.
        {" "}Counts are read-only and grounded in real content records.
      </p>

      {!perf.hasAnyData ? (
        <SectionCard title="Creative Performance">
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span aria-hidden className="text-4xl opacity-60">
              📈
            </span>
            <p className="text-sm font-medium text-ink">No creative activity yet this window</p>
            <p className="max-w-md text-sm text-ink-muted">
              Nothing was {perf.scope === "self" ? "assigned to you, " : ""}produced, scheduled,
              published, or in production for {brandLabel ?? "any brand"} in {perf.monthLabel}. As
              pieces move through the pipeline on the Plan and Produce tabs, their numbers appear
              here.
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          {/* Overall KPI tiles for the scope + window. */}
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Produced" value={o.produced} hint="Started this month" />
            <StatTile
              label="Scheduled"
              value={o.scheduled}
              valueClassName="text-teal-300"
              hint="Queued to publish"
            />
            <StatTile
              label="Published"
              value={o.published}
              valueClassName="text-green-400"
              hint="Live this month"
            />
            <StatTile
              label="In production"
              value={o.inProduction}
              valueClassName="text-gold-400"
              hint="Being made now"
            />
            <StatTile
              label="On-time rate"
              value={formatPct(o.onTimeRate)}
              valueClassName={o.onTimeRate == null ? "text-ink" : "text-teal-300"}
              hint={
                o.onTimeRate == null
                  ? "Nothing due yet"
                  : `${o.onTimePublished}/${o.onTimeDue} due pieces published`
              }
            />
            <StatTile
              label="Overdue"
              value={o.overdue}
              valueClassName={o.overdue > 0 ? "text-red-300" : "text-ink"}
              hint="Past date, unpublished"
            />
            <StatTile
              label="Idea → published"
              value={formatDays(o.avgIdeaToPublishDays)}
              hint="Avg lead time"
            />
            <StatTile
              label="Production cost"
              value={formatCost(o.costUsd)}
              hint={
                o.costAssetCount > 0
                  ? `${o.costAssetCount} asset${o.costAssetCount === 1 ? "" : "s"} this month`
                  : "No paid assets yet"
              }
            />
          </div>

          {/* Per-brand breakdown (always shown for leadership; for a member it's
              their own work grouped by brand). */}
          <SectionCard title="By brand" className="mb-6">
            {perf.byBrand.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-muted">No brand activity this window.</p>
            ) : (
              <PerfBreakdownTable groupHeader="Brand" rows={perf.byBrand} />
            )}
          </SectionCard>

          {/* Per-member breakdown — leadership only (a member has no peers to
              break down; their own totals are the tiles above). */}
          {perf.byMember && (
            <SectionCard title="By team member">
              {perf.byMember.length === 0 ? (
                <p className="py-6 text-center text-sm text-ink-muted">
                  No pieces are assigned to anyone this window.
                </p>
              ) : (
                <PerfBreakdownTable groupHeader="Member" rows={perf.byMember} />
              )}
            </SectionCard>
          )}
        </>
      )}
    </>
  );
}

// A dense table of the per-brand / per-member creative metrics. Numbers render
// in the mono face (data, not prose); unknown values show "—", never a made-up
// zero. `groupHeader` names the first column ("Brand" / "Member").
function PerfBreakdownTable({
  groupHeader,
  rows,
}: {
  groupHeader: string;
  rows: CreativePerfRow[];
}) {
  const num = (n: number) => (
    <span className="font-mono text-ink">{n}</span>
  );
  return (
    <TableShell
      columns={[
        groupHeader,
        "Produced",
        "Scheduled",
        "Published",
        "In prod.",
        "Overdue",
        "On-time",
        "Idea→pub",
        "Cost",
      ]}
    >
      {rows.map((r) => (
        <tr key={r.key} className={rowClass}>
          <td className="p-3 text-ink">{r.name}</td>
          <td className="p-3">{num(r.metrics.produced)}</td>
          <td className="p-3">{num(r.metrics.scheduled)}</td>
          <td className="p-3">
            <span className="font-mono text-green-400">{r.metrics.published}</span>
          </td>
          <td className="p-3">
            <span className="font-mono text-gold-400">{r.metrics.inProduction}</span>
          </td>
          <td className="p-3">
            <span className={`font-mono ${r.metrics.overdue > 0 ? "text-red-300" : "text-ink"}`}>
              {r.metrics.overdue}
            </span>
          </td>
          <td className="p-3 font-mono text-ink-muted">{formatPct(r.metrics.onTimeRate)}</td>
          <td className="p-3 font-mono text-ink-muted">
            {formatDays(r.metrics.avgIdeaToPublishDays)}
          </td>
          <td className="p-3 font-mono text-ink-muted">{formatCost(r.metrics.costUsd)}</td>
        </tr>
      ))}
    </TableShell>
  );
}

// Brand chips for the Performance tab — like BrandFilterProduce but staying on
// ?tab=performance and preserving the month.
function BrandFilterPerformance({
  brands,
  selected,
  month,
  view,
}: {
  brands: Brand[];
  selected: string;
  month: string;
  view: PerfView;
}) {
  const v = view === "pipeline" ? "pipeline" : undefined;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link
        href={studioUrl({ tab: "performance", month, view: v })}
        className={`rounded-md border px-2.5 py-1.5 text-xs ${
          selected
            ? "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
            : "border-teal-500/40 bg-teal-500/10 text-teal-300"
        }`}
      >
        All brands
      </Link>
      {brands.map((b) => (
        <Link
          key={b.id}
          href={studioUrl({ tab: "performance", brand: b.id, month, view: v })}
          className={`rounded-md border px-2.5 py-1.5 text-xs ${
            selected === b.id
              ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
              : "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
          }`}
        >
          {b.name}
        </Link>
      ))}
    </div>
  );
}

// --- Performance metrics (real numbers, manual now, sync-ready) --------------
type PerfRow = {
  id: string;
  content_item_id: string | null;
  brand_id: string | null;
  platform: string | null;
  posted_at: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  engagement_rate: number | null;
  clicks: number | null;
  ctr: number | null;
  watch_time_seconds: number | null;
  avg_view_duration_seconds: number | null;
  conversions: number | null;
  orders: number | null;
  gmv: number | null;
  source: string | null;
  notes: string | null;
  created_at: string;
};

function sumField(list: PerfRow[], key: keyof PerfRow): number | null {
  let any = false;
  let total = 0;
  for (const r of list) {
    const v = r[key];
    if (typeof v === "number") {
      any = true;
      total += v;
    }
  }
  return any ? total : null;
}
// Engagement Rate: prefer a stored value; else compute ONLY when the inputs
// exist (engagement components + a reach/views denominator); else null → "—".
function erOf(r: PerfRow): number | null {
  if (r.engagement_rate != null) return r.engagement_rate;
  const denom = r.reach ?? r.views;
  const comps = [r.likes, r.comments, r.shares, r.saves].filter(
    (v): v is number => typeof v === "number"
  );
  if (!denom || denom <= 0 || comps.length === 0) return null;
  return (comps.reduce((a, b) => a + b, 0) / denom) * 100;
}
// CTR: stored value, else clicks / (views|reach) when both exist; else null.
function ctrOf(r: PerfRow): number | null {
  if (r.ctr != null) return r.ctr;
  const denom = r.views ?? r.reach;
  if (r.clicks == null || !denom || denom <= 0) return null;
  return (r.clicks / denom) * 100;
}
const fmtInt = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US"));
const fmtDec = (n: number | null) =>
  n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const fmtRate = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
const fmtMoney = (n: number | null) =>
  n == null ? "—" : `₱${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
function fmtMetric(field: (typeof PERF_METRIC_FIELDS)[number], v: number | null) {
  if (field.money) return fmtMoney(v);
  if (field.name === "engagement_rate" || field.name === "ctr") return fmtRate(v);
  if (field.step) return fmtDec(v);
  return fmtInt(v);
}
// The per-row displayed value: ER/CTR use the compute-with-fallback helpers so an
// empty piece reads "—", not 0.
function metricValue(field: (typeof PERF_METRIC_FIELDS)[number], r: PerfRow): number | null {
  if (field.name === "engagement_rate") return erOf(r);
  if (field.name === "ctr") return ctrOf(r);
  const v = r[field.name as keyof PerfRow];
  return typeof v === "number" ? v : null;
}

async function PerformanceMetricsView({
  supabase,
  brands,
  brandName,
  brand,
  month,
  editPerfId,
  saveAction,
  deleteAction,
}: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  brands: Brand[];
  brandName: Map<string, string>;
  brand: string;
  month: string;
  editPerfId: string;
  saveAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  const PERF_COLS =
    "id, content_item_id, brand_id, platform, posted_at, views, reach, likes, comments, shares, saves, engagement_rate, clicks, ctr, watch_time_seconds, avg_view_duration_seconds, conversions, orders, gmv, source, notes, created_at";
  let q = (supabase as unknown as AssetReadDb).from("content_performance").select(PERF_COLS);
  if (brand) q = q.eq("brand_id", brand);
  const { data: rowsData } = await q.order("created_at", { ascending: false }).limit(500);
  const allRows = (rowsData ?? []) as unknown as PerfRow[];

  // Effective date = posted_at when set, else created_at, so undated manual rows
  // still land in the month they were added (never lost, never mis-attributed).
  const effDate = (r: PerfRow) => r.posted_at ?? r.created_at;
  const rows = allRows.filter((r) => (effDate(r) ?? "").slice(0, 7) === month);

  const itemIds = Array.from(
    new Set(rows.map((r) => r.content_item_id).filter((v): v is string => !!v))
  );
  const itemTitle = new Map<string, string>();
  if (itemIds.length > 0) {
    const { data } = await (supabase as unknown as AssetReadDb)
      .from("content_items")
      .select("id, title")
      .in("id", itemIds);
    for (const it of (data ?? []) as unknown as { id: string; title: string }[]) {
      itemTitle.set(it.id, it.title);
    }
  }

  // Content-item options for the entry form.
  const { data: pickData } = await (supabase as unknown as AssetReadDb)
    .from("content_items")
    .select("id, title")
    .order("created_at", { ascending: false })
    .limit(200);
  const pickItems = (pickData ?? []) as unknown as { id: string; title: string }[];

  const editRow = editPerfId ? allRows.find((r) => r.id === editPerfId) ?? null : null;
  const dv = (name: string) => {
    const v = editRow ? (editRow as unknown as Record<string, unknown>)[name] : null;
    return v == null ? "" : String(v);
  };

  const pieceLabel = (r: PerfRow) =>
    (r.content_item_id && itemTitle.get(r.content_item_id)) ||
    (r.notes && r.notes.slice(0, 40)) ||
    "Manual entry";

  const columns = [
    "Piece",
    "Date",
    "Platform",
    ...PERF_METRIC_FIELDS.map((f) => f.short),
    "",
  ];

  return (
    <div className="space-y-6">
      <p className="text-xs text-ink-muted">
        Real performance metrics for {brand ? brandName.get(brand) ?? "this brand" : "all brands"} ·{" "}
        {monthLabel(month)}. Entered manually now — blanks stay empty (“—”), never 0. Rows are
        org-scoped and sync-ready: a future platform pull upserts on (org_id, external_id) without
        touching these manual rows.
      </p>

      {/* Entry / edit form. */}
      <SectionCard title={editRow ? "Edit metrics entry" : "Add metrics entry"}>
        <form action={saveAction} className="space-y-4">
          <input type="hidden" name="id" value={editRow?.id ?? ""} />
          {/* Snap to fill — pre-fill the numeric inputs below from a photo of an
              insights panel or a pasted row. Fills only; the save is unchanged. */}
          <PerfSnapFill />
          <input type="hidden" name="brand" value={brand} />
          <input type="hidden" name="month" value={month} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                Content piece
              </span>
              <select name="content_item_id" defaultValue={dv("content_item_id")} className={fieldCls}>
                <option value="">— Manual (no linked piece) —</option>
                {pickItems.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Brand</span>
              <select name="brand_id" defaultValue={dv("brand_id") || brand} className={fieldCls}>
                <option value="">— None —</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Platform</span>
              <select name="platform" defaultValue={dv("platform")} className={fieldCls}>
                <option value="">— None —</option>
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                Posted date
              </span>
              <input
                type="date"
                name="posted_at"
                defaultValue={editRow?.posted_at ? editRow.posted_at.slice(0, 10) : ""}
                className={fieldCls}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {PERF_METRIC_FIELDS.map((f) => (
              <label key={f.name} className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                  {f.label}
                </span>
                <input
                  type="number"
                  name={f.name}
                  step={f.step ?? "1"}
                  min="0"
                  inputMode="decimal"
                  defaultValue={dv(f.name)}
                  placeholder="—"
                  className={fieldCls}
                />
              </label>
            ))}
          </div>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Notes</span>
            <input
              name="notes"
              defaultValue={dv("notes")}
              placeholder="Optional — label a manual entry, source, caveats"
              className={fieldCls}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <SaveButton label={editRow ? "Save metrics" : "Add metrics"} />
            {editRow && (
              <Link
                href={studioUrl({ tab: "performance", brand, month })}
                className="text-sm text-ink-muted hover:text-ink"
              >
                New entry
              </Link>
            )}
            <span className="text-[11px] text-ink-dim">Blank fields stay empty — never saved as 0.</span>
          </div>
        </form>
      </SectionCard>

      {/* Totals + per-piece rows. */}
      <SectionCard title={`Metrics · ${monthLabel(month)}`}>
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-muted">
            No metrics recorded for {brand ? brandName.get(brand) ?? "this brand" : "any brand"} in{" "}
            {monthLabel(month)}. Add an entry above — totals and rates appear here as you enter real
            numbers.
          </p>
        ) : (
          <TableShell columns={columns}>
            {/* Totals row first. */}
            <tr className="border-b border-charcoal-700/60 bg-charcoal-900/60 font-medium">
              <td className="p-3 text-ink">Totals</td>
              <td className="p-3 text-ink-dim">{rows.length} pcs</td>
              <td className="p-3 text-ink-dim">—</td>
              {PERF_METRIC_FIELDS.map((f) => {
                let v: number | null;
                if (f.name === "engagement_rate") {
                  const denom = sumField(rows, "reach") ?? sumField(rows, "views");
                  const comps =
                    (sumField(rows, "likes") ?? 0) +
                    (sumField(rows, "comments") ?? 0) +
                    (sumField(rows, "shares") ?? 0) +
                    (sumField(rows, "saves") ?? 0);
                  v = denom && denom > 0 ? (comps / denom) * 100 : null;
                } else if (f.name === "ctr") {
                  const denom = sumField(rows, "views") ?? sumField(rows, "reach");
                  const clicks = sumField(rows, "clicks");
                  v = clicks != null && denom && denom > 0 ? (clicks / denom) * 100 : null;
                } else if (f.name === "avg_view_duration_seconds") {
                  v = null; // averaging durations across pieces isn't meaningful → "—"
                } else {
                  v = sumField(rows, f.name as keyof PerfRow);
                }
                return (
                  <td key={f.name} className="p-3 font-mono text-ink">
                    {fmtMetric(f, v)}
                  </td>
                );
              })}
              <td className="p-3" />
            </tr>

            {rows.map((r) => (
              <tr key={r.id} className={rowClass}>
                <td className="p-3 text-ink" title={pieceLabel(r)}>
                  <span className="block max-w-[16rem] truncate">{pieceLabel(r)}</span>
                  {r.source && r.source !== "manual" && (
                    <span className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">
                      {r.source}
                    </span>
                  )}
                </td>
                <td className="p-3 text-ink-muted">{fmtDate(effDate(r))}</td>
                <td className="p-3 text-ink-muted">
                  {r.platform ? PLATFORM_LABEL[r.platform] ?? r.platform : "—"}
                </td>
                {PERF_METRIC_FIELDS.map((f) => (
                  <td key={f.name} className="p-3 font-mono text-ink-muted">
                    {fmtMetric(f, metricValue(f, r))}
                  </td>
                ))}
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={studioUrl({ tab: "performance", brand, month, editperf: r.id })}
                      className="text-xs text-teal-300 hover:text-teal-200"
                    >
                      Edit
                    </Link>
                    <form action={deleteAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="brand" value={brand} />
                      <input type="hidden" name="month" value={month} />
                      <button type="submit" className="text-xs text-red-300/80 hover:text-red-300">
                        Delete
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </SectionCard>
    </div>
  );
}

// Small shared flow banner.
function FlowBanner({ tone, text }: { tone: "ok" | "warn" | "error"; text: string }) {
  return (
    <div
      className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
        tone === "ok"
          ? "border-green-500/40 bg-green-500/10 text-green-300"
          : tone === "error"
            ? "border-red-500/40 bg-red-500/10 text-red-300"
            : "border-gold-500/40 bg-gold-500/10 text-gold-300"
      }`}
    >
      {text}
    </div>
  );
}

// A brand selector for the Produce picker — like BrandFilter but staying on the
// Produce tab. Reuses the shared client BrandFilter isn't possible (it targets
// the Plan tab), so this is a thin server link-set… actually rendered client via
// BrandFilter would jump tabs; instead we render plain links here.
function BrandFilterProduce({
  brands,
  selected,
  month,
}: {
  brands: Brand[];
  selected: string;
  month: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link
        href={studioUrl({ tab: "produce", month })}
        className={`rounded-md border px-2.5 py-1.5 text-xs ${
          selected
            ? "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
            : "border-teal-500/40 bg-teal-500/10 text-teal-300"
        }`}
      >
        All brands
      </Link>
      {brands.map((b) => (
        <Link
          key={b.id}
          href={studioUrl({ tab: "produce", brand: b.id, month })}
          className={`rounded-md border px-2.5 py-1.5 text-xs ${
            selected === b.id
              ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
              : "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800"
          }`}
        >
          {b.name}
        </Link>
      ))}
    </div>
  );
}

// --- Creative Kit (assets for one content item) -----------------------------
function CreativeKit({
  item,
  assets,
  brand,
  month,
  canManageAssets,
  canAssemble,
  json2videoConfigured,
  attachAction,
  removeAction,
  saveCapcutAction,
  assembleAction,
}: {
  item: ContentItem;
  assets: ContentAsset[];
  brand: string;
  month: string;
  canManageAssets: boolean;
  canAssemble: boolean;
  json2videoConfigured: boolean;
  attachAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
  saveCapcutAction: (formData: FormData) => Promise<void>;
  assembleAction: (formData: FormData) => Promise<void>;
}) {
  // Assembly composes only FINISHED assets (a processing/failed clip can't feed a
  // render), and the assembled_video kind can't feed itself. Mirror the server's
  // filter so the live preview matches what will actually be composed.
  const assemblySources: AssemblySourceAsset[] = assets
    .filter((a) => a.kind !== "assembled_video")
    .filter((a) => ["ready", "completed", "done"].includes((a.status ?? "").toLowerCase()))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      url: a.url,
      duration_seconds: a.duration_seconds,
    }));
  // Group assets by kind, in the canonical pipeline order.
  const byKind = new Map<string, ContentAsset[]>();
  for (const a of assets) {
    const arr = byKind.get(a.kind) ?? [];
    arr.push(a);
    byKind.set(a.kind, arr);
  }
  const orderedKinds = ASSET_KINDS.filter((k) => (byKind.get(k)?.length ?? 0) > 0);
  // Any unknown kinds (future-proofing) after the known ones.
  const extraKinds = Array.from(byKind.keys()).filter(
    (k) => !(ASSET_KINDS as readonly string[]).includes(k)
  );

  return (
    <SectionCard title="Creative Kit" className="mt-6">
      {/* Assemble listing video — compose the whole kit into one finished MP4 via
          JSON2Video, behind a cost-preview + Approve & Render gate. */}
      <AssemblyPanel
        itemId={item.id}
        brand={brand}
        month={month}
        assets={assemblySources}
        canAssemble={canAssemble}
        configured={json2videoConfigured}
        action={assembleAction}
      />

      {/* CapCut — open the saved link or paste/save one. */}
      <div className="mb-5 rounded-lg border border-charcoal-700/60 bg-charcoal-950/60 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span aria-hidden>✂️</span>
          <span className="text-sm font-semibold text-ink">CapCut</span>
        </div>
        <form action={saveCapcutAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="item_id" value={item.id} />
          <input type="hidden" name="brand" value={brand} />
          <input type="hidden" name="month" value={month} />
          {safeUrl(item.capcut_url) && (
            <a
              href={safeUrl(item.capcut_url)!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-500/20"
            >
              ✂️ Open in CapCut ↗
            </a>
          )}
          <input
            name="capcut_url"
            type="url"
            defaultValue={item.capcut_url ?? ""}
            placeholder="Paste a CapCut project/export link…"
            className={`${fieldCls} min-w-[16rem] flex-1`}
          />
          <SaveCapcutButton />
        </form>
      </div>

      {/* Asset groups */}
      {assets.length === 0 ? (
        <p className="mb-5 rounded-lg border border-dashed border-charcoal-700 p-4 text-center text-sm text-ink-muted">
          No assets yet. Designs created in Canva and videos generated with HeyGen land here
          automatically, or attach an existing link below.
        </p>
      ) : (
        <div className="mb-5 flex flex-col gap-5">
          {[...orderedKinds, ...extraKinds].map((k) => {
            const rows = byKind.get(k) ?? [];
            return (
              <div key={k}>
                <div className="mb-2 flex items-center gap-2">
                  <span aria-hidden>{ASSET_KIND_ICON[k] ?? "📦"}</span>
                  <h3 className="text-sm font-semibold text-ink">
                    {ASSET_KIND_LABEL[k] ?? k}
                  </h3>
                  <span className="font-mono text-[11px] text-ink-dim">{rows.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {rows.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-3 rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-2.5"
                    >
                      {a.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={a.thumbnail_url}
                          alt=""
                          className="h-10 w-16 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-charcoal-800 text-ink-dim">
                          {ASSET_KIND_ICON[a.kind] ?? "📦"}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink" title={a.title ?? ""}>
                          {a.title || "Untitled asset"}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-muted">
                          {a.provider && <span>{a.provider}</span>}
                          <span>· {formatAssetCost(a.cost_usd)}</span>
                        </div>
                      </div>
                      <Badge tone={assetStatusTone(a.status)}>{a.status}</Badge>
                      {safeUrl(a.url) && (
                        <a
                          href={safeUrl(a.url)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-xs text-teal-300 hover:text-teal-200"
                        >
                          Open ↗
                        </a>
                      )}
                      {canManageAssets && (
                        <RemoveAssetButton
                          assetId={a.id}
                          title={a.title || "this asset"}
                          itemId={item.id}
                          brand={brand}
                          month={month}
                          action={removeAction}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Attach an asset manually */}
      <div className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/60 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span aria-hidden>＋</span>
          <span className="text-sm font-semibold text-ink">Attach an asset</span>
          <span className="text-[11px] text-ink-dim">
            Capture an existing link — a CapCut export, a voiceover, a music track…
          </span>
        </div>
        <form action={attachAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="item_id" value={item.id} />
          <input type="hidden" name="brand" value={brand} />
          <input type="hidden" name="month" value={month} />
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Kind</span>
            <select name="kind" defaultValue="script" className={fieldCls}>
              {ASSET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ASSET_KIND_SINGULAR[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              Provider (optional)
            </span>
            <input name="provider" placeholder="e.g. CapCut, ElevenLabs" className={fieldCls} />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Title</span>
            <input name="title" placeholder="e.g. Final cut v2" className={fieldCls} />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">URL</span>
            <input name="url" type="url" placeholder="https://…" className={fieldCls} />
          </label>
          <div className="sm:col-span-2">
            <AttachAssetButton />
          </div>
        </form>
      </div>
    </SectionCard>
  );
}

// --- Editor panel (server component; forms post to the actions above) -------
function ContentEditor({
  item,
  brands,
  initiatives,
  people,
  brand,
  month,
  canDelete,
  briefError,
  canvaConfigured,
  canvaConnected,
  canManageCanva,
  saveAction,
  deleteAction,
  generateAction,
  createInCanvaAction,
  heygenConfigured,
  canGenerateHeygen,
  heygenAvatars,
  heygenVoices,
  heygenWalletEmpty,
  generateHeygenAction,
  falConfigured,
  canGenerateFal,
  generateFalAction,
}: {
  item: ContentItem | null;
  brands: Brand[];
  initiatives: Initiative[];
  people: Person[];
  brand: string;
  month: string;
  canDelete: boolean;
  briefError: string | null;
  canvaConfigured: boolean;
  canvaConnected: boolean;
  canManageCanva: boolean;
  saveAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
  generateAction: (formData: FormData) => Promise<void>;
  createInCanvaAction: (formData: FormData) => Promise<void>;
  heygenConfigured: boolean;
  canGenerateHeygen: boolean;
  heygenAvatars: HeygenAvatar[];
  heygenVoices: HeygenVoice[];
  heygenWalletEmpty: boolean;
  generateHeygenAction: (formData: FormData) => Promise<void>;
  falConfigured: boolean;
  canGenerateFal: boolean;
  generateFalAction: (formData: FormData) => Promise<void>;
}) {
  const heading = item ? "Edit content item" : "New content item";
  const closeHref = studioUrl({ tab: "produce", brand, month });
  const publishValue = item?.publish_date ? item.publish_date.slice(0, 10) : "";

  return (
    <SectionCard
      title={heading}
      className="mb-6"
      action={
        <Link href={closeHref} className="text-xs text-ink-muted hover:text-ink">
          Close ✕
        </Link>
      }
    >
      <form action={saveAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input type="hidden" name="id" value={item?.id ?? ""} />
        <input type="hidden" name="brand" value={brand} />
        <input type="hidden" name="month" value={month} />

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Title</span>
          <input
            name="title"
            required
            defaultValue={item?.title ?? ""}
            placeholder="e.g. Payday live — bestseller bundle"
            className={fieldCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Brand</span>
          <select name="brand_id" defaultValue={item?.brand_id ?? ""} className={fieldCls}>
            <option value="">— None —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Initiative (optional)
          </span>
          <select name="initiative_id" defaultValue={item?.initiative_id ?? ""} className={fieldCls}>
            <option value="">— None —</option>
            {initiatives.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Type</span>
          <select name="content_type" defaultValue={item?.content_type ?? "video"} className={fieldCls}>
            {CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Status</span>
          <select name="status" defaultValue={item?.status ?? "idea"} className={fieldCls}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Platform</span>
          <select name="platform" defaultValue={item?.platform ?? ""} className={fieldCls}>
            <option value="">— None —</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Sales source
          </span>
          <select name="sales_source" defaultValue={item?.sales_source ?? ""} className={fieldCls}>
            <option value="">— None —</option>
            {SALES_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SALES_LABEL[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Pillar</span>
          {(() => {
            // Prefer the canonical pillar list; if the item carries a legacy free-text
            // pillar that doesn't map, keep it as a selectable option so it's not lost.
            const current = item?.pillar ?? "";
            const mapped = resolvePillar(current);
            const selected = mapped ? mapped.key : current;
            return (
              <select name="pillar" defaultValue={selected} className={fieldCls}>
                <option value="">— No pillar (stays neutral, not sales) —</option>
                {PILLAR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
                {!mapped && current && <option value={current}>{current} (custom)</option>}
              </select>
            );
          })()}
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Assignee</span>
          <select name="assignee_id" defaultValue={item?.assignee_id ?? ""} className={fieldCls}>
            <option value="">— Unassigned —</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Publish date
          </span>
          <input type="date" name="publish_date" defaultValue={publishValue} className={fieldCls} />
        </label>

        {/* Brief + AI generator */}
        <div className="flex flex-col gap-1 sm:col-span-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Brief</span>
            {item && (
              <span className="text-[10px] text-ink-dim">
                Save first, then generate — grounded in the fields above.
              </span>
            )}
          </div>
          <textarea
            name="brief"
            rows={6}
            defaultValue={item?.brief ?? ""}
            placeholder="Hook, script/outline and caption. Write it, or generate a draft with AI."
            className={fieldCls}
          />
          {briefError && <span className="text-[11px] text-red-300">{briefError}</span>}
        </div>

        {/* Tool link-outs (plain URL fields) */}
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Canva URL</span>
          <input name="canva_url" type="url" defaultValue={item?.canva_url ?? ""} placeholder="https://…" className={fieldCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">HeyGen URL</span>
          <input name="heygen_url" type="url" defaultValue={item?.heygen_url ?? ""} placeholder="https://…" className={fieldCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">CapCut URL</span>
          <input name="capcut_url" type="url" defaultValue={item?.capcut_url ?? ""} placeholder="https://…" className={fieldCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Asset URL</span>
          <input name="asset_url" type="url" defaultValue={item?.asset_url ?? ""} placeholder="https://…" className={fieldCls} />
        </label>

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Notes</span>
          <textarea
            name="notes"
            rows={3}
            defaultValue={item?.notes ?? ""}
            placeholder="Anything the team should know."
            className={fieldCls}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <SaveButton label={item ? "Save changes" : "Create content item"} />
          <Link href={closeHref} className="text-sm text-ink-muted hover:text-ink">
            Cancel
          </Link>
        </div>
      </form>

      {/* Generate brief + Canva + delete (separate forms). */}
      {item && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-charcoal-700/60 pt-3">
          <form action={generateAction}>
            <input type="hidden" name="id" value={item.id} />
            <input type="hidden" name="brand" value={brand} />
            <input type="hidden" name="month" value={month} />
            <GenerateBriefButton />
          </form>

          {!canvaConfigured ? (
            <span className="text-[11px] text-ink-dim">🎨 Canva not set up yet.</span>
          ) : canvaConnected ? (
            <form action={createInCanvaAction}>
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="brand" value={brand} />
              <input type="hidden" name="month" value={month} />
              <CreateInCanvaButton />
            </form>
          ) : (
            <span className="text-[11px] text-ink-dim">
              🎨 Connect Canva first
              {canManageCanva && (
                <>
                  {" — "}
                  <a href="/api/canva/connect" className="text-teal-300 hover:underline">
                    Connect Canva
                  </a>
                </>
              )}
              .
            </span>
          )}

          <span className="text-[11px] text-ink-dim">
            Uses Claude at your role’s model tier · grounded only in this item’s fields.
          </span>
          {canDelete && (
            <div className="ml-auto">
              <DeleteContentButton
                id={item.id}
                title={item.title}
                brand={brand}
                month={month}
                action={deleteAction}
              />
            </div>
          )}
        </div>
      )}

      {/* Generate video with HeyGen — cost-previewed + leadership-approved. */}
      {item && (
        <div className="mt-3 border-t border-charcoal-700/60 pt-3">
          {!heygenConfigured ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-dim">
              🎬 HeyGen not set up yet (missing HEYGEN_API_KEY).
            </span>
          ) : (
            <HeygenGeneratePanel
              itemId={item.id}
              brand={brand}
              month={month}
              defaultScript={item.brief ?? ""}
              avatars={heygenAvatars}
              voices={heygenVoices}
              canGenerate={canGenerateHeygen}
              walletEmpty={heygenWalletEmpty}
              action={generateHeygenAction}
            />
          )}
        </div>
      )}

      {/* Generate video with fal.ai — model-picked, cost-previewed + approved. */}
      {item && (
        <div className="mt-3 border-t border-charcoal-700/60 pt-3">
          {!falConfigured ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-dim">
              🎞️ fal.ai not set up yet (missing FAL_KEY).
            </span>
          ) : (
            <FalVideoPanel
              itemId={item.id}
              brand={brand}
              month={month}
              defaultPrompt={item.brief ?? ""}
              canGenerate={canGenerateFal}
              action={generateFalAction}
            />
          )}
        </div>
      )}
    </SectionCard>
  );
}


