"use client";

// Run-research island for Agent CSI. Collects a job type, a free-text query and
// an optional brand, POSTs to /api/csi/research, then refreshes the server feed
// so any newly-stored findings appear. It surfaces the route's honest result —
// including the "nothing verifiable this run" and "not configured" cases — and
// never renders a fabricated finding of its own.

import { useState } from "react";
import { useRouter } from "next/navigation";

type JobType = "trend" | "business_opportunity";

type RunMessage = { ok: boolean; text: string } | null;

export function RunResearchControl({ brands }: { brands: { id: string; name: string }[] }) {
  const router = useRouter();
  const [jobType, setJobType] = useState<JobType>("trend");
  const [query, setQuery] = useState("");
  const [brandId, setBrandId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<RunMessage>(null);

  const placeholder =
    jobType === "trend"
      ? "e.g. trending skincare on TikTok Shop PH"
      : "e.g. underserved home & living niches on Shopee PH";

  async function run() {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/csi/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_type: jobType, query: q, brand_id: brandId || null }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; inserted?: number; skipped?: number; message?: string; error?: string }
        | null;

      if (!res.ok || !data?.ok) {
        setMessage({
          ok: false,
          text: data?.message || data?.error || `Research failed (${res.status}).`,
        });
      } else if (!data.inserted) {
        // Honest empty / all-duplicate result — nothing new stored.
        setMessage({
          ok: true,
          text:
            data.message ||
            (data.skipped
              ? `No new findings — ${data.skipped} already on file or unverifiable.`
              : "No new findings stored this run."),
        });
        if (data.skipped) router.refresh();
      } else {
        setMessage({
          ok: true,
          text: `Stored ${data.inserted} new finding${data.inserted === 1 ? "" : "s"}${
            data.skipped ? ` · ${data.skipped} skipped` : ""
          }.`,
        });
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: "Network error — try again." });
    } finally {
      setLoading(false);
    }
  }

  const toggleBtn = (value: JobType, label: string) => (
    <button
      type="button"
      onClick={() => setJobType(value)}
      aria-pressed={jobType === value}
      className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
        jobType === value
          ? "bg-teal-500 text-charcoal-950"
          : "bg-charcoal-800 text-ink-muted hover:bg-charcoal-700 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium text-ink-muted">Job type</span>
        {toggleBtn("trend", "Trend")}
        {toggleBtn("business_opportunity", "Business Opportunity")}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-muted">Research query</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
            }}
            placeholder={placeholder}
            maxLength={300}
            className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink placeholder:text-ink-dim"
          />
        </label>

        {brands.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-muted">
              Brand <span className="text-ink-dim">(optional)</span>
            </span>
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink sm:w-56"
            >
              <option value="">— No brand —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={loading || !query.trim()}
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {loading ? "Researching the live web…" : "Run research"}
        </button>
        {message && (
          <p className={`text-sm ${message.ok ? "text-teal-300" : "text-red-300"}`}>{message.text}</p>
        )}
      </div>

      <p className="text-[11px] text-ink-dim">
        Agent CSI searches the live web and stores only findings backed by a real source URL. If
        nothing verifiable comes back, it stores nothing — it never fabricates to fill the feed.
      </p>
    </div>
  );
}
