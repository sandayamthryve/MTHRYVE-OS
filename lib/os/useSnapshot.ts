"use client";

// lib/os/useSnapshot.ts — the typed client access to the canonical OS snapshot.
//
// Reads GET /api/os/snapshot (the single org-scoped KPI read) with the browser's
// own credentials, so RLS + the role-gated finance block apply exactly as they do
// on the server. Honest nulls flow straight through: a null field on the snapshot
// stays null here (the UI renders "—"), never a fabricated 0.
//
// RANGE-AWARE: the fetch forwards the page's current date-range query params
// (?preset / ?period_start / ?period_end, plus legacy ?from/?to) so the snapshot is
// scoped to exactly the window the shared <DateRangeControls> picker shows. When
// the user switches tabs the URL changes, the provider re-fetches, and every
// consumer (Revenue tile, its caption, the GMV donut, the Revenue Pulse) updates
// together to the SAME range — the label and the number can never disagree.
//
// ONE FETCH, MANY CONSUMERS: <SnapshotProvider> fetches once per range and shares
// the result via context, so the four range-sensitive surfaces don't each hit the
// route. useSnapshot() reads that context.
//
// SAFETY CONTRACT: `data` is EITHER null OR a value that already has a `company`
// object. A non-2xx status (401/500/…), a body that fails to parse, or a 200 body
// that is not a well-formed snapshot (an auth-redirect HTML page, an { error }
// envelope, shape drift between deploys) all resolve to `error` with `data`
// cleared — never a truthy-but-malformed `data`. That guarantee is what lets every
// consumer read `data.company.gmv` (and `data.range` / `data.freshness`) without
// the read ever throwing.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import type { OsSnapshot } from "@/lib/os/snapshot";

export type { OsSnapshot } from "@/lib/os/snapshot";

export interface UseSnapshotResult {
  data: OsSnapshot | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

// Minimal runtime shape check: a usable snapshot is an object carrying a `company`
// object. We only assert what consumers actually dereference — individual fields
// (e.g. company.gmv) are allowed to be null and flow through as honest "—".
function isOsSnapshot(value: unknown): value is OsSnapshot {
  if (value == null || typeof value !== "object") return false;
  const company = (value as { company?: unknown }).company;
  return company != null && typeof company === "object";
}

// The date-range params the snapshot route understands. We forward only these so
// unrelated query params (e.g. UI-only flags) never change the cache key.
const RANGE_PARAM_KEYS = [
  "preset",
  "period_start",
  "period_end",
  "from",
  "to",
  "brand_id",
] as const;

// Build the snapshot query string from the page's current search params, keeping
// only the date-range keys and in a STABLE order so identical ranges hit the same
// URL (browser cache) and the effect's dependency is a plain string.
function rangeQuery(params: URLSearchParams | null): string {
  const next = new URLSearchParams();
  for (const key of RANGE_PARAM_KEYS) {
    const v = params?.get(key);
    if (v) next.set(key, v);
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

// The shared fetch, keyed by the resolved range query string. `enabled` lets the
// standalone path stay inert (fire no request) when a provider already owns the
// fetch — hooks still run unconditionally, they just don't hit the network.
function useSnapshotFetch(query: string, enabled = true): UseSnapshotResult {
  const [data, setData] = useState<OsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    setError(null);

    fetch(`/api/os/snapshot${query}`, { credentials: "same-origin" })
      .then(async (res) => {
        // Non-2xx (401 unauthenticated, 500 build failure, …): surface the status
        // as an error and let the caller keep showing its fallback value.
        if (!res.ok) throw new Error(`snapshot request failed (${res.status})`);
        // A successful status can still carry a non-JSON body (e.g. an auth
        // redirect served as HTML). Parsing that throws here and is caught below.
        const json: unknown = await res.json();
        // …and a JSON body can still be the wrong shape ({ error } envelope, an
        // older/newer deploy). Reject it rather than let a truthy-but-malformed
        // object reach the UI, where `data.company.gmv` would throw.
        if (!isOsSnapshot(json)) throw new Error("snapshot response malformed");
        return json;
      })
      .then((json) => {
        if (!alive) return;
        setData(json);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // Clear any prior data so the { data } we hand back is never a stale or
        // malformed value once an error is set.
        setData(null);
        setError(err instanceof Error ? err.message : "snapshot request failed");
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [query, nonce, enabled]);

  return { data, error, loading, refresh };
}

const SnapshotContext = createContext<UseSnapshotResult | null>(null);

// Provider: fetches the snapshot once for the page's current range and shares it.
// Wrap the range-sensitive region of the Command Center in this so the tile, its
// caption, the donut and the pulse all read the SAME single fetch.
export function SnapshotProvider({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const query = useMemo(() => rangeQuery(params), [params]);
  const value = useSnapshotFetch(query);
  return createElement(SnapshotContext.Provider, { value }, children);
}

// Read the shared snapshot. Inside a <SnapshotProvider> this returns the shared
// fetch; used standalone (no provider) it runs its own range-scoped fetch, so a
// lone consumer still works exactly as before.
export function useSnapshot(): UseSnapshotResult {
  const ctx = useContext(SnapshotContext);
  const params = useSearchParams();
  const query = useMemo(() => rangeQuery(params), [params]);
  // Hooks must run unconditionally; the standalone fetch is disabled (fires no
  // request) when a provider is present and its result is discarded.
  const standalone = useSnapshotFetch(query, !ctx);
  return ctx ?? standalone;
}
