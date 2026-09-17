"use server";

import { revalidatePath } from "next/cache";
import { requireProfile, requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { classifyVideoUrl, normalizeEmbedUrl } from "@/lib/live-wall/embed";
import { SESSION_STATUSES } from "@/lib/live-wall/constants";

// Server actions for the Live & Video Wall.
//
// ADDITIVE-ACCESS model, mirroring the Creative Studio / content_items pattern:
// the whole org OPERATES the wall. Adding + editing a session (live_sessions is
// org-writable) and posting + editing a video (videos gained org INSERT/UPDATE)
// use requireProfile, so any signed-in member can do them and RLS accepts the
// write. Only the DESTRUCTIVE path stays leadership: hard-deleting a session or a
// video keeps requireRole(MANAGE_ROLES) to match the leadership-only RLS DELETE
// (live_sessions_write / videos_write). The whole org READS both (org-read RLS).
//
// Honest data only: a live session is a real row (source='manual', no fabricated
// metrics — the tile's numbers come from the Live compartment, not from here). A
// video is refused unless its link is a genuinely supported TikTok / YouTube /
// MP4 URL, so the library never stores something it cannot play.

// Destructive (hard-delete) gate — matches the leadership-only RLS DELETE on both
// live_sessions and videos. Non-destructive writes use requireProfile (org-wide).
const MANAGE_ROLES = ["ceo", "coo", "department_head"] as const;

type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<{ error: unknown }>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
    delete: () => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
  };
};

// A trimmed non-empty string, or null (never store an empty string).
function txt(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v || null;
}

function validStatus(raw: string): raw is (typeof SESSION_STATUSES)[number] {
  return (SESSION_STATUSES as readonly string[]).includes(raw);
}

// ── Live sessions (add / edit on the wall) ────────────────────────────────────
//
// The wall's session form owns the fields the multiview needs: brand, host
// (anchor), platform, title, status and — uniquely — embed_url / thumbnail_url.
// embed_url is what turns a tile from a link-out into an inline player, so it is
// editable here (the analytics-focused /live logger does not touch it).

export async function createLiveSession(formData: FormData) {
  const profile = await requireProfile();
  const status = String(formData.get("status") ?? "scheduled");
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("live_sessions").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    brand_id: txt(formData, "brand_id"),
    anchor_id: txt(formData, "anchor_id"),
    platform: txt(formData, "platform") ?? "tiktok",
    title: txt(formData, "title"),
    status: validStatus(status) ? status : "scheduled",
    // Canonicalize the pasted stream URL to the official player form (a YouTube
    // watch/shorts/live link → the nocookie embed) so the row stores the
    // embeddable URL; HLS/MP4/native-live links pass through unchanged.
    embed_url: normalizeEmbedUrl(txt(formData, "embed_url")),
    thumbnail_url: txt(formData, "thumbnail_url"),
    // Timestamp a session that is created already live so the tile can tick.
    started_at: status === "live" ? new Date().toISOString() : null,
    // Manual row: no platform primary key (a future API sync writes its own).
    external_id: null,
    source: "manual",
  });
  revalidatePath("/live-wall");
}

export async function updateLiveSession(formData: FormData) {
  await requireProfile();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const status = String(formData.get("status") ?? "scheduled");
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("live_sessions")
    .update({
      brand_id: txt(formData, "brand_id"),
      anchor_id: txt(formData, "anchor_id"),
      platform: txt(formData, "platform") ?? "tiktok",
      title: txt(formData, "title"),
      status: validStatus(status) ? status : "scheduled",
      // Same canonicalization as create: store the official embed form so an
      // edited tile plays inline instead of relying only on render-time parsing.
      embed_url: normalizeEmbedUrl(txt(formData, "embed_url")),
      thumbnail_url: txt(formData, "thumbnail_url"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/live-wall");
}

// Quick status flip from a tile (scheduled → live → ended). Stamps started_at
// when a live begins with no start time, and ended_at when it ends — both are
// real event times, never invented metrics.
export async function setLiveStatus(formData: FormData) {
  await requireProfile();
  const id = String(formData.get("id") ?? "").trim();
  const status = String(formData.get("status") ?? "");
  if (!id || !validStatus(status)) return;
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "live" && String(formData.get("started_at") ?? "") === "") {
    patch.started_at = new Date().toISOString();
  }
  if (status === "ended" && String(formData.get("ended_at") ?? "") === "") {
    patch.ended_at = new Date().toISOString();
  }
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("live_sessions").update(patch).eq("id", id);
  revalidatePath("/live-wall");
}

export async function deleteLiveSession(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("live_sessions").delete().eq("id", id);
  revalidatePath("/live-wall");
}

// ── Video library (paste a link → embed & play) ───────────────────────────────

// useFormState shape so an unsupported link surfaces inline instead of throwing.
export type AddVideoState = { error: string } | null;

export async function addVideo(_prev: AddVideoState, formData: FormData): Promise<AddVideoState> {
  const profile = await requireProfile();
  const title = String(formData.get("title") ?? "").trim();
  const url = String(formData.get("video_url") ?? "").trim();
  if (!title) return { error: "A title is required." };
  if (!url) return { error: "Paste a video link." };

  // Only genuinely embeddable links are accepted — the library plays every entry
  // through an official player, so an unrecognised link is refused, not stored.
  const embedType = classifyVideoUrl(url);
  if (!embedType) {
    return { error: "Unsupported link. Paste a TikTok video, a YouTube link, or a direct .mp4/.webm URL." };
  }

  const supabase = createServerSupabaseClient();
  const { error } = await (supabase as unknown as DbShim).from("videos").insert({
    org_id: profile.org_id,
    added_by: profile.id,
    brand_id: txt(formData, "brand_id"),
    title,
    platform: embedType,
    video_url: url,
    embed_type: embedType,
    description: txt(formData, "description"),
  });
  if (error) return { error: "Could not save the video. Please try again." };
  revalidatePath("/live-wall");
  return null;
}

export async function deleteVideo(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("videos").delete().eq("id", id);
  revalidatePath("/live-wall");
}
