// JSON2Video API client — the single place that talks to JSON2Video for movie
// assembly. Auth is one org-wide key sent as the `x-api-key` header (env
// JSON2VIDEO_API_KEY); there is NO OAuth, so — like HeyGen and fal — there is no
// per-org token vault.
//
// The key is read at CALL TIME (never at module load) so Vercel "Sensitive"
// runtime-only vars are seen fresh per request and nothing captures the secret
// into a build artifact. This module runs ONLY server-side — never import it into
// a "use client" component. The key must never reach the browser and is NEVER
// logged.
//
// Rendering is asynchronous:
//   submit → POST https://api.json2video.com/v2/movies  (movie JSON body)
//            → { success, project }            (project id — the movie is NOT ready)
//   status → GET  https://api.json2video.com/v2/movies?project=<id>
//            → { movie: { status: pending|running|done|error, url, duration } }
// The finished URL arrives later via the webhook receiver or a status poll (see
// app/api/integrations/assembly/{webhook,status}). Responses are parsed
// defensively so a JSON2Video shape-drift degrades to null rather than throwing.

export const JSON2VIDEO_API_BASE = "https://api.json2video.com/v2";

// The org key, trimmed, read fresh each call. Undefined when unset.
export function json2videoApiKey(): string | undefined {
  const raw = process.env.JSON2VIDEO_API_KEY?.trim();
  return raw ? raw : undefined;
}

// True only when the key is present. The UI uses this to show a calm "not set up
// yet" state instead of attempting a call that would 401.
export function isJson2VideoConfigured(): boolean {
  return Boolean(json2videoApiKey());
}

// --- Public shapes -----------------------------------------------------------

// Result of a submit. On success projectId is set and error is null; on failure
// projectId is null and error carries a short reason (surfaced to the caller so
// the ledger row can be marked failed with a message).
export interface SubmitMovieResult {
  projectId: string | null;
  error: string | null;
}

// JSON2Video movie lifecycle, normalised. `pending`/`running` are non-terminal;
// `done`/`failed` are terminal. (JSON2Video reports the error state as "error";
// we normalise it to `failed` to match the rest of the app's vocabulary.)
export type MovieStatus = "pending" | "running" | "done" | "failed" | "unknown";

// A finished (or failed) result, normalised to the fields we persist.
export interface MovieResult {
  status: MovieStatus;
  url: string | null;
  durationSeconds: number | null;
  error: string | null;
}

// --- Low-level fetch ---------------------------------------------------------

class Json2VideoKeyMissingError extends Error {
  constructor() {
    super("JSON2VIDEO_API_KEY is not set");
    this.name = "Json2VideoKeyMissingError";
  }
}

export function isJson2VideoKeyMissing(e: unknown): boolean {
  return e instanceof Json2VideoKeyMissingError;
}

// Perform a JSON2Video request with the org key attached. Throws
// Json2VideoKeyMissingError when the key is absent so callers can distinguish
// "not configured" from "call failed". Never logs the key.
async function j2vFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = json2videoApiKey();
  if (!key) throw new Json2VideoKeyMissingError();
  return fetch(`${JSON2VIDEO_API_BASE}${path}`, {
    ...init,
    // Never cache — statuses change and we read env per request.
    cache: "no-store",
    headers: {
      "x-api-key": key,
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

// --- Submit ------------------------------------------------------------------

// POST a movie to JSON2Video (async — returns a project id, the movie is NOT
// ready). `movie` is the fully-built movie JSON (see lib/json2video/template).
// Returns { projectId } on success, else { projectId: null, error }. Logs each
// step (never the key). Never throws for an API error — only re-throws the
// key-missing sentinel so callers can report "not configured".
export async function submitMovie(movie: Record<string, unknown>): Promise<SubmitMovieResult> {
  const fail = (error: string): SubmitMovieResult => ({ projectId: null, error });
  try {
    console.log("[json2video] submit: POST /movies");
    const res = await j2vFetch("/movies", { method: "POST", body: JSON.stringify(movie) });
    if (!res.ok) {
      const body = await safeText(res);
      console.error("[json2video] submit failed", res.status, body);
      return fail(`JSON2Video returned ${res.status}.`);
    }
    const json = (await res.json()) as {
      success?: boolean;
      project?: string;
      message?: string;
      error?: string;
    };
    if (json.success === false || !json.project) {
      const msg = json.message ?? json.error ?? "JSON2Video did not return a project id.";
      console.error("[json2video] submit rejected", msg);
      return fail(msg);
    }
    console.log("[json2video] submit ok, project", json.project);
    return { projectId: json.project, error: null };
  } catch (e) {
    if (isJson2VideoKeyMissing(e)) throw e;
    console.error("[json2video] submit threw", e);
    return fail("Could not reach JSON2Video.");
  }
}

// --- Status ------------------------------------------------------------------

// GET /movies?project=<id> → the movie's current status. Returns a normalised
// MovieResult, or null on a transient failure (so the caller leaves the row for
// the next poll rather than settling it wrongly). Non-terminal states come back
// with url/duration null.
export async function getMovieStatus(projectId: string): Promise<MovieResult | null> {
  try {
    const res = await j2vFetch(`/movies?project=${encodeURIComponent(projectId)}`, {
      method: "GET",
    });
    if (!res.ok) {
      console.error("[json2video] status failed", res.status, await safeText(res));
      return null;
    }
    const json = (await res.json()) as { movie?: unknown };
    return normaliseMovie(json.movie);
  } catch (e) {
    if (isJson2VideoKeyMissing(e)) throw e;
    console.error("[json2video] status threw", e);
    return null;
  }
}

// Normalise a JSON2Video `movie` object (from a status poll OR a webhook body)
// into our stable MovieResult. Defensive: unknown shapes → status 'unknown'.
export function normaliseMovie(movie: unknown): MovieResult {
  const empty: MovieResult = { status: "unknown", url: null, durationSeconds: null, error: null };
  if (!movie || typeof movie !== "object") return empty;
  const m = movie as {
    status?: string;
    url?: string | null;
    duration?: number | string | null;
    message?: string | null;
    error?: string | null;
  };
  const status = normaliseMovieStatus(m.status);
  const durationRaw = m.duration;
  const duration =
    durationRaw == null || durationRaw === ""
      ? null
      : Number.isFinite(Number(durationRaw))
        ? Number(durationRaw)
        : null;
  return {
    status,
    url: status === "done" ? (m.url ?? null) : null,
    durationSeconds: duration,
    error: status === "failed" ? (m.message ?? m.error ?? "JSON2Video reported an error.") : null,
  };
}

// Map JSON2Video's raw status string onto our lifecycle vocabulary. "error" →
// "failed"; anything unexpected → "unknown".
export function normaliseMovieStatus(raw: string | null | undefined): MovieStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "pending":
      return "pending";
    case "error":
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}
