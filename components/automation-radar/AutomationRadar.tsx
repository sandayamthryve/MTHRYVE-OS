import { SectionCard, Badge } from "@/components/ui";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  listPatterns,
  capabilityNames,
  assigneeNames,
} from "@/lib/automation-radar/data";
import {
  AUTOMATABILITY_META,
  PATTERN_STATUS_META,
  monthlyTimeSaved,
  type RepetitionPattern,
} from "@/lib/automation-radar/types";
import { RadarRowActions } from "./RadarRowActions";

// <AutomationRadar department={dept|null} /> — the ONE reusable Automation Radar
// surface. ONE detector writes repetition_patterns.department; this component
// renders a FILTERED, RLS-scoped view:
//   • department="Creative" → only that team's patterns (embedded in each
//     department tab; team members can propose/dismiss their own).
//   • department={null}     → the org-wide leadership roll-up, all departments.
// Ranked by est monthly time cost (biggest wins first). Detection is read-only and
// nothing here executes — "Propose" only files a pending action_request.

type Shim = { from: (t: string) => any };

export async function AutomationRadar({
  department = null,
  title,
  className = "",
}: {
  department?: string | null;
  title?: string;
  className?: string;
}) {
  const db = createServerSupabaseClient() as unknown as Shim;
  const patterns = await listPatterns(db, { department });

  const capIds = patterns.map((p) => p.matched_capability_id).filter((x): x is string => !!x);
  const assigneeIds = patterns.map((p) => p.assignee_id).filter((x): x is string => !!x);
  const [capMap, userMap] = await Promise.all([
    capabilityNames(db, capIds),
    assigneeNames(db, assigneeIds),
  ]);

  const heading = title ?? (department ? "Automation Radar" : "Automation Radar · Org-wide");
  const showDepartment = !department;

  // Honest headline: total recoverable minutes/month across the shown patterns.
  const totalCost = patterns.reduce((a, p) => a + (p.time_cost_per_month ?? 0), 0);

  return (
    <SectionCard
      title={heading}
      icon="🛰️"
      className={className}
      action={
        patterns.length > 0 ? (
          <span className="font-mono text-[11px] text-ink-muted">
            {patterns.length} pattern{patterns.length === 1 ? "" : "s"} ·{" "}
            {monthlyTimeSaved({ time_cost_per_month: totalCost })}/mo
          </span>
        ) : null
      }
    >
      {patterns.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Not enough signal yet — the detector needs at least three roughly regular
          repetitions of the same work before it surfaces a pattern
          {department ? ` for ${department}` : ""}. Nothing fabricated.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {patterns.map((p) => (
            <PatternRow
              key={p.id}
              pattern={p}
              showDepartment={showDepartment}
              capabilityName={p.matched_capability_id ? capMap.get(p.matched_capability_id) ?? null : null}
              assigneeName={p.assignee_id ? userMap.get(p.assignee_id) ?? null : null}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function PatternRow({
  pattern: p,
  showDepartment,
  capabilityName,
  assigneeName,
}: {
  pattern: RepetitionPattern;
  showDepartment: boolean;
  capabilityName: string | null;
  assigneeName: string | null;
}) {
  const auto = p.automatability ? AUTOMATABILITY_META[p.automatability] : null;
  const st = PATTERN_STATUS_META[p.status];

  return (
    <li className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{p.normalized_title || "—"}</span>
            {auto && (
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${auto.chip}`}
                title={auto.blurb}
              >
                {auto.label}
              </span>
            )}
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${st.chip}`}
            >
              {st.label}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
            <span>{p.occurrences}× occurrences</span>
            <span>·</span>
            <span>{p.cadence ?? "irregular"}</span>
            <span>·</span>
            <span className="text-teal-300">{monthlyTimeSaved(p)}/mo saved</span>
            {showDepartment && p.department && (
              <>
                <span>·</span>
                <span className="text-ink-dim">{p.department}</span>
              </>
            )}
            {assigneeName && (
              <>
                <span>·</span>
                <span className="text-ink-dim">{assigneeName}</span>
              </>
            )}
          </div>

          {p.suggested_path && (
            <p className="mt-1.5 text-xs text-ink-muted">
              <span className="text-ink-dim">Suggested: </span>
              {p.suggested_path}
            </p>
          )}

          {(capabilityName || p.matched_workflow) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {capabilityName && (
                <Badge tone="teal">Capability · {capabilityName}</Badge>
              )}
              {p.matched_workflow && (
                <Badge tone="violet">Workflow · {p.matched_workflow}</Badge>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0">
          <RadarRowActions
            patternId={p.id}
            status={p.status}
            automatability={p.automatability}
          />
        </div>
      </div>
    </li>
  );
}
