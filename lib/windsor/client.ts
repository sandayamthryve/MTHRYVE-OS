// lib/windsor/client.ts — the single place the OS talks to Windsor.ai's REST
// API. Two co-equal capabilities: READ live ad performance and WRITE approved
// changes back to the ad platform.
//
// HOW THE APP REACHES WINDSOR (STEP 0 audit answer): the deployed Next.js app
// cannot use the Windsor MCP server — MCP tools only exist inside a Claude
// agent session, never at runtime on Vercel. So the app reaches Windsor exactly
// like every other integration here (HeyGen, fal, JSON2Video, TikTok): a single
// org-wide API key sent as a query param to the Windsor Connector API. There is
// NO OAuth vault — one team-level `WINDSOR_API_KEY`.
//
//   READ   GET  https://connectors.windsor.ai/{connector}?api_key=…&fields=…&date_preset=…
//                → { data: [ { …row… } ] }
//   WRITE  POST https://connectors.windsor.ai/{connector}/actions?api_key=…
//                body { account, action, params } → runs one write action.
//                403 when write actions aren't enabled for the team.
//
// The key is read at CALL TIME (never at module load) so Vercel "Sensitive"
// runtime-only vars are seen fresh per request and nothing captures the secret
// into a build artifact. This module runs ONLY server-side — never import it
// into a "use client" component. The key must never reach the browser.
//
// HONESTY CONTRACT (task DoD): reads and writes NEVER fabricate. A missing key
// throws WindsorNotConfiguredError so callers can render a calm "ad connector
// not configured" state instead of fake numbers. A non-2xx or an error body on
// a WRITE throws WindsorApiError carrying Windsor's real message — the executor
// surfaces it and marks the action failed; money never "succeeds" on a failed
// call.

export const WINDSOR_API_BASE = "https://connectors.windsor.ai";

// The org API key, trimmed, read fresh each call. Undefined when unset.
export function windsorApiKey(): string | undefined {
  const raw = process.env.WINDSOR_API_KEY?.trim();
  return raw ? raw : undefined;
}

// True only when the key is present. The UI and the scan producer gate on this
// to fall back to the honest "not configured" state instead of calling out.
export function isWindsorConfigured(): boolean {
  return Boolean(windsorApiKey());
}

export class WindsorNotConfiguredError extends Error {
  constructor() {
    super("Ad connector not configured — WINDSOR_API_KEY is not set.");
    this.name = "WindsorNotConfiguredError";
  }
}

export function isWindsorNotConfigured(e: unknown): boolean {
  return e instanceof WindsorNotConfiguredError;
}

// A real failure talking to Windsor (non-2xx, or a 2xx body carrying an error).
// `status` is the HTTP status (0 for a network error). The message is Windsor's
// own where we could extract it, so the executor can surface it verbatim.
export class WindsorApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WindsorApiError";
    this.status = status;
  }
}

// ── Read ─────────────────────────────────────────────────────────────────────

// A raw Windsor data row is an untyped bag of the fields we requested. The
// performance layer normalises it; here we keep it permissive.
export type WindsorRow = Record<string, string | number | null>;

export interface GetDataOptions {
  fields: string[];
  datePreset?: string; // e.g. "last_7d" — see Windsor date presets
  dateFrom?: string; // "YYYY-MM-DD"
  dateTo?: string; // "YYYY-MM-DD"
}

// GET a connector's rows for the requested fields + window. Returns the `data`
// array (possibly empty). Throws WindsorNotConfiguredError when the key is
// absent (so the caller distinguishes "not set up" from "no data"), and
// WindsorApiError on a non-2xx — reads never invent rows. Field IDs must be
// valid for the connector (see lib/ad-ops/performance.ts, which only requests
// fields verified against Windsor's get_fields for facebook/tiktok).
export async function getWindsorData(
  connector: string,
  opts: GetDataOptions
): Promise<WindsorRow[]> {
  const key = windsorApiKey();
  if (!key) throw new WindsorNotConfiguredError();

  const params = new URLSearchParams();
  params.set("api_key", key);
  params.set("fields", opts.fields.join(","));
  if (opts.datePreset) params.set("date_preset", opts.datePreset);
  if (opts.dateFrom) params.set("date_from", opts.dateFrom);
  if (opts.dateTo) params.set("date_to", opts.dateTo);

  const url = `${WINDSOR_API_BASE}/${encodeURIComponent(connector)}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", cache: "no-store", headers: { accept: "application/json" } });
  } catch (e) {
    throw new WindsorApiError(`Network error talking to Windsor: ${errText(e)}`, 0);
  }

  const text = await safeText(res);
  if (!res.ok) {
    throw new WindsorApiError(windsorMessage(text) ?? `Windsor returned ${res.status}`, res.status);
  }
  const json = safeParse(text) as { data?: WindsorRow[]; error?: unknown } | null;
  // Some Windsor errors come back 200 with an `error` field — treat as failure.
  if (json && json.error) {
    throw new WindsorApiError(String((json as { error: unknown }).error), res.status);
  }
  return Array.isArray(json?.data) ? (json!.data as WindsorRow[]) : [];
}

// ── Write ────────────────────────────────────────────────────────────────────

export interface ExecuteActionInput {
  connector: string; // "tiktok" | "facebook"
  account: string; // advertiser / ad-account id
  action: string; // Windsor action id, e.g. "pause_campaign"
  params: Record<string, unknown>;
}

export interface ExecuteActionResult {
  ok: true;
  response: unknown; // Windsor's raw response body (the authoritative "after")
}

// POST one write action against one connected account. Returns Windsor's raw
// response on success. Throws WindsorNotConfiguredError when the key is absent,
// and WindsorApiError on ANY non-2xx (403 = write actions not enabled for the
// team) or an error body. It NEVER returns a synthetic success — a failed call
// throws, so the executor records a real failure and no spend change is ever
// reported as done when it wasn't.
export async function executeWindsorAction(input: ExecuteActionInput): Promise<ExecuteActionResult> {
  const key = windsorApiKey();
  if (!key) throw new WindsorNotConfiguredError();

  const url = `${WINDSOR_API_BASE}/${encodeURIComponent(input.connector)}/actions?api_key=${encodeURIComponent(
    key
  )}`;
  const body = JSON.stringify({ account: input.account, action: input.action, params: input.params });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
    });
  } catch (e) {
    throw new WindsorApiError(`Network error talking to Windsor: ${errText(e)}`, 0);
  }

  const text = await safeText(res);
  if (!res.ok) {
    const base = windsorMessage(text) ?? `Windsor returned ${res.status}`;
    const hint =
      res.status === 403
        ? " (write actions may not be enabled for this Windsor team, or the account isn't authorised)."
        : "";
    throw new WindsorApiError(`${base}${hint}`, res.status);
  }
  const json = safeParse(text);
  // A 2xx that still reports an error in the body is a failure, not a success.
  const errField = (json as { error?: unknown } | null)?.error;
  if (errField) throw new WindsorApiError(String(errField), res.status);

  return { ok: true, response: json ?? text };
}

// ── tiny helpers ──────────────────────────────────────────────────────────────

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
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
function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}
// Pull a human message out of a Windsor error body (JSON {error|message|detail}
// or raw text), trimmed. Returns null when nothing useful is present.
function windsorMessage(text: string): string | null {
  const j = safeParse(text) as { error?: unknown; message?: unknown; detail?: unknown } | null;
  const cand =
    (typeof j?.error === "string" && j.error) ||
    (typeof j?.message === "string" && j.message) ||
    (typeof j?.detail === "string" && j.detail) ||
    (text.trim() ? text.trim() : null);
  return cand ? String(cand).slice(0, 400) : null;
}
