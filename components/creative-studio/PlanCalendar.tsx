"use client";

// The editable Plan calendar — the centrepiece of Creative Studio's Plan tab.
//
// Renders the brand_initiatives band above a month grid of content_items keyed
// by publish_date, and makes both editable in place. All reads arrive as props
// from the server component (RLS-scoped there); every write goes through the
// RLS-scoped browser client, so scoping is automatic and nothing here can reach
// another org's rows.
//
//   • Click a content item      → editor (title, status, pillar, content_type,
//                                  platform, publish_date, assignee, notes) → update.
//   • Click a day's "＋"         → same editor with publish_date prefilled → insert
//                                  (org_id + created_by come from the session, never
//                                  hardcoded, or the RLS with_check rejects the row).
//   • Click an initiative's ✎    → editor (name, type, status, start/end date, note)
//                                  → update. The pencil only renders for ceo / coo /
//                                  department_head; team members see it read-only,
//                                  because RLS rejects their write and it would look
//                                  broken.
//
// Every save is optimistic: the UI reflects the change immediately, a subtle
// "Saving… / Saved ✓" indicator tracks the write, and on failure the change is
// reverted and an error toast is shown. router.refresh() reconciles the sibling
// server-rendered surfaces (summary tiles, status board) after a successful write.

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { SectionCard, Badge, type BadgeTone } from "@/components/ui";
import {
  PILLAR_OPTIONS,
  FORMAT_OPTIONS,
  resolvePillar,
  resolveFormat,
} from "@/lib/content/creative-guides";

// --- Enums (mirror the vocab used across Creative Studio / Brands) -----------
const CONTENT_TYPES = ["video", "live", "graphic", "carousel", "photo", "story", "other"] as const;
const STATUSES = ["idea", "brief", "production", "scheduled", "published", "archived"] as const;
const PLATFORMS = ["tiktok_shop", "shopee", "tiktok", "facebook", "instagram", "other"] as const;

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

// --- Live Session layer -----------------------------------------------------
// Live Ops schedules live selling on the SAME calendar. A scheduled live is a
// live_sessions row (status 'scheduled', started_at = planned start) — the exact
// record surfaced on the Live Selling page. No metrics are ever written here:
// scheduled means no GMV / viewers yet. Live-selling platforms are TikTok Shop /
// Shopee (the shoppable-live channels), a deliberately narrower set than content.
const LIVE_PLATFORMS = ["tiktok_shop", "shopee"] as const;
const LIVE_PLATFORM_LABEL: Record<string, string> = {
  tiktok_shop: "TikTok Shop",
  shopee: "Shopee",
};
// The three calendar layers Live Ops toggles between.
const LAYERS = [
  { value: "both", label: "Both" },
  { value: "content", label: "Content" },
  { value: "live", label: "Live" },
] as const;
type Layer = (typeof LAYERS)[number]["value"];

// Marketing-initiative vocab — kept in step with app/(dashboard)/brands/page.tsx.
const INITIATIVE_TYPES = [
  { value: "campaign", label: "Campaign" },
  { value: "promo", label: "Promotion" },
  { value: "ads", label: "Paid Ads" },
  { value: "live", label: "Live Selling" },
  { value: "affiliate", label: "Affiliate" },
  { value: "content", label: "Content" },
  { value: "other", label: "Other" },
] as const;
const INITIATIVE_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  INITIATIVE_TYPES.map((t) => [t.value, t.label])
);
const INITIATIVE_STATUSES = [
  { value: "planned", label: "Planned", tone: "violet" as BadgeTone },
  { value: "active", label: "Active", tone: "teal" as BadgeTone },
  { value: "paused", label: "Paused", tone: "amber" as BadgeTone },
  { value: "completed", label: "Completed", tone: "muted" as BadgeTone },
] as const;
const INITIATIVE_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  INITIATIVE_STATUSES.map((s) => [s.value, s.label])
);
const INITIATIVE_STATUS_TONE: Record<string, BadgeTone> = Object.fromEntries(
  INITIATIVE_STATUSES.map((s) => [s.value, s.tone])
);

// --- Types ------------------------------------------------------------------
export type PlanItem = {
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
  notes: string | null;
};
// Brand grounding for the AI "Generate" panel, composed server-side (RLS-scoped)
// and passed in per brand: name + the brand's latest account_briefing summary
// when one is on file. Keyed by brand_id.
export type BrandContext = {
  name: string;
  summary: string | null;
  confidence: string | null;
};
export type PlanInitiative = {
  id: string;
  brand_id: string | null;
  platform: string | null;
  type: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  note: string | null;
};
// A scheduled live session as it appears on the Plan calendar. This is the same
// live_sessions row the Live Selling page reads — only the planning fields are
// carried here (no metrics; scheduled = nothing recorded yet).
export type PlanLiveSession = {
  id: string;
  org_id: string;
  brand_id: string | null;
  anchor_id: string | null;
  platform: string;
  title: string | null;
  status: string;
  started_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
};
type Option = { id: string; name: string };

// content_items / brand_initiatives aren't in the generated Supabase types, so
// writes go through this shim — the same idiom the server page uses. RLS still
// scopes every row.
type WriteDb = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => {
      select: (c: string) => {
        single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => Promise<{ error: { message: string } | null }>;
    };
    delete: () => {
      eq: (c: string, val: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

// --- Date helpers (self-contained; deterministic UTC math) ------------------
function buildWeeks(month: string): (number | null)[][] {
  const [y, m] = month.split("-").map(Number);
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const lead = (firstDow + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
function dayISO(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, "0")}`;
}
function fmtRange(start: string | null, end: string | null): string {
  if (!start && !end) return "No dates";
  if (start && end) return `${start} → ${end}`;
  return start ? `From ${start}` : `Until ${end}`;
}

// --- Live-session timestamp helpers -----------------------------------------
// live_sessions.started_at is a timestamptz; the calendar buckets by the Manila
// calendar day (Asia/Manila, fixed +08:00 — the company timezone), matching how
// the Live Selling page attributes a session to a date. A planned start typed as
// a wall-clock (date + HH:mm) is pinned to +08:00 so it round-trips exactly.
function manilaYMD(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}
function manilaHM(iso: string | null): string {
  if (!iso) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hh = get("hour") === "24" ? "00" : get("hour");
    return `${hh}:${get("minute")}`;
  } catch {
    return "";
  }
}
// (date "YYYY-MM-DD", time "HH:mm") → ISO, pinned to Manila +08:00. Blank date → null.
function manilaIso(dateStr: string, timeStr: string): string | null {
  if (!dateStr) return null;
  const time = /^\d{2}:\d{2}/.test(timeStr) ? timeStr.slice(0, 5) : "00:00";
  const ms = new Date(`${dateStr}T${time}:00+08:00`).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const fieldCls =
  "w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-teal-500 focus:outline-none";
const labelCls = "mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-dim";

// ---------------------------------------------------------------------------
export function PlanCalendar({
  orgId,
  userId,
  role,
  month,
  monthLabel,
  brand,
  brands,
  people,
  anchors: initialAnchors = [],
  items: initialItems,
  initiatives: initialInitiatives,
  liveSessions: initialLiveSessions = [],
  brandContext = {},
}: {
  orgId: string;
  userId: string;
  role: string;
  month: string;
  monthLabel: string;
  brand: string;
  brands: Option[];
  people: Option[];
  anchors?: Option[];
  items: PlanItem[];
  initiatives: PlanInitiative[];
  liveSessions?: PlanLiveSession[];
  brandContext?: Record<string, BrandContext>;
}) {
  const router = useRouter();
  const db = useMemo(() => createClient() as unknown as WriteDb, []);

  const [items, setItems] = useState<PlanItem[]>(initialItems);
  const [initiatives, setInitiatives] = useState<PlanInitiative[]>(initialInitiatives);
  const [liveSessions, setLiveSessions] = useState<PlanLiveSession[]>(initialLiveSessions);
  const [anchors, setAnchors] = useState<Option[]>(initialAnchors);
  const [layer, setLayer] = useState<Layer>("both");
  const [editItem, setEditItem] = useState<PlanItem | null>(null);
  const [editInit, setEditInit] = useState<PlanInitiative | null>(null);
  const [editLive, setEditLive] = useState<PlanLiveSession | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [toast, setToast] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canEditInitiative =
    role === "ceo" || role === "coo" || role === "department_head";
  // Deleting a content item mirrors the server-side deleteContentItem guard
  // (leadership only). Editing/creating stays open to any org member (RLS is the
  // real guard), matching how the rest of this calendar already behaves.
  const canDelete =
    role === "ceo" || role === "coo" || role === "department_head";

  const personName = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const brandName = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);

  const markSaving = useCallback(() => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaveState("saving");
  }, []);
  const markSaved = useCallback(() => {
    setSaveState("saved");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaveState("idle"), 1600);
  }, []);
  const showError = useCallback((msg: string) => {
    setSaveState("idle");
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);

  // --- content_items writes -------------------------------------------------
  const saveItem = useCallback(
    async (draft: PlanItem) => {
      const title = draft.title.trim();
      if (!title) {
        showError("Title is required.");
        return;
      }
      const patch = {
        title,
        status: draft.status,
        pillar: draft.pillar?.trim() || null,
        content_type: draft.content_type,
        platform: draft.platform || null,
        publish_date: draft.publish_date || null,
        assignee_id: draft.assignee_id || null,
        brief: draft.brief?.trim() || null,
        notes: draft.notes?.trim() || null,
      };

      if (draft.id) {
        // Update — optimistic, revert on failure.
        const prev = items;
        setItems((list) => list.map((i) => (i.id === draft.id ? { ...i, ...patch } : i)));
        setEditItem(null);
        markSaving();
        const { error } = await db.from("content_items").update(patch).eq("id", draft.id);
        if (error) {
          setItems(prev);
          showError(`Couldn't save — ${error.message}`);
        } else {
          markSaved();
          router.refresh();
        }
        return;
      }

      // Insert — org_id + created_by come from the session (RLS with_check needs
      // org_id = current_org_id()). brand_id follows the active brand filter.
      const tempId = `temp-${crypto.randomUUID()}`;
      const optimistic: PlanItem = {
        id: tempId,
        org_id: orgId,
        brand_id: brand || null,
        initiative_id: null,
        sales_source: null,
        ...patch,
      };
      const prev = items;
      setItems((list) => [...list, optimistic]);
      setEditItem(null);
      markSaving();
      const { data, error } = await db
        .from("content_items")
        .insert({
          org_id: orgId,
          brand_id: brand || null,
          initiative_id: null,
          title,
          content_type: draft.content_type,
          status: draft.status || "idea",
          platform: patch.platform,
          pillar: patch.pillar,
          assignee_id: patch.assignee_id,
          publish_date: patch.publish_date,
          brief: patch.brief,
          notes: patch.notes,
          created_by: userId,
        })
        .select("id")
        .single();
      if (error || !data) {
        setItems(prev);
        showError(`Couldn't create — ${error?.message ?? "unknown error"}`);
      } else {
        const newId = data.id;
        setItems((list) => list.map((i) => (i.id === tempId ? { ...i, id: newId } : i)));
        markSaved();
        router.refresh();
      }
    },
    [items, db, orgId, userId, brand, markSaving, markSaved, showError, router]
  );

  // Delete a content item — optimistic, revert on failure. RLS scopes the row
  // to the org; the leadership guard is enforced by `canDelete` at every call
  // site (and by the server deleteContentItem action for the Produce tab).
  const deleteItem = useCallback(
    async (target: PlanItem) => {
      if (!target.id || target.id.startsWith("temp-")) {
        setEditItem(null);
        return;
      }
      const prev = items;
      setItems((list) => list.filter((i) => i.id !== target.id));
      setEditItem(null);
      markSaving();
      const { error } = await db.from("content_items").delete().eq("id", target.id);
      if (error) {
        setItems(prev);
        showError(`Couldn't delete — ${error.message}`);
      } else {
        markSaved();
        router.refresh();
      }
    },
    [items, db, markSaving, markSaved, showError, router]
  );

  // Confirm-then-delete. Guarded so a stray call can't remove a row silently.
  const confirmDelete = useCallback(
    (target: PlanItem) => {
      if (!canDelete) return;
      const label = target.title.trim() || "this item";
      if (typeof window !== "undefined" && !window.confirm(`Delete "${label}"? This can't be undone.`)) {
        return;
      }
      void deleteItem(target);
    },
    [canDelete, deleteItem]
  );

  // --- brand_initiatives writes ---------------------------------------------
  const saveInitiative = useCallback(
    async (draft: PlanInitiative) => {
      const name = draft.name.trim();
      if (!name) {
        showError("Initiative name is required.");
        return;
      }
      const patch = {
        name,
        type: draft.type,
        status: draft.status || null,
        start_date: draft.start_date || null,
        end_date: draft.end_date || null,
        note: draft.note?.trim() || null,
      };
      const prev = initiatives;
      setInitiatives((list) => list.map((i) => (i.id === draft.id ? { ...i, ...patch } : i)));
      setEditInit(null);
      markSaving();
      const { error } = await db.from("brand_initiatives").update(patch).eq("id", draft.id);
      if (error) {
        setInitiatives(prev);
        showError(`Couldn't save — ${error.message}`);
      } else {
        markSaved();
        router.refresh();
      }
    },
    [initiatives, db, markSaving, markSaved, showError, router]
  );

  // --- live_sessions writes (scheduled lives) -------------------------------
  // Every write goes through the RLS browser client — the same path content
  // items use — so org-scoping is automatic. A scheduled live carries NO metrics
  // (GMV / viewers stay null): scheduled means nothing has happened yet. The row
  // is the exact record the Live Selling page reads; marking it 'live' there moves
  // it into LIVE NOW and off this scheduled view. One lifecycle, no duplicate.
  const saveLive = useCallback(
    async (draft: PlanLiveSession) => {
      const startedAt = draft.started_at; // already ISO (built in the editor)
      if (!startedAt) {
        showError("A planned start time is required to schedule a live.");
        return;
      }
      // Trust the editor's platform (it preserves any pre-existing value rather
      // than coercing) and only fall back when it's somehow empty.
      const platform = draft.platform || "tiktok_shop";
      const patch = {
        brand_id: draft.brand_id || null,
        anchor_id: draft.anchor_id || null,
        platform,
        title: draft.title?.trim() || null,
        started_at: startedAt,
        duration_minutes: draft.duration_minutes ?? null,
        notes: draft.notes?.trim() || null,
      };

      if (draft.id) {
        const prev = liveSessions;
        setLiveSessions((list) =>
          list.map((s) => (s.id === draft.id ? { ...s, ...patch } : s))
        );
        setEditLive(null);
        markSaving();
        const { error } = await db.from("live_sessions").update(patch).eq("id", draft.id);
        if (error) {
          setLiveSessions(prev);
          showError(`Couldn't save — ${error.message}`);
        } else {
          markSaved();
          router.refresh();
        }
        return;
      }

      // Insert — org_id + created_by come from the session (RLS with_check needs
      // org_id = current_org_id()). status is 'scheduled'; source 'manual' and a
      // null external_id keep it clear of the reserved platform-sync path.
      const tempId = `temp-${crypto.randomUUID()}`;
      const optimistic: PlanLiveSession = {
        id: tempId,
        org_id: orgId,
        status: "scheduled",
        ...patch,
      };
      const prev = liveSessions;
      setLiveSessions((list) => [...list, optimistic]);
      setEditLive(null);
      markSaving();
      const { data, error } = await db
        .from("live_sessions")
        .insert({
          org_id: orgId,
          created_by: userId,
          brand_id: patch.brand_id,
          anchor_id: patch.anchor_id,
          platform: patch.platform,
          title: patch.title,
          status: "scheduled",
          started_at: patch.started_at,
          duration_minutes: patch.duration_minutes,
          notes: patch.notes,
          external_id: null,
          source: "manual",
        })
        .select("id")
        .single();
      if (error || !data) {
        setLiveSessions(prev);
        showError(`Couldn't schedule — ${error?.message ?? "unknown error"}`);
      } else {
        const newId = data.id;
        setLiveSessions((list) => list.map((s) => (s.id === tempId ? { ...s, id: newId } : s)));
        markSaved();
        router.refresh();
      }
    },
    [liveSessions, db, orgId, userId, markSaving, markSaved, showError, router]
  );

  const deleteLive = useCallback(
    async (id: string) => {
      const prev = liveSessions;
      setLiveSessions((list) => list.filter((s) => s.id !== id));
      setEditLive(null);
      markSaving();
      const { error } = await db.from("live_sessions").delete().eq("id", id);
      if (error) {
        setLiveSessions(prev);
        showError(`Couldn't delete — ${error.message}`);
      } else {
        markSaved();
        router.refresh();
      }
    },
    [liveSessions, db, markSaving, markSaved, showError, router]
  );

  // Inline "add host" from the schedule form — inserts an anchors row (RLS-scoped)
  // and returns its id so the just-added host can be selected without a round-trip
  // to the Live Selling registry. Returns null on failure (surfaced by the caller).
  const createAnchor = useCallback(
    async (name: string, platform: string): Promise<string | null> => {
      const clean = name.trim();
      if (!clean) return null;
      const { data, error } = await db
        .from("anchors")
        .insert({
          org_id: orgId,
          created_by: userId,
          name: clean,
          platform: platform || "tiktok",
          anchor_type: "inhouse",
          status: "active",
        })
        .select("id")
        .single();
      if (error || !data) {
        showError(`Couldn't add host — ${error?.message ?? "unknown error"}`);
        return null;
      }
      setAnchors((list) =>
        [...list, { id: data.id, name: clean }].sort((a, b) => a.name.localeCompare(b.name))
      );
      return data.id;
    },
    [db, orgId, userId, showError]
  );

  // --- Derived: items keyed by day-of-month ---------------------------------
  const itemsByDay = useMemo(() => {
    const map = new Map<number, PlanItem[]>();
    for (const i of items) {
      if (!i.publish_date) continue;
      const day = Number(i.publish_date.slice(8, 10));
      if (!day) continue;
      const arr = map.get(day) ?? [];
      arr.push(i);
      map.set(day, arr);
    }
    return map;
  }, [items]);

  // Scheduled lives keyed by day-of-month, attributed by their Manila start day
  // and clamped to the visible month (a session whose start falls in another month
  // never bleeds in). Only 'scheduled' rows show here — once a live goes 'live' or
  // 'ended' on the Live Selling page it drops off this planning view.
  const livesByDay = useMemo(() => {
    const map = new Map<number, PlanLiveSession[]>();
    for (const s of liveSessions) {
      if (s.status !== "scheduled") continue;
      const ymd = manilaYMD(s.started_at);
      if (!ymd || ymd.slice(0, 7) !== month) continue;
      const day = Number(ymd.slice(8, 10));
      if (!day) continue;
      const arr = map.get(day) ?? [];
      arr.push(s);
      map.set(day, arr);
    }
    // Stable order within a day: earliest planned start first.
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
    }
    return map;
  }, [liveSessions, month]);

  const showContent = layer !== "live";
  const showLive = layer !== "content";

  const weeks = useMemo(() => buildWeeks(month), [month]);
  const weekdayHeaders = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function openNew(day: number) {
    setEditItem({
      id: "",
      org_id: orgId,
      brand_id: brand || null,
      initiative_id: null,
      title: "",
      content_type: "video",
      status: "idea",
      platform: null,
      sales_source: null,
      pillar: null,
      assignee_id: null,
      publish_date: dayISO(month, day),
      brief: null,
      notes: null,
    });
  }

  // Open the "Schedule live" form for a day — planned start defaults to 20:00
  // (prime live-selling hour) on that date, pinned to Manila, editable in the form.
  function openNewLive(day: number) {
    setEditLive({
      id: "",
      org_id: orgId,
      brand_id: brand || null,
      anchor_id: null,
      platform: "tiktok_shop",
      title: null,
      status: "scheduled",
      started_at: manilaIso(dayISO(month, day), "20:00"),
      duration_minutes: null,
      notes: null,
    });
  }

  return (
    <>
      {/* Initiatives band — spans the month above the grid */}
      <SectionCard
        title="Initiatives"
        className="mb-6"
        action={
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            {canEditInitiative ? "Click ✎ to edit" : "View only"}
          </span>
        }
      >
        {initiatives.length === 0 ? (
          <p className="py-2 text-sm text-ink-muted">
            No initiatives overlap {monthLabel}
            {brand ? ` for ${brandName.get(brand) ?? "this brand"}` : ""}.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {initiatives.map((it) => (
              <div
                key={it.id}
                className="group relative flex min-w-[13rem] max-w-full flex-col gap-1 rounded-lg border border-charcoal-700/60 bg-charcoal-950 px-3 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{it.name}</span>
                  {canEditInitiative && (
                    <button
                      type="button"
                      onClick={() => setEditInit(it)}
                      aria-label={`Edit ${it.name}`}
                      className="shrink-0 rounded p-0.5 text-ink-dim opacity-0 transition hover:text-teal-400 focus:opacity-100 group-hover:opacity-100"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={INITIATIVE_STATUS_TONE[it.status ?? ""] ?? "muted"}>
                    {INITIATIVE_STATUS_LABEL[it.status ?? ""] ?? it.status ?? "—"}
                  </Badge>
                  <span className="text-[11px] text-ink-muted">
                    {INITIATIVE_TYPE_LABEL[it.type] ?? it.type}
                  </span>
                  {it.brand_id && brandName.get(it.brand_id) && (
                    <span className="text-[11px] text-ink-dim">· {brandName.get(it.brand_id)}</span>
                  )}
                </div>
                <span className="font-mono text-[10px] text-ink-dim">
                  {fmtRange(it.start_date, it.end_date)}
                </span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Month calendar — editable cells */}
      <SectionCard
        title="Month calendar"
        className="mb-6"
        action={
          <div className="flex items-center gap-2">
            {/* Layer toggle: CONTENT · LIVE · BOTH. Content items and scheduled
                lives share the grid; the toggle scopes what's shown. */}
            <div
              role="group"
              aria-label="Calendar layer"
              className="flex overflow-hidden rounded-md border border-charcoal-700"
            >
              {LAYERS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  aria-pressed={layer === l.value}
                  onClick={() => setLayer(l.value)}
                  className={`px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                    layer === l.value
                      ? "bg-teal-500/20 text-teal-200"
                      : "bg-charcoal-950 text-ink-dim hover:text-ink-muted"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {/* Legend — content vs live, so the two layers read as distinct. */}
        <div className="mb-3 flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-sm border border-teal-500/40 bg-teal-500/15" />
            Content
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 rounded-sm border border-red-500/50 bg-red-500/15" />
            Live selling (scheduled)
          </span>
        </div>
        <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:overflow-visible sm:px-0">
        <div className="grid min-w-[34rem] grid-cols-7 gap-px sm:min-w-0 overflow-hidden rounded-lg border border-charcoal-700/60 bg-charcoal-700/60">
          {weekdayHeaders.map((w) => (
            <div
              key={w}
              className="bg-charcoal-900 p-2 text-center font-mono text-[10px] uppercase tracking-wider text-ink-dim"
            >
              {w}
            </div>
          ))}
          {weeks.flat().map((day, idx) => {
            if (day === null) {
              return <div key={`e${idx}`} className="min-h-[7rem] bg-charcoal-950/40" />;
            }
            const dayItems = showContent ? itemsByDay.get(day) ?? [] : [];
            const dayLives = showLive ? livesByDay.get(day) ?? [] : [];
            return (
              <div key={`d${day}`} className="group/day flex min-h-[7rem] flex-col bg-charcoal-900 p-1.5">
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-0.5">
                    {showContent && (
                      <button
                        type="button"
                        onClick={() => openNew(day)}
                        aria-label={`Add content on ${dayISO(month, day)}`}
                        title="Add content on this day"
                        className="rounded px-1 font-mono text-[11px] leading-none text-ink-dim opacity-60 transition hover:bg-charcoal-800 hover:text-teal-300 focus:opacity-100 group-hover/day:opacity-100"
                      >
                        ＋
                      </button>
                    )}
                    {showLive && (
                      <button
                        type="button"
                        onClick={() => openNewLive(day)}
                        aria-label={`Schedule a live session on ${dayISO(month, day)}`}
                        title="Schedule a live session on this day"
                        className="rounded px-1 font-mono text-[10px] leading-none text-red-400/70 opacity-60 transition hover:bg-charcoal-800 hover:text-red-300 focus:opacity-100 group-hover/day:opacity-100"
                      >
                        ＋Live
                      </button>
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-ink-dim">{day}</span>
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  {dayItems.map((i) => (
                    // Each item exposes two controls as sibling buttons (never
                    // nested — that's invalid HTML): the chip itself opens the
                    // editor (Edit), and, for those who may delete, a ✕ removes
                    // it after a confirm. On touch the ✕ is always visible; on
                    // pointer devices it reveals on hover/focus.
                    <div
                      key={i.id}
                      className={`group/chip flex items-stretch overflow-hidden rounded border text-[11px] leading-tight ${STATUS_CHIP[(i.status as Status) ?? "idea"] ?? STATUS_CHIP.idea}`}
                    >
                      <button
                        type="button"
                        onClick={() => setEditItem(i)}
                        title={`${TYPE_LABEL[(i.content_type as ContentType) ?? "other"] ?? i.content_type} · ${STATUS_LABEL[(i.status as Status) ?? "idea"] ?? i.status} — click to edit`}
                        className="flex min-w-0 flex-1 items-center gap-1 truncate px-1.5 py-0.5 text-left hover:brightness-125"
                      >
                        <span aria-hidden>
                          {TYPE_ICON[(i.content_type as ContentType) ?? "other"] ?? "📄"}
                        </span>
                        <span className="truncate">{i.title}</span>
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => confirmDelete(i)}
                          aria-label={`Delete ${i.title || "content item"}`}
                          title="Delete"
                          className="shrink-0 px-1 opacity-70 transition hover:brightness-125 focus:opacity-100 focus:outline-none sm:opacity-0 sm:group-hover/chip:opacity-100"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  {/* Scheduled lives — visually distinct (red LIVE badge) from
                      content chips. Click opens the live editor (edit / delete). */}
                  {dayLives.map((s) => (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => setEditLive(s)}
                      title={`Live · ${LIVE_PLATFORM_LABEL[s.platform] ?? s.platform}${
                        s.started_at ? ` · ${manilaHM(s.started_at)}` : ""
                      } — click to edit`}
                      className="flex items-center gap-1 truncate rounded border border-red-500/50 bg-red-500/15 px-1.5 py-0.5 text-left text-[11px] leading-tight text-red-200 hover:brightness-125"
                    >
                      <span
                        aria-hidden
                        className="shrink-0 rounded-sm bg-red-500/80 px-1 font-mono text-[8px] font-bold uppercase leading-tight tracking-wider text-charcoal-950"
                      >
                        Live
                      </span>
                      {s.started_at && (
                        <span className="shrink-0 font-mono text-[10px] text-red-300/90">
                          {manilaHM(s.started_at)}
                        </span>
                      )}
                      <span className="truncate">{s.title ?? "Untitled live"}</span>
                    </button>
                  ))}
                  {/* Full-height add target: clicking anywhere in the day's empty
                      space opens the new-item editor (or the schedule-live form when
                      the Live layer is active on its own). A real, keyboard-focusable
                      <button> (sibling of the chips — never nested, so no invalid
                      HTML), so the cell is reliably interactive on mouse, touch,
                      and keyboard rather than depending on a hover-only glyph. */}
                  {layer === "live" ? (
                    <button
                      type="button"
                      onClick={() => openNewLive(day)}
                      aria-label={`Schedule a live session on ${dayISO(month, day)}`}
                      className="min-h-[1.5rem] flex-1 rounded text-left font-mono text-[10px] uppercase tracking-wider text-transparent transition hover:bg-charcoal-800/60 hover:text-red-300/80 focus:text-red-300/80 focus:outline-none group-hover/day:text-red-300/80"
                    >
                      ＋ Live
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openNew(day)}
                      aria-label={`Add content on ${dayISO(month, day)}`}
                      className="min-h-[1.5rem] flex-1 rounded text-left font-mono text-[10px] uppercase tracking-wider text-transparent transition hover:bg-charcoal-800/60 hover:text-ink-dim focus:text-ink-dim focus:outline-none group-hover/day:text-ink-dim"
                    >
                      ＋ Add
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        </div>
        {showContent && items.length === 0 && (
          <p className="mt-4 text-center text-sm text-ink-muted">
            No content scheduled for {monthLabel}
            {brand ? ` · ${brandName.get(brand) ?? "this brand"}` : ""}. Hover a day and click ＋ to
            add one.
          </p>
        )}
        {layer === "live" && liveSessions.length === 0 && (
          <p className="mt-4 text-center text-sm text-ink-muted">
            No live sessions scheduled for {monthLabel}
            {brand ? ` · ${brandName.get(brand) ?? "this brand"}` : ""}. Hover a day and click{" "}
            <span className="text-red-300">＋Live</span> to schedule one.
          </p>
        )}
      </SectionCard>

      {/* Editors */}
      {editItem && (
        <ItemEditor
          key={editItem.id || "new"}
          initial={editItem}
          people={people}
          brandContext={
            (editItem.brand_id && brandContext[editItem.brand_id]) ||
            (brand && brandContext[brand]) ||
            null
          }
          onCancel={() => setEditItem(null)}
          onSave={saveItem}
          onDelete={canDelete ? confirmDelete : undefined}
        />
      )}
      {editInit && (
        <InitiativeEditor
          key={editInit.id}
          initial={editInit}
          onCancel={() => setEditInit(null)}
          onSave={saveInitiative}
        />
      )}
      {editLive && (
        <LiveEditor
          key={editLive.id || "new-live"}
          initial={editLive}
          brands={brands}
          anchors={anchors}
          onCancel={() => setEditLive(null)}
          onSave={saveLive}
          onDelete={deleteLive}
          onAddAnchor={createAnchor}
        />
      )}

      {/* Saving / saved indicator */}
      {saveState !== "idle" && (
        <div
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-1.5 text-xs text-ink-muted shadow-lg"
        >
          {saveState === "saving" ? "Saving…" : "Saved ✓"}
        </div>
      )}

      {/* Error toast */}
      {toast && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300 shadow-lg"
        >
          <span className="flex-1">{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="shrink-0 text-red-300/70 hover:text-red-200"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

// --- Modal shell ------------------------------------------------------------
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-center overflow-y-auto bg-charcoal-950/70 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="min-h-full w-full max-w-lg border border-charcoal-700 bg-charcoal-900 p-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] pt-[max(env(safe-area-inset-top),1.25rem)] shadow-2xl sm:min-h-0 sm:rounded-xl sm:pb-5 sm:pt-5"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-ink-dim hover:text-ink"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// --- Content item editor ----------------------------------------------------
function ItemEditor({
  initial,
  people,
  brandContext,
  onCancel,
  onSave,
  onDelete,
}: {
  initial: PlanItem;
  people: Option[];
  brandContext: BrandContext | null;
  onCancel: () => void;
  onSave: (draft: PlanItem) => void;
  onDelete?: (item: PlanItem) => void;
}) {
  const isNew = !initial.id;
  const [title, setTitle] = useState(initial.title);
  const [status, setStatus] = useState(initial.status || "idea");
  const [pillar, setPillar] = useState(initial.pillar ?? "");
  const [contentType, setContentType] = useState(initial.content_type || "video");
  const [platform, setPlatform] = useState(initial.platform ?? "");
  const [publishDate, setPublishDate] = useState(initial.publish_date ?? "");
  const [assigneeId, setAssigneeId] = useState(initial.assignee_id ?? "");
  const [brief, setBrief] = useState(initial.brief ?? "");
  const [notes, setNotes] = useState(initial.notes ?? "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      ...initial,
      title,
      status,
      pillar: pillar || null,
      content_type: contentType,
      platform: platform || null,
      publish_date: publishDate || null,
      assignee_id: assigneeId || null,
      brief: brief || null,
      notes: notes || null,
    });
  }

  return (
    <Modal title={isNew ? "New content" : "Edit content"} onClose={onCancel}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="ce-title">
            Title
          </label>
          <input
            id="ce-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What's this content?"
            className={fieldCls}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="ce-type">
              Type
            </label>
            <select
              id="ce-type"
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              className={fieldCls}
            >
              {CONTENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ce-status">
              Status
            </label>
            <select
              id="ce-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={fieldCls}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ce-platform">
              Platform
            </label>
            <select
              id="ce-platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className={fieldCls}
            >
              <option value="">No platform</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ce-date">
              Publish date
            </label>
            <input
              id="ce-date"
              type="date"
              value={publishDate}
              onChange={(e) => setPublishDate(e.target.value)}
              className={fieldCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="ce-pillar">
              Pillar
            </label>
            <input
              id="ce-pillar"
              value={pillar}
              onChange={(e) => setPillar(e.target.value)}
              placeholder="Content pillar"
              className={fieldCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="ce-assignee">
              Assignee
            </label>
            <select
              id="ce-assignee"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className={fieldCls}
            >
              <option value="">Unassigned</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* AI "Generate" panel — grounded, human-approved. Reuses the existing
            content_generations engine (POST /api/content-studio/generate); each
            click writes a content_generations ledger row. The user edits the
            output and applies it into the Brief / Notes / Pillar fields below,
            then saves the item. Nothing auto-publishes. */}
        <GeneratePanel
          item={{ ...initial, title, content_type: contentType, platform: platform || null, pillar: pillar || null, brief: brief || null, notes: notes || null }}
          brandContext={brandContext}
          onApplyBrief={(text) => setBrief((b) => (b.trim() ? `${b.trim()}\n\n${text}` : text))}
          onApplyNotes={(text) => setNotes((n) => (n.trim() ? `${n.trim()}\n\n${text}` : text))}
          onApplyPillar={(text) => setPillar(text)}
        />

        <div>
          <label className={labelCls} htmlFor="ce-brief">
            Brief / script
          </label>
          <textarea
            id="ce-brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder="Hook, script, outline — or generate above"
            className={fieldCls}
          />
        </div>

        <div>
          <label className={labelCls} htmlFor="ce-notes">
            Notes / caption
          </label>
          <textarea
            id="ce-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Caption, notes for this item"
            className={fieldCls}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          {!isNew && onDelete && (
            <button
              type="button"
              onClick={() => onDelete(initial)}
              className="mr-auto rounded-md px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 hover:text-red-200"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-2 text-sm text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
          >
            {isNew ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- AI Generate panel ------------------------------------------------------
// Six on-demand generators for a content item. Each reuses the EXISTING
// content_generations engine (POST /api/content-studio/generate) with a
// template_key — no new generation engine, no paid-key dependency. Grounding is
// composed from the item's live editor fields + the brand's context (name +
// latest account_briefing summary); the generator writes a content_generations
// ledger row every time. Output is shown for the human to edit and apply into
// the item's Brief / Notes / Pillar fields — nothing auto-publishes.
const GENERATORS = [
  { key: "video_hooks", label: "Hooks", apply: "brief" as const },
  { key: "content_angles", label: "Angles", apply: "brief" as const },
  { key: "caption", label: "Caption", apply: "notes" as const },
  { key: "cta", label: "CTA", apply: "notes" as const },
  // Format-aware script (structure follows the selected format, not always live).
  { key: "content_script", label: "Script", apply: "brief" as const },
  { key: "content_pillar", label: "Pillar", apply: "pillar" as const },
];

// The pillar/format/product controls the panel adds on top of the item's fields.
// These become the PRIMARY constraints the generate route enforces.
export type CreativeControls = {
  pillar: string;
  format: string;
  product_type: string;
  product_features: string;
  product_benefits: string;
  target_audience: string;
};

// Map the item's live fields + brand context into the inputs each template
// expects. The existing templates (hooks/angles/script) read specific fields, so
// brand context is folded into their free-text slots where they have room; the
// new grounded templates (caption/cta/content_pillar) read the shared shape.
function buildGenInputs(
  key: string,
  item: PlanItem,
  ctx: BrandContext | null,
  controls: CreativeControls
): Record<string, string> {
  const brandName = ctx?.name ?? "";
  const summary = ctx?.summary ?? "";
  const platformLabel = item.platform ? PLATFORM_LABEL[item.platform] ?? item.platform : "";
  const title = item.title?.trim() ?? "";
  const briefText = (item.brief ?? "").trim() || (item.notes ?? "").trim();
  // Pillar: the panel's explicit choice wins; fall back to the item's own pillar.
  const pillar = controls.pillar || item.pillar || "";
  const join = (parts: (string | false | null | undefined)[]) =>
    parts.filter(Boolean).join(" — ");

  // Product grounding — panel fields first, then the item title as the product name.
  const product = {
    product_name: title || brandName,
    product_type: controls.product_type,
    product_features: controls.product_features,
    product_benefits: controls.product_benefits,
    target_audience: controls.target_audience,
  };

  const grounded: Record<string, string> = {
    brand_name: brandName,
    brand_summary: summary,
    title,
    brief: briefText,
    platform: platformLabel,
    content_type: TYPE_LABEL[(item.content_type as ContentType) ?? "other"] ?? item.content_type,
    pillar,
    format: controls.format,
    ...product,
  };

  switch (key) {
    case "video_hooks":
      return { ...grounded, topic: join([title, brandName]) || "this content", tone: "" };
    case "content_angles":
      return {
        ...grounded,
        brand: brandName || title || "this brand",
        context: join([briefText, summary, platformLabel && `Platform: ${platformLabel}`]) || "none",
      };
    case "tiktok_live_script":
      return {
        ...grounded,
        product: title || brandName || "this product",
        hook: join([briefText, summary]) || "highlight value",
        duration: "5 minutes",
      };
    default:
      // caption, cta, content_pillar — read the shared grounded shape.
      return grounded;
  }
}

// Pull a clean, single-line pillar value out of the content_pillar output so it
// can drop straight into the item's (single-line) pillar field.
function extractPillar(output: string): string {
  const m = output.match(/pillar:\s*(.+)/i);
  const line = (m ? m[1] : output.split("\n")[0]).split("\n")[0];
  return line.replace(/[.*_`]+$/g, "").trim();
}

function GeneratePanel({
  item,
  brandContext,
  onApplyBrief,
  onApplyNotes,
  onApplyPillar,
}: {
  item: PlanItem;
  brandContext: BrandContext | null;
  onApplyBrief: (text: string) => void;
  onApplyNotes: (text: string) => void;
  onApplyPillar: (text: string) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");

  // Creative controls — pillar (primary), format (structure), product grounding.
  // Pillar defaults from the item's own pillar (mapped to a known pillar) so an
  // existing "Educational" item pre-selects Educational; the user can override.
  const [pillar, setPillar] = useState<string>(resolvePillar(item.pillar ?? "")?.key ?? "");
  // Format defaults from the item's content_type: a "live" item → live selling,
  // everything else → short-form (never silently live-selling).
  const [format, setFormat] = useState<string>(item.content_type === "live" ? "live_selling" : "short_form");
  const [productType, setProductType] = useState("");
  const [productFeatures, setProductFeatures] = useState("");
  const [productBenefits, setProductBenefits] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [showProduct, setShowProduct] = useState(false);

  const controls: CreativeControls = {
    pillar,
    format,
    product_type: productType,
    product_features: productFeatures,
    product_benefits: productBenefits,
    target_audience: targetAudience,
  };

  const hasBrandContext = !!(brandContext?.summary && brandContext.summary.trim());
  const pillarLabel = resolvePillar(pillar)?.label ?? null;

  async function run(key: string) {
    setActive(key);
    setLoading(key);
    setError("");
    setOutput("");
    setModel("");
    try {
      const res = await fetch("/api/content-studio/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateKey: key, inputs: buildGenInputs(key, item, brandContext, controls) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setOutput(data.output ?? "");
      setModel(data.model ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(null);
    }
  }

  const activeGen = GENERATORS.find((g) => g.key === active);

  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/[0.06] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-violet-300">
            Generate
          </span>
          <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-violet-300">
            AI · human-approved
          </span>
        </div>
        <span className="font-mono text-[10px] text-ink-dim">
          {hasBrandContext ? "grounded in brand briefing" : "grounded in item fields"}
        </span>
      </div>

      {/* Creative controls — pillar (tone/objective) + format (structure). These
          are the PRIMARY constraints the generator obeys over any default tone. */}
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="gen-pillar">
            Content pillar · sets tone + objective
          </label>
          <select
            id="gen-pillar"
            value={pillar}
            onChange={(e) => setPillar(e.target.value)}
            className={fieldCls}
          >
            <option value="">No pillar selected — neutral, not sales</option>
            {PILLAR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="gen-format">
            Content format · sets script structure
          </label>
          <select
            id="gen-format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className={fieldCls}
          >
            {FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Honest empty-state for pillar: say it, don't silently default to sales. */}
      {!pillar && (
        <p className="mb-2 text-[11px] text-amber-300/80">
          No content pillar selected — output stays neutral and native, not hard-sell. Pick a pillar
          (e.g. Trend Jacking, Educational) to steer the tone.
        </p>
      )}

      {/* Product grounding — optional but makes angles match the real product. */}
      <div className="mb-3">
        <button
          type="button"
          onClick={() => setShowProduct((s) => !s)}
          className="font-mono text-[10px] uppercase tracking-wider text-teal-300/80 hover:text-teal-200"
        >
          {showProduct ? "▾" : "▸"} Product context {showProduct ? "" : "(ground angles in the real product)"}
        </button>
        {showProduct && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={productType}
              onChange={(e) => setProductType(e.target.value)}
              placeholder="Product type / category (e.g. gummy vitamin)"
              className={fieldCls}
            />
            <input
              value={targetAudience}
              onChange={(e) => setTargetAudience(e.target.value)}
              placeholder="Target audience"
              className={fieldCls}
            />
            <input
              value={productFeatures}
              onChange={(e) => setProductFeatures(e.target.value)}
              placeholder="Key features"
              className={fieldCls}
            />
            <input
              value={productBenefits}
              onChange={(e) => setProductBenefits(e.target.value)}
              placeholder="Benefits"
              className={fieldCls}
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {GENERATORS.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => run(g.key)}
            disabled={loading !== null}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
              active === g.key
                ? "border-violet-400 bg-violet-500/20 text-violet-200"
                : "border-charcoal-700 bg-charcoal-950 text-ink-muted hover:border-violet-500/50 hover:text-violet-200"
            }`}
          >
            {loading === g.key ? "Generating…" : g.label}
          </button>
        ))}
      </div>

      {!item.title?.trim() && (
        <p className="mt-2 text-[11px] text-amber-300/80">
          Add a title first for grounded output.
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      {output && (
        <div className="mt-3 space-y-2">
          <textarea
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            rows={7}
            className={fieldCls}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
              {activeGen?.label}
              {pillarLabel ? ` · ${pillarLabel}` : " · no pillar"}
              {resolveFormat(format) ? ` · ${resolveFormat(format)!.label.split(" ")[0]}` : ""}
              {model ? ` · ${model}` : ""} · logged
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {activeGen?.apply === "pillar" ? (
                <button
                  type="button"
                  onClick={() => onApplyPillar(extractPillar(output))}
                  className="rounded-md bg-teal-500/90 px-2.5 py-1 text-xs font-medium text-charcoal-950 hover:bg-teal-400"
                >
                  Apply to Pillar
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => (activeGen?.apply === "notes" ? onApplyNotes(output) : onApplyBrief(output))}
                    className="rounded-md bg-teal-500/90 px-2.5 py-1 text-xs font-medium text-charcoal-950 hover:bg-teal-400"
                  >
                    Apply to {activeGen?.apply === "notes" ? "Notes" : "Brief"}
                  </button>
                  <button
                    type="button"
                    onClick={() => (activeGen?.apply === "notes" ? onApplyBrief(output) : onApplyNotes(output))}
                    className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
                  >
                    → {activeGen?.apply === "notes" ? "Brief" : "Notes"}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(output);
                }}
                className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Initiative editor ------------------------------------------------------
function InitiativeEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: PlanInitiative;
  onCancel: () => void;
  onSave: (draft: PlanInitiative) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [type, setType] = useState(initial.type || "campaign");
  const [status, setStatus] = useState(initial.status || "planned");
  const [startDate, setStartDate] = useState(initial.start_date ?? "");
  const [endDate, setEndDate] = useState(initial.end_date ?? "");
  const [note, setNote] = useState(initial.note ?? "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      ...initial,
      name,
      type,
      status,
      start_date: startDate || null,
      end_date: endDate || null,
      note: note || null,
    });
  }

  return (
    <Modal title="Edit initiative" onClose={onCancel}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="ie-name">
            Name
          </label>
          <input
            id="ie-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Initiative name"
            className={fieldCls}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="ie-type">
              Type
            </label>
            <select
              id="ie-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={fieldCls}
            >
              {INITIATIVE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ie-status">
              Status
            </label>
            <select
              id="ie-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={fieldCls}
            >
              {INITIATIVE_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="ie-start">
              Start date
            </label>
            <input
              id="ie-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className={fieldCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="ie-end">
              End date
            </label>
            <input
              id="ie-end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className={fieldCls}
            />
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="ie-note">
            Note
          </label>
          <textarea
            id="ie-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Notes for this initiative"
            className={fieldCls}
          />
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-2 text-sm text-ink-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- Live session editor ----------------------------------------------------
// Schedule (or edit) a live-selling session on a calendar day. Writes a
// live_sessions row status='scheduled' with started_at = the planned start —
// the SAME record the Live Selling page reads. No metrics fields: scheduled means
// nothing has been recorded yet. Delete asks for confirmation, mirroring the
// content delete flow. A link to the full session page keeps the two surfaces in
// one lifecycle.
function LiveEditor({
  initial,
  brands,
  anchors,
  onCancel,
  onSave,
  onDelete,
  onAddAnchor,
}: {
  initial: PlanLiveSession;
  brands: Option[];
  anchors: Option[];
  onCancel: () => void;
  onSave: (draft: PlanLiveSession) => void;
  onDelete: (id: string) => void;
  onAddAnchor: (name: string, platform: string) => Promise<string | null>;
}) {
  const isNew = !initial.id;
  const [brandId, setBrandId] = useState(initial.brand_id ?? "");
  const [anchorId, setAnchorId] = useState(initial.anchor_id ?? "");
  // Live-selling platforms are TikTok Shop / Shopee. If this row came in with a
  // different platform (e.g. one scheduled on the Live Selling page), keep it as a
  // selectable option so saving never silently rewrites it.
  const initialPlatform = initial.platform || "tiktok_shop";
  const platformOptions = (LIVE_PLATFORMS as readonly string[]).includes(initialPlatform)
    ? (LIVE_PLATFORMS as readonly string[])
    : [initialPlatform, ...LIVE_PLATFORMS];
  const [platform, setPlatform] = useState(initialPlatform);
  const [title, setTitle] = useState(initial.title ?? "");
  const [date, setDate] = useState(manilaYMD(initial.started_at));
  const [time, setTime] = useState(manilaHM(initial.started_at) || "20:00");
  const [duration, setDuration] = useState(
    initial.duration_minutes != null ? String(initial.duration_minutes) : ""
  );
  const [notes, setNotes] = useState(initial.notes ?? "");

  // Inline "add host" state.
  const [addingHost, setAddingHost] = useState(false);
  const [newHostName, setNewHostName] = useState("");
  const [newHostPlatform, setNewHostPlatform] = useState("tiktok");
  const [hostBusy, setHostBusy] = useState(false);

  async function addHost() {
    const name = newHostName.trim();
    if (!name || hostBusy) return;
    setHostBusy(true);
    const id = await onAddAnchor(name, newHostPlatform);
    setHostBusy(false);
    if (id) {
      setAnchorId(id);
      setNewHostName("");
      setAddingHost(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const durNum = duration.trim() ? Math.trunc(Number(duration)) : null;
    onSave({
      ...initial,
      brand_id: brandId || null,
      anchor_id: anchorId || null,
      platform,
      title: title.trim() || null,
      started_at: manilaIso(date, time),
      duration_minutes: durNum != null && Number.isFinite(durNum) ? durNum : null,
      notes: notes.trim() || null,
    });
  }

  return (
    <Modal title={isNew ? "Schedule live session" : "Edit live session"} onClose={onCancel}>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2">
          <span
            aria-hidden
            className="rounded-sm bg-red-500/80 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-charcoal-950"
          >
            Live
          </span>
          <span className="text-[11px] text-ink-muted">
            Scheduled — no metrics yet. This is the same record shown on the Live Selling page.
          </span>
        </div>

        <div>
          <label className={labelCls} htmlFor="le-title">
            Title
          </label>
          <input
            id="le-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What's this live about?"
            className={fieldCls}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="le-brand">
              Brand
            </label>
            <select
              id="le-brand"
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              className={fieldCls}
            >
              <option value="">No brand</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="le-platform">
              Platform
            </label>
            <select
              id="le-platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className={fieldCls}
            >
              {platformOptions.map((p) => (
                <option key={p} value={p}>
                  {LIVE_PLATFORM_LABEL[p] ?? PLATFORM_LABEL[p] ?? p}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className={labelCls} htmlFor="le-host">
              Host
            </label>
            <div className="flex items-center gap-2">
              <select
                id="le-host"
                value={anchorId}
                onChange={(e) => setAnchorId(e.target.value)}
                className={fieldCls}
              >
                <option value="">No host</option>
                {anchors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setAddingHost((v) => !v)}
                className="shrink-0 rounded-md border border-charcoal-700 px-2.5 py-2 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
              >
                {addingHost ? "Close" : "＋ Host"}
              </button>
            </div>
            {addingHost && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-charcoal-700/60 bg-charcoal-950 p-2">
                <input
                  value={newHostName}
                  onChange={(e) => setNewHostName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addHost();
                    }
                  }}
                  placeholder="New host name"
                  className={`${fieldCls} flex-1`}
                />
                <select
                  value={newHostPlatform}
                  onChange={(e) => setNewHostPlatform(e.target.value)}
                  className={`${fieldCls} w-auto`}
                >
                  <option value="tiktok">TikTok</option>
                  <option value="shopee">Shopee</option>
                  <option value="instagram">Instagram</option>
                  <option value="facebook">Facebook</option>
                  <option value="youtube">YouTube</option>
                </select>
                <button
                  type="button"
                  onClick={() => void addHost()}
                  disabled={!newHostName.trim() || hostBusy}
                  className="rounded-md bg-teal-500/90 px-3 py-2 text-xs font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
                >
                  {hostBusy ? "Adding…" : "Add host"}
                </button>
              </div>
            )}
          </div>
          <div>
            <label className={labelCls} htmlFor="le-date">
              Planned date
            </label>
            <input
              id="le-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={fieldCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="le-time">
              Planned start (Manila)
            </label>
            <input
              id="le-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={fieldCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="le-duration">
              Planned duration (min)
            </label>
            <input
              id="le-duration"
              type="number"
              min="0"
              step="1"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="e.g. 60"
              className={fieldCls}
            />
          </div>
        </div>

        <div>
          <label className={labelCls} htmlFor="le-notes">
            Notes
          </label>
          <textarea
            id="le-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Run of show, products to feature, promos…"
            className={fieldCls}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            {!isNew && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Delete this scheduled live session? This cannot be undone.")) {
                    onDelete(initial.id);
                  }
                }}
                className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 hover:bg-red-500/20"
              >
                Delete
              </button>
            )}
            {!isNew && (
              <a
                href={`/live/${initial.id}`}
                className="rounded-md border border-charcoal-700 px-3 py-2 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
              >
                Open full detail →
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-3 py-2 text-sm text-ink-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!date}
              className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
            >
              {isNew ? "Schedule live" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
