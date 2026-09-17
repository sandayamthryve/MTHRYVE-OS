"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HealthDot } from "@/lib/metrics/types";
import { HEALTH_COLOR, HEALTH_LABEL } from "@/lib/metrics/health";
import {
  runCouncilMember,
  runFullCouncil,
  type CouncilRunResult,
} from "@/app/(dashboard)/council/actions";

// The Executive AI Council board. One card per roster member — name, title,
// domain, a live status light aggregated from its compartments' health, and a
// "Run [member]" trigger that files a domain brief into the approval queue.
// Unmapped officers (cto/bi/hr) render "scope pending" with no run. Leadership
// additionally gets "Run Full Council", which runs every mapped member in turn.
// Purely a UX shell over the server actions — nothing auto-executes.

export interface BoardMember {
  key: string;
  name: string;
  title: string;
  domain: string;
  extraScope: string | null;
  mapped: boolean;
  dot: HealthDot;
  grounded: number;
  total: number;
  latestBriefId: string | null;
  latestBriefStatus: string | null;
}

function StatusLight({ dot, mapped }: { dot: HealthDot; mapped: boolean }) {
  const color = mapped && dot ? HEALTH_COLOR[dot] : "bg-ink-dim";
  const label = !mapped ? "Scope pending" : dot ? HEALTH_LABEL[dot] : "No data yet";
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-full ${color} ${mapped && dot ? "shadow-glow" : ""}`} />
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</span>
    </span>
  );
}

function briefHref(id: string, status: string | null): string {
  const base = status && status !== "pending" ? "/approvals?tab=history" : "/approvals";
  return `${base}#req-${id}`;
}

function MemberCard({ member, canRun }: { member: BoardMember; canRun: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CouncilRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await runCouncilMember(member.key);
        setResult(res);
        if (res.ok && res.created > 0) router.refresh();
      } catch {
        setError("Run failed. Please try again.");
      }
    });
  }

  return (
    <li className="flex flex-col rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{member.name}</p>
          <p className="text-xs text-ink-muted">{member.title}</p>
        </div>
        <StatusLight dot={member.dot} mapped={member.mapped} />
      </div>

      <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-ink-dim">{member.domain}</p>

      {member.mapped ? (
        <p className="mt-1 text-[11px] text-ink-muted">
          {member.grounded}/{member.total} metrics grounded
        </p>
      ) : (
        <p className="mt-1 text-[11px] italic text-ink-dim">
          Scope pending — compartments not wired yet{member.extraScope ? ` · ${member.extraScope}` : ""}.
        </p>
      )}

      <div className="mt-3 flex flex-1 flex-col justify-end gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          {member.mapped && canRun && (
            <button
              onClick={run}
              disabled={pending}
              className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
            >
              {pending ? "Reading & reasoning…" : `Run ${member.name}`}
            </button>
          )}
          {member.latestBriefId && (
            <a
              href={briefHref(member.latestBriefId, member.latestBriefStatus)}
              className="text-xs text-ink-muted underline hover:text-teal-400"
            >
              Latest brief →
            </a>
          )}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {result && (
          <p className="text-xs text-ink-muted">
            {!result.ok ? (
              <span className="text-red-400">{result.error ?? "Something went wrong."}</span>
            ) : result.thin ? (
              <>No metric in scope has an entry yet — nothing to reason over.</>
            ) : result.created > 0 ? (
              <>
                Brief filed to the{" "}
                <a href="/approvals" className="underline hover:text-ink">
                  approval queue
                </a>{" "}
                — grounded on {result.grounded}/{result.total} real metrics.
              </>
            ) : (
              <>Nothing drafted.</>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

export function CouncilBoard({
  members,
  canRun,
  canRunFull,
}: {
  members: BoardMember[];
  canRun: boolean;
  canRunFull: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mappedCount = members.filter((m) => m.mapped).length;

  function runAll() {
    setError(null);
    setSummary(null);
    startTransition(async () => {
      try {
        const res = await runFullCouncil();
        const failed = res.results.filter((r) => !r.ok);
        const skipped = res.results.filter((r) => r.ok && r.created === 0);
        let msg = `${res.filed} of ${res.results.length} mapped members filed a brief.`;
        if (skipped.length) msg += ` ${skipped.length} had no metric to reason over.`;
        if (failed.length) msg += ` ${failed.length} failed.`;
        setSummary(msg);
        if (res.filed > 0) router.refresh();
      } catch {
        setError("Full-council run failed. Please try again.");
      }
    });
  }

  return (
    <div>
      {canRunFull && mappedCount > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            onClick={runAll}
            disabled={pending}
            className="rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-sm font-semibold text-teal-300 hover:bg-teal-500/20 disabled:opacity-60"
          >
            {pending ? "Running the council…" : "Run Full Council"}
          </button>
          <span className="text-xs text-ink-muted">
            Runs all {mappedCount} mapped members in turn — each files its own brief. Nothing runs on
            its own.
          </span>
          {error && <span className="text-xs text-red-400">{error}</span>}
          {summary && <span className="text-xs text-ink-muted">{summary}</span>}
        </div>
      )}

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((m) => (
          <MemberCard key={m.key} member={m} canRun={canRun} />
        ))}
      </ul>
    </div>
  );
}
