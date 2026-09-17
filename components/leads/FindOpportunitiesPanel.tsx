"use client";

// The "Find Opportunities" panel — makes the Opportunity Engine usable by hand
// with no paid lead source. Paste or upload a prospect list, set optional ranking
// criteria, and submit; the engine ranks each prospect (tier + score + reason)
// and the gateway stages the HOT ones as PENDING action_requests. Nothing here
// reaches a prospect — the panel only ranks and links to the approval queue.
//
// It's a thin island over the findOpportunities server action (passed in as a
// prop so the action stays co-located with the Leads page). Results and any
// config / engine error surface inline via useFormState.

import { useFormState, useFormStatus } from "react-dom";
import { Badge, type BadgeTone } from "@/components/ui";
import { OPPORTUNITY_CSV_COLUMNS } from "@/lib/opportunities/csv";
import type { OpportunityTier } from "@/lib/opportunities/engine";
import type { FindOpportunitiesState, FindOppError } from "@/app/(dashboard)/leads/find-opportunities";

const inputCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

const TIER_TONE: Record<OpportunityTier, BadgeTone> = {
  HOT: "red",
  WARM: "amber",
  COLD: "muted",
};

function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

// Turn a not-ready / engine error into a specific, fixable line.
function errorMessage(err: FindOppError): string {
  switch (err.kind) {
    case "no_candidates":
      return "No prospects found in that list. Add at least a name column, then try again.";
    case "engine":
      return `Couldn't rank the list: ${err.message}`;
    case "not_ready":
      switch (err.reason) {
        case "missing":
          return "The Opportunity Engine isn't registered yet. A leader can add it under automation settings (key: opportunity_engine).";
        case "disabled":
          return "The Opportunity Engine is registered but turned off. A leader can enable it in the automation registry.";
        case "no_url":
        case "placeholder":
          return "The Opportunity Engine has no webhook URL set yet. A leader can set it in the automation registry (key: opportunity_engine).";
      }
  }
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Ranking…" : "Find Opportunities"}
    </button>
  );
}

function StagingSummary({ state }: { state: FindOpportunitiesState }) {
  const s = state.stage;
  if (!s) return null;
  if (s.hot === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No prospects ranked HOT this run — nothing staged. WARM / COLD results are shown below for your review.
      </p>
    );
  }
  const parts: string[] = [];
  if (s.staged > 0)
    parts.push(`${s.staged} HOT ${s.staged === 1 ? "opportunity" : "opportunities"} staged`);
  if (s.alreadyStaged > 0) parts.push(`${s.alreadyStaged} already staged by the engine`);
  if (s.skipped > 0) parts.push(`${s.skipped} already had an open request`);
  return (
    <p className="text-sm text-ink">
      {parts.join(" · ")}.{" "}
      <a href="/approvals" className="font-semibold text-teal-300 underline hover:text-ink">
        Review in the approval queue →
      </a>
    </p>
  );
}

function ResultsTable({ results }: { results: FindOpportunitiesState["results"] }) {
  if (results.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-charcoal-700/60 bg-charcoal-900">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-charcoal-700/60 text-left font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            <th className="p-3 font-normal">Prospect</th>
            <th className="p-3 font-normal">Tier</th>
            <th className="p-3 font-normal">Score</th>
            <th className="p-3 font-normal">Why</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => (
            <tr key={`${r.name}-${i}`} className="border-b border-charcoal-700/60 align-top">
              <td className="p-3">
                <span className="text-ink">{r.name}</span>
                {r.candidate?.category ? (
                  <span className="text-ink-muted"> · {r.candidate.category}</span>
                ) : null}
                {r.candidate?.monthly_revenue != null ? (
                  <div className="mt-0.5 font-mono text-xs text-ink-muted">
                    {peso(Number(r.candidate.monthly_revenue))}/mo
                  </div>
                ) : null}
              </td>
              <td className="p-3">
                <Badge tone={TIER_TONE[r.tier]}>{r.tier}</Badge>
              </td>
              <td className="p-3 font-mono text-ink">{r.score}</td>
              <td className="p-3 text-ink-muted">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FindOpportunitiesPanel({
  action,
}: {
  action: (
    prev: FindOpportunitiesState,
    formData: FormData
  ) => Promise<FindOpportunitiesState>;
}) {
  const initial: FindOpportunitiesState = {
    ok: false,
    results: [],
    parsed: 0,
    skippedRows: [],
    stage: null,
    error: null,
  };
  const [state, formAction] = useFormState(action, initial);

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-3">
        <textarea
          name="candidates"
          rows={5}
          placeholder="Paste your prospect list here (CSV), or choose a .csv file below…"
          className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 font-mono text-xs text-ink"
        />

        {/* Optional criteria to steer the ranking. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            name="focus_category"
            placeholder="Focus category (optional, e.g. beauty)"
            className={inputCls}
          />
          <input
            name="min_monthly_revenue"
            inputMode="numeric"
            placeholder="Min monthly revenue (optional)"
            className={inputCls}
          />
        </div>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className="mb-1 w-full text-xs text-ink-muted">
            Prioritize prospects that…
          </legend>
          {[
            ["prioritize_sells_online", "sell online"],
            ["prioritize_has_tiktok_shop", "have a TikTok Shop"],
            ["prioritize_gmv_declining", "have declining GMV"],
            ["prioritize_runs_ads", "run ads"],
          ].map(([name, label]) => (
            <label key={name} className="flex items-center gap-1.5 text-xs text-ink">
              <input type="checkbox" name={name} className="accent-teal-500" />
              {label}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            className="w-full max-w-full text-xs text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-charcoal-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal-300 hover:file:bg-charcoal-700"
          />
          <SubmitButton />
        </div>
        <p className="text-xs text-ink-muted">
          columns: {OPPORTUNITY_CSV_COLUMNS.join(", ")}. Signals accept yes/no. Nothing is sent to any
          prospect — this only ranks and stages HOT ones for your approval.
        </p>
      </form>

      {/* Outcome */}
      {state.error && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
          {errorMessage(state.error)}
        </p>
      )}

      {state.ok && (
        <div className="space-y-3">
          <StagingSummary state={state} />
          {state.skippedRows.length > 0 && (
            <p className="text-xs text-ink-muted">
              {state.skippedRows.length} row{state.skippedRows.length === 1 ? "" : "s"} skipped:{" "}
              {state.skippedRows.join(" / ")}
            </p>
          )}
          {state.results.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Ranked {state.parsed} prospects — the engine returned no results.
            </p>
          ) : (
            <ResultsTable results={state.results} />
          )}
        </div>
      )}
    </div>
  );
}
