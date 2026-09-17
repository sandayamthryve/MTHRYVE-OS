"use client";

import { useMemo, useState } from "react";
import {
  CAPABILITY_STATUSES,
  STATUS_META,
  computeCoverage,
  groupByDomain,
  canRunMission,
  type Capability,
  type CapabilityStatus,
} from "@/lib/capabilities/types";
import type { RegistryOption } from "@/lib/capabilities/data";
import { CapabilityDetailModal } from "@/components/vesper/CapabilityDetailModal";
import { MissionTaskModal } from "@/components/vesper/MissionTaskModal";

type UserOption = { id: string; name: string };

// Vesper Core registry — client surface. Holds the filter/search state, renders
// the weighted-coverage headline, the status/domain/text filters, and the 16
// domains as coverage-scored groups of status-colored capability chips. Clicking
// a chip opens its detail (and, for leadership, edit); live/partial chips can be
// turned straight into mission tasks. All data is passed in from the RLS-scoped
// server page — this component only shapes + filters it.
export function CapabilityRegistry({
  capabilities,
  canEdit,
  skillOptions,
  workflowOptions,
  users,
}: {
  capabilities: Capability[];
  canEdit: boolean;
  skillOptions: RegistryOption[];
  workflowOptions: RegistryOption[];
  users: UserOption[];
}) {
  const [statusFilter, setStatusFilter] = useState<Set<CapabilityStatus>>(
    () => new Set(CAPABILITY_STATUSES)
  );
  const [domainFilter, setDomainFilter] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Capability | null>(null);
  const [mission, setMission] = useState<Capability | null>(null);

  // Overall weighted coverage is computed over EVERYTHING, not the filtered view —
  // the headline score is the org's real number regardless of what's on screen.
  const overall = useMemo(() => computeCoverage(capabilities), [capabilities]);

  // The domain list for the dropdown (stable, by number).
  const domainOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const c of capabilities) if (!seen.has(c.domain_no)) seen.set(c.domain_no, c.domain);
    return Array.from(seen.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([no, name]) => ({ no, name }));
  }, [capabilities]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    return capabilities.filter((c) => {
      if (!statusFilter.has(c.status)) return false;
      if (domainFilter !== "all" && c.domain_no !== domainFilter) return false;
      if (q) {
        const hay = `${c.name} ${c.domain} ${c.outputs.join(" ")} ${c.notes ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [capabilities, statusFilter, domainFilter, q]);

  const groups = useMemo(() => groupByDomain(filtered), [filtered]);

  const toggleStatus = (s: CapabilityStatus) =>
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      // Never let all filters off — that's just an empty page; reset to all.
      return next.size === 0 ? new Set(CAPABILITY_STATUSES) : next;
    });

  const resetFilters = () => {
    setStatusFilter(new Set(CAPABILITY_STATUSES));
    setDomainFilter("all");
    setSearch("");
  };

  const filtersActive =
    statusFilter.size !== CAPABILITY_STATUSES.length || domainFilter !== "all" || q.length > 0;

  return (
    <div className="space-y-6">
      {/* Overall coverage headline */}
      <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-dim">Overall coverage</p>
            <p className="mt-1 font-display text-4xl font-semibold text-ink">
              {overall.percent}
              <span className="ml-1 text-2xl text-ink-muted">%</span>
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              weighted across {overall.total} capabilities · live = 1, partial = 0.5
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {CAPABILITY_STATUSES.map((s) => (
              <div key={s} className="min-w-[4.5rem]">
                <div className="flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 rounded-full ${STATUS_META[s].fill}`} />
                  <span className="text-xs text-ink-muted">{STATUS_META[s].label}</span>
                </div>
                <p className="mt-0.5 font-mono text-lg text-ink">{overall.counts[s]}</p>
              </div>
            ))}
          </div>
        </div>
        <CoverageBar coverage={overall} className="mt-4 h-2.5" />
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {CAPABILITY_STATUSES.map((s) => {
            const on = statusFilter.has(s);
            const meta = STATUS_META[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                aria-pressed={on}
                title={meta.blurb}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${
                  on ? meta.chip : "border-charcoal-700 bg-charcoal-900 text-ink-dim hover:text-ink-muted"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${on ? meta.fill : "bg-charcoal-700"}`} />
                {meta.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={domainFilter === "all" ? "all" : String(domainFilter)}
            onChange={(e) => setDomainFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-1.5 text-sm text-ink focus:border-teal-500"
          >
            <option value="all">All domains</option>
            {domainOptions.map((d) => (
              <option key={d.no} value={d.no}>
                {d.no}. {d.name}
              </option>
            ))}
          </select>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search capabilities…"
            className="w-48 rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500 sm:w-60"
          />
          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-md px-2.5 py-1.5 text-xs text-ink-muted hover:text-ink"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-ink-dim">
        Showing {filtered.length} of {capabilities.length} capabilities
        {filtersActive ? " (filtered)" : ""}.
      </p>

      {/* Domain groups */}
      {groups.length === 0 ? (
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-8 text-center text-sm text-ink-muted">
          No capabilities match these filters.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section
              key={g.domain_no}
              className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-baseline gap-2 text-sm font-semibold text-ink">
                  <span className="font-mono text-xs text-ink-dim">
                    {String(g.domain_no).padStart(2, "0")}
                  </span>
                  {g.domain}
                  <span className="text-xs font-normal text-ink-dim">
                    ({g.capabilities.length})
                  </span>
                </h2>
                <div className="flex items-center gap-2">
                  <CoverageBar coverage={g.coverage} className="h-1.5 w-24 sm:w-32" />
                  <span className="font-mono text-xs text-ink-muted">{g.coverage.percent}%</span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {g.capabilities.map((c) => (
                  <CapabilityChip
                    key={c.id}
                    capability={c}
                    onOpen={() => setDetail(c)}
                    onMission={canRunMission(c.status) ? () => setMission(c) : undefined}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Modals */}
      {detail && (
        <CapabilityDetailModal
          capability={detail}
          canEdit={canEdit}
          skillOptions={skillOptions}
          workflowOptions={workflowOptions}
          onClose={() => setDetail(null)}
          onCreateMission={
            canRunMission(detail.status)
              ? () => {
                  setMission(detail);
                  setDetail(null);
                }
              : undefined
          }
        />
      )}
      {mission && (
        <MissionTaskModal capability={mission} users={users} onClose={() => setMission(null)} />
      )}
    </div>
  );
}

// A weighted-coverage bar: green (live) + amber (partial) segments over a muted
// track. planned/vendor contribute no fill, matching the coverage math.
function CoverageBar({
  coverage,
  className = "",
}: {
  coverage: ReturnType<typeof computeCoverage>;
  className?: string;
}) {
  const total = coverage.total || 1;
  const livePct = (coverage.counts.live / total) * 100;
  const partialPct = (coverage.counts.partial / total) * 100;
  return (
    <div className={`flex overflow-hidden rounded-full bg-charcoal-800 ${className}`}>
      <div className="bg-green-500" style={{ width: `${livePct}%` }} />
      <div className="bg-amber-500" style={{ width: `${partialPct}%` }} />
    </div>
  );
}

// One capability as a status-colored pill. The name opens the detail/edit modal;
// live/partial pills carry a compact "＋" that jumps straight to mission tasks.
function CapabilityChip({
  capability,
  onOpen,
  onMission,
}: {
  capability: Capability;
  onOpen: () => void;
  onMission?: () => void;
}) {
  const meta = STATUS_META[capability.status];
  return (
    <span
      className={`group inline-flex items-center gap-1 rounded-full border ${meta.chip} pl-2.5 pr-1 text-xs`}
    >
      <button
        type="button"
        onClick={onOpen}
        title={`${capability.name} — ${meta.label}`}
        className="flex items-center gap-1.5 py-1 text-left hover:underline"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${meta.fill}`} />
        <span className="max-w-[16rem] truncate">{capability.name}</span>
      </button>
      {onMission && (
        <button
          type="button"
          onClick={onMission}
          title="Create mission tasks"
          aria-label={`Create mission tasks for ${capability.name}`}
          className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-current/70 hover:bg-black/20 hover:text-current"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
    </span>
  );
}
