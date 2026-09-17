// HeyGen AI-video API client — the single place that talks to HeyGen. Auth is a
// single org-wide API key sent in the `x-api-key` header (env HEYGEN_API_KEY);
// there is NO OAuth, so unlike Canva/TikTok there is no per-org token vault.
//
// The key is read at CALL TIME (never at module load) so Vercel "Sensitive"
// runtime-only vars are seen fresh per request, and so nothing captures the
// secret into a build artifact. This module runs ONLY server-side — never import
// it into a "use client" component. The key must never reach the browser.
//
// Video generation is asynchronous: generateVideo() submits and returns a
// video_id; the finished URL arrives later via the webhook receiver or a status
// poll (see app/api/integrations/heygen/{webhook,status}). Response shapes below
// follow the v2 generate / v1 status / v2 avatars+voices / v3 users.me endpoints
// documented at developers.heygen.com, parsed defensively so a shape drift
// degrades to null/empty rather than throwing.

export const HEYGEN_API_BASE = "https://api.heygen.com";

// The org API key, trimmed, read fresh each call. Undefined when unset.
export function heygenApiKey(): string | undefined {
  const raw = process.env.HEYGEN_API_KEY?.trim();
  return raw ? raw : undefined;
}

// True only when the key is present. The UI uses this to fall back to a calm
// "not set up yet" state instead of attempting a call that would 401.
export function isHeygenConfigured(): boolean {
  return Boolean(heygenApiKey());
}

// --- Public shapes we expose to callers (a trimmed, stable subset) -----------

export interface HeygenAvatar {
  avatar_id: string;
  name: string;
  gender: string | null;
  preview_image_url: string | null;
  preview_video_url: string | null;
}

export interface HeygenVoice {
  voice_id: string;
  name: string;
  language: string | null;
  gender: string | null;
}

export interface HeygenVideoDimensions {
  width: number;
  height: number;
}

export interface GenerateVideoInput {
  title: string;
  script: string;
  avatar_id: string;
  voice_id: string;
  dimensions?: HeygenVideoDimensions;
}

// Result of a submit. On success videoId is set and error is null; on failure
// videoId is null and error carries a short reason (surfaced to the caller so
// the ledger row can be marked failed with a message).
export interface GenerateVideoResult {
  videoId: string | null;
  error: string | null;
}

// Normalised video status. `status` is one of HeyGen's lifecycle values,
// lowercased; the rest are present only once the video completes.
export interface HeygenVideoStatus {
  status: "waiting" | "pending" | "processing" | "completed" | "failed" | "unknown";
  videoUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  error: string | null;
}

// --- Low-level fetch ---------------------------------------------------------

class HeygenKeyMissingError extends Error {
  constructor() {
    super("HEYGEN_API_KEY is not set");
    this.name = "HeygenKeyMissingError";
  }
}

// Perform a HeyGen request with the org key attached. Throws
// HeygenKeyMissingError when the key is absent so callers can distinguish
// "not configured" from "call failed". Never logs the key.
async function heygenFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = heygenApiKey();
  if (!key) throw new HeygenKeyMissingError();
  return fetch(`${HEYGEN_API_BASE}${path}`, {
    ...init,
    // Never cache — balances and statuses change, and we read env per request.
    cache: "no-store",
    headers: {
      "x-api-key": key,
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

export function isHeygenKeyMissing(e: unknown): boolean {
  return e instanceof HeygenKeyMissingError;
}

// --- Avatars -----------------------------------------------------------------

// GET /v2/avatars → { data: { avatars: [...], talking_photos: [...] } }.
// Returns the avatar list only (talking photos are a different flow). Logs and
// returns [] on any failure — the picker just shows an empty state then.
export async function listAvatars(): Promise<HeygenAvatar[]> {
  try {
    const res = await heygenFetch("/v2/avatars", { method: "GET" });
    if (!res.ok) {
      console.error("[heygen] listAvatars failed", res.status, await safeText(res));
      return [];
    }
    const json = (await res.json()) as {
      data?: {
        avatars?: Array<{
          avatar_id?: string;
          avatar_name?: string;
          name?: string;
          gender?: string;
          preview_image_url?: string;
          preview_video_url?: string;
        }>;
      };
    };
    const rows = json.data?.avatars ?? [];
    return rows
      .filter((a) => a.avatar_id)
      .map((a) => ({
        avatar_id: a.avatar_id as string,
        name: (a.avatar_name ?? a.name ?? a.avatar_id) as string,
        gender: a.gender ?? null,
        preview_image_url: a.preview_image_url ?? null,
        preview_video_url: a.preview_video_url ?? null,
      }));
  } catch (e) {
    if (isHeygenKeyMissing(e)) throw e;
    console.error("[heygen] listAvatars threw", e);
    return [];
  }
}

// --- Voices ------------------------------------------------------------------

// GET /v2/voices → { data: { voices: [...] } }. Returns the voice list; logs
// and returns [] on failure.
export async function listVoices(): Promise<HeygenVoice[]> {
  try {
    const res = await heygenFetch("/v2/voices", { method: "GET" });
    if (!res.ok) {
      console.error("[heygen] listVoices failed", res.status, await safeText(res));
      return [];
    }
    const json = (await res.json()) as {
      data?: {
        voices?: Array<{
          voice_id?: string;
          name?: string;
          display_name?: string;
          language?: string;
          gender?: string;
        }>;
      };
    };
    const rows = json.data?.voices ?? [];
    return rows
      .filter((v) => v.voice_id)
      .map((v) => ({
        voice_id: v.voice_id as string,
        name: (v.display_name ?? v.name ?? v.voice_id) as string,
        language: v.language ?? null,
        gender: v.gender ?? null,
      }));
  } catch (e) {
    if (isHeygenKeyMissing(e)) throw e;
    console.error("[heygen] listVoices threw", e);
    return [];
  }
}

// --- Generate ----------------------------------------------------------------

const DEFAULT_DIMENSIONS: HeygenVideoDimensions = { width: 1280, height: 720 };

// POST /v2/video/generate. Body is the v2 shape: a single video_input pairing an
// avatar character with a text voice, plus a dimension and a title. Returns the
// new video_id (async — the video is NOT ready yet). On failure returns
// { videoId: null, error } so the caller marks the ledger row failed.
export async function generateVideo(input: GenerateVideoInput): Promise<GenerateVideoResult> {
  const dimension = input.dimensions ?? DEFAULT_DIMENSIONS;
  const body = {
    title: input.title.slice(0, 255) || "Mthryve OS video",
    dimension,
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: input.avatar_id,
          avatar_style: "normal",
        },
        voice: {
          type: "text",
          input_text: input.script,
          voice_id: input.voice_id,
        },
      },
    ],
  };
  try {
    const res = await heygenFetch("/v2/video/generate", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const text = await safeText(res);
    if (!res.ok) {
      console.error("[heygen] generateVideo failed", res.status, text);
      return { videoId: null, error: `HeyGen returned ${res.status}` };
    }
    const json = safeParse(text) as {
      data?: { video_id?: string };
      video_id?: string;
      error?: { message?: string } | string | null;
    } | null;
    const videoId = json?.data?.video_id ?? json?.video_id ?? null;
    if (!videoId) {
      const msg =
        (typeof json?.error === "object" ? json?.error?.message : json?.error) ??
        "HeyGen did not return a video_id";
      console.error("[heygen] generateVideo no video_id", msg);
      return { videoId: null, error: String(msg) };
    }
    return { videoId, error: null };
  } catch (e) {
    if (isHeygenKeyMissing(e)) throw e;
    console.error("[heygen] generateVideo threw", e);
    return { videoId: null, error: "Network error talking to HeyGen" };
  }
}

// --- Status ------------------------------------------------------------------

// GET /v1/video_status.get?video_id=... → { data: { status, video_url,
// thumbnail_url, duration, error } }. Normalises the status to lowercase and
// pulls the completion fields. Returns null when the call itself fails (so the
// poller leaves the row untouched and tries again later).
export async function getVideoStatus(videoId: string): Promise<HeygenVideoStatus | null> {
  try {
    const res = await heygenFetch(
      `/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`,
      { method: "GET" }
    );
    if (!res.ok) {
      console.error("[heygen] getVideoStatus failed", res.status, await safeText(res));
      return null;
    }
    const json = (await res.json()) as {
      data?: {
        status?: string;
        video_url?: string | null;
        thumbnail_url?: string | null;
        duration?: number | string | null;
        error?: { message?: string; detail?: string } | string | null;
      };
    };
    const d = json.data;
    if (!d) return null;
    return normaliseStatus(d);
  } catch (e) {
    if (isHeygenKeyMissing(e)) throw e;
    console.error("[heygen] getVideoStatus threw", e);
    return null;
  }
}

// Shared normaliser used by both the status poll and the webhook receiver.
export function normaliseStatus(d: {
  status?: string;
  video_url?: string | null;
  thumbnail_url?: string | null;
  duration?: number | string | null;
  error?: { message?: string; detail?: string } | string | null;
}): HeygenVideoStatus {
  const raw = (d.status ?? "").toLowerCase();
  const status: HeygenVideoStatus["status"] =
    raw === "completed" || raw === "success"
      ? "completed"
      : raw === "failed" || raw === "error"
        ? "failed"
        : raw === "processing"
          ? "processing"
          : raw === "pending"
            ? "pending"
            : raw === "waiting"
              ? "waiting"
              : "unknown";
  const durationNum =
    d.duration == null ? null : Number(d.duration);
  const errMsg =
    typeof d.error === "object" && d.error
      ? d.error.message ?? d.error.detail ?? null
      : typeof d.error === "string"
        ? d.error
        : null;
  return {
    status,
    videoUrl: d.video_url ?? null,
    thumbnailUrl: d.thumbnail_url ?? null,
    durationSeconds: durationNum != null && Number.isFinite(durationNum) ? durationNum : null,
    error: errMsg,
  };
}

// --- Wallet ------------------------------------------------------------------

// What getWallet() reports: the raw remaining quota (HeyGen's credit balance)
// and, when the payload happens to carry an explicit dollar figure, a USD
// balance. remainingQuota is the source of truth for the "wallet empty" gate;
// walletBalanceUsd is null unless a USD/dollar-named field is present.
export interface HeygenWallet {
  remainingQuota: number | null;
  walletBalanceUsd: number | null;
}

// GET /v2/user/remaining_quota → { error, data: { remaining_quota, details? } }
// (docs.heygen.com/reference/get-remaining-quota-v2). Returns the raw
// remaining_quota and any explicit USD balance. Both null when the key is
// missing/invalid or the field can't be found — the diag reads null-next-to-key
// as the tell-tale of a bad key, and callers gate on remainingQuota <= 0.
export async function getWallet(): Promise<HeygenWallet> {
  const empty: HeygenWallet = { remainingQuota: null, walletBalanceUsd: null };
  try {
    const res = await heygenFetch("/v2/user/remaining_quota", { method: "GET" });
    if (!res.ok) {
      console.error("[heygen] getWallet failed", res.status, await safeText(res));
      return empty;
    }
    const json = (await res.json()) as {
      error?: unknown;
      data?: {
        remaining_quota?: number | string | null;
        details?: Record<string, unknown> | null;
      } | null;
    };
    const data = json.data;
    if (!data) return empty;
    const remainingQuota = toFiniteNumber(data.remaining_quota);
    // remaining_quota is a CREDIT count, never dollars, so it is not treated as
    // USD. Only an explicit dollar-named field populates walletBalanceUsd.
    const walletBalanceUsd = extractUsdBalance(data as Record<string, unknown>);
    return { remainingQuota, walletBalanceUsd };
  } catch (e) {
    if (isHeygenKeyMissing(e)) throw e;
    console.error("[heygen] getWallet threw", e);
    return empty;
  }
}

// Probe the quota payload (top level + nested `details`) for an explicit
// USD/dollar balance — a key whose name mentions usd or dollar. HeyGen's quota
// endpoint documents only a credit count, so this normally returns null; it's a
// forward-compatible hook for a dollar field, never a reinterpretation of the
// credit count. Returns null when nothing dollar-named is found.
function extractUsdBalance(data: Record<string, unknown>): number | null {
  const details = data["details"];
  const sources: Record<string, unknown>[] = [
    data,
    details && typeof details === "object" ? (details as Record<string, unknown>) : {},
  ];
  for (const src of sources) {
    for (const [key, value] of Object.entries(src)) {
      if (!/usd|dollar/i.test(key)) continue;
      const n = toFiniteNumber(value);
      if (n != null) return n;
    }
  }
  return null;
}

// Coerce a number|string|null-ish value to a finite number, or null.
function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// --- tiny helpers ------------------------------------------------------------

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
