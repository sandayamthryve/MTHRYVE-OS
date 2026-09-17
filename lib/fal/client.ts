// fal.ai queue API client — the single place that talks to fal for generative
// video. Auth is one org-wide key sent as the `Authorization: Key <FAL_KEY>`
// header (env FAL_KEY); there is NO OAuth, so — like HeyGen — there is no
// per-org token vault.
//
// The key is read at CALL TIME (never at module load) so Vercel "Sensitive"
// runtime-only vars are seen fresh per request and nothing captures the secret
// into a build artifact. This module runs ONLY server-side — never import it
// into a "use client" component. The key must never reach the browser and is
// never logged.
//
// Generation is asynchronous via fal's QUEUE API:
//   submit → POST https://queue.fal.run/<model_slug>  → { request_id, status_url,
//            response_url }  (optionally ?fal_webhook=<url> to be called back)
//   status → GET  <status_url>                        → { status: IN_QUEUE |
//            IN_PROGRESS | COMPLETED | ... }
//   result → GET  <response_url>                       → the model output (the
//            finished video url, thumbnail, duration)
// The finished URL arrives later via the webhook receiver or a status poll (see
// app/api/integrations/video/{webhook,status}). Responses are parsed defensively
// so a fal shape-drift degrades to null rather than throwing.

export const FAL_QUEUE_BASE = "https://queue.fal.run";

// The org key, trimmed, read fresh each call. Undefined when unset.
export function falKey(): string | undefined {
  const raw = process.env.FAL_KEY?.trim();
  return raw ? raw : undefined;
}

// True only when the key is present. The UI uses this to show a calm "not set
// up yet" state instead of attempting a call that would 401.
export function isFalConfigured(): boolean {
  return Boolean(falKey());
}

// --- Public shapes -----------------------------------------------------------

// Input to a submit. `input` is the model-specific body (prompt, duration,
// image_url…) built by the caller from the model catalog.
export interface SubmitVideoInput {
  slug: string;
  input: Record<string, unknown>;
  webhookUrl?: string | null;
}

// Result of a submit. On success requestId + the two queue URLs are set and
// error is null; on failure requestId is null and error carries a short reason.
export interface SubmitVideoResult {
  requestId: string | null;
  statusUrl: string | null;
  responseUrl: string | null;
  error: string | null;
}

// fal queue lifecycle, normalised. `queued`/`in_progress` are non-terminal;
// `completed`/`failed` are terminal.
export type FalStatus = "queued" | "in_progress" | "completed" | "failed" | "unknown";

// A finished (or failed) result, normalised to the fields we persist.
export interface FalVideoResult {
  status: FalStatus;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  error: string | null;
}

// --- Low-level fetch ---------------------------------------------------------

class FalKeyMissingError extends Error {
  constructor() {
    super("FAL_KEY is not set");
    this.name = "FalKeyMissingError";
  }
}

export function isFalKeyMissing(e: unknown): boolean {
  return e instanceof FalKeyMissingError;
}

// Perform a fal request with the org key attached. Throws FalKeyMissingError
// when the key is absent so callers can distinguish "not configured" from "call
// failed". Never logs the key. `url` may be an absolute queue URL (status/result)
// or a slug path appended to the base (submit).
async function falFetch(url: string, init?: RequestInit): Promise<Response> {
  const key = falKey();
  if (!key) throw new FalKeyMissingError();
  const full = url.startsWith("http") ? url : `${FAL_QUEUE_BASE}/${url.replace(/^\/+/, "")}`;
  return fetch(full, {
    ...init,
    // Never cache — statuses change and we read env per request.
    cache: "no-store",
    headers: {
      Authorization: `Key ${key}`,
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

// --- Submit ------------------------------------------------------------------

// POST a job to the fal queue. When webhookUrl is given, fal will POST the
// completion to it (?fal_webhook=…); otherwise rely on the /status poll. Returns
// { requestId, statusUrl, responseUrl } on success, else { …null, error }. Logs
// each step (never the key or the full prompt).
export async function submitVideo(args: SubmitVideoInput): Promise<SubmitVideoResult> {
  const fail: SubmitVideoResult = {
    requestId: null,
    statusUrl: null,
    responseUrl: null,
    error: null,
  };
  const path =
    args.webhookUrl && args.webhookUrl.length > 0
      ? `${args.slug}?fal_webhook=${encodeURIComponent(args.webhookUrl)}`
      : args.slug;
  try {
    console.log("[fal] submit →", args.slug, "webhook", Boolean(args.webhookUrl));
    const res = await falFetch(path, { method: "POST", body: JSON.stringify(args.input) });
    const text = await safeText(res);
    if (!res.ok) {
      console.error("[fal] submit failed", res.status, text);
      return { ...fail, error: `fal returned ${res.status}` };
    }
    const json = safeParse(text) as
      | { request_id?: string; status_url?: string; response_url?: string }
      | null;
    const requestId = json?.request_id ?? null;
    if (!requestId) {
      console.error("[fal] submit: no request_id in response");
      return { ...fail, error: "fal did not return a request_id" };
    }
    console.log("[fal] submitted", requestId);
    return {
      requestId,
      statusUrl: json?.status_url ?? null,
      responseUrl: json?.response_url ?? null,
      error: null,
    };
  } catch (e) {
    if (isFalKeyMissing(e)) throw e;
    console.error("[fal] submit threw", e);
    return { ...fail, error: "Network error talking to fal" };
  }
}

// --- Status + result ---------------------------------------------------------

// GET the queue status for a request. `statusUrl` is fal's returned status_url;
// when absent we build it from the slug + request id. Returns null on a transient
// call failure (so the poller leaves the row and retries later).
export async function getQueueStatus(
  slug: string,
  requestId: string,
  statusUrl?: string | null
): Promise<{ status: FalStatus } | null> {
  const url = statusUrl || `${slug}/requests/${encodeURIComponent(requestId)}/status`;
  try {
    const res = await falFetch(url, { method: "GET" });
    if (!res.ok) {
      console.error("[fal] status failed", requestId, res.status, await safeText(res));
      return null;
    }
    const json = (await res.json()) as { status?: string };
    return { status: normaliseFalStatus(json.status) };
  } catch (e) {
    if (isFalKeyMissing(e)) throw e;
    console.error("[fal] status threw", requestId, e);
    return null;
  }
}

// GET the finished result for a request and normalise the media fields.
// `responseUrl` is fal's returned response_url; when absent we build it. Returns
// null on a transient failure. A COMPLETED job with no url normalises to failed.
export async function getQueueResult(
  slug: string,
  requestId: string,
  responseUrl?: string | null
): Promise<FalVideoResult | null> {
  const url = responseUrl || `${slug}/requests/${encodeURIComponent(requestId)}`;
  try {
    const res = await falFetch(url, { method: "GET" });
    const text = await safeText(res);
    if (!res.ok) {
      console.error("[fal] result failed", requestId, res.status, text);
      return null;
    }
    const json = safeParse(text);
    return normaliseFalResult(json);
  } catch (e) {
    if (isFalKeyMissing(e)) throw e;
    console.error("[fal] result threw", requestId, e);
    return null;
  }
}

// Map fal's raw queue status string to our lifecycle enum.
export function normaliseFalStatus(raw: string | undefined | null): FalStatus {
  switch ((raw ?? "").toUpperCase()) {
    case "IN_QUEUE":
      return "queued";
    case "IN_PROGRESS":
      return "in_progress";
    case "COMPLETED":
    case "OK":
      return "completed";
    case "ERROR":
    case "FAILED":
      return "failed";
    default:
      return "unknown";
  }
}

// Extract { videoUrl, thumbnailUrl, durationSeconds } from a fal output payload.
// fal video models vary: the clip may sit at `video.url`, `video_url`, or the
// first entry of a `videos`/`output` array; thumbnail at `thumbnail_url` or
// `image.url`; duration at `duration`/`video.duration`. Probed defensively — a
// payload with a video url normalises to completed, without one to failed.
export function normaliseFalResult(payload: unknown): FalVideoResult {
  const p = (payload ?? {}) as Record<string, unknown>;
  const videoUrl = firstUrl([
    (p.video as Record<string, unknown> | undefined)?.url,
    p.video_url,
    firstArrayUrl(p.videos),
    firstArrayUrl(p.output),
    (p.output as Record<string, unknown> | undefined)?.url,
  ]);
  const thumbnailUrl = firstUrl([
    p.thumbnail_url,
    (p.thumbnail as Record<string, unknown> | undefined)?.url,
    (p.image as Record<string, unknown> | undefined)?.url,
    (p.video as Record<string, unknown> | undefined)?.thumbnail_url,
  ]);
  const durationSeconds = firstNumber([
    p.duration,
    (p.video as Record<string, unknown> | undefined)?.duration,
    (p.output as Record<string, unknown> | undefined)?.duration,
  ]);
  // An explicit error field, or a completed-but-empty payload.
  const errRaw = p.error ?? p.detail ?? null;
  const error =
    typeof errRaw === "string"
      ? errRaw
      : errRaw && typeof errRaw === "object"
        ? ((errRaw as { message?: string }).message ?? null)
        : null;

  if (videoUrl) {
    return { status: "completed", videoUrl, thumbnailUrl, durationSeconds, error: null };
  }
  return {
    status: "failed",
    videoUrl: null,
    thumbnailUrl,
    durationSeconds,
    error: error ?? "fal returned no video",
  };
}

// --- tiny helpers ------------------------------------------------------------

function firstUrl(candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
  }
  return null;
}
function firstArrayUrl(arr: unknown): string | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  if (typeof first === "string") return firstUrl([first]);
  if (first && typeof first === "object") {
    return firstUrl([(first as Record<string, unknown>).url]);
  }
  return null;
}
function firstNumber(candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : typeof c === "number" ? c : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 800);
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
