"use client";

import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { TaskStatus } from "@/types/database";
import { TASK_STATUS_LABELS, statusPillClasses } from "@/lib/tasks/display";
import {
  submitCompanyDailyReport,
  type DailyReportState,
} from "@/app/(dashboard)/daily-report/actions";

// DailyReportLauncher — the company-wide Daily Report, filed from every role home.
//
// A big tap target opens a modal where the filer records the outputs they
// completed, any blockers, an optional summary, and TAGS the tasks the report
// confirms. Submitting confirms those tasks — the single input to the scorecard's
// Efficiency. Evidence links attach through the same submit. Mirrors the mobile
// QuickEntryLauncher pattern (modal + honest states); no fabricated numbers.

export type TaggableTask = {
  id: string;
  title: string;
  status: TaskStatus;
  due_date: string | null;
};

type Existing = {
  outputs: string | null;
  summary: string | null;
  blockers: string | null;
  submitted: boolean;
  taggedIds: string[];
};

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500";
const labelCls = "block text-[11px] font-medium uppercase tracking-wide text-ink-muted";

function SubmitButton({ resubmit }: { resubmit: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Submitting…" : resubmit ? "Resubmit report" : "Submit Daily Report"}
    </button>
  );
}

export function DailyReportLauncher({
  today,
  tasks,
  existing,
}: {
  today: string;
  tasks: TaggableTask[];
  existing: Existing | null;
}) {
  const [open, setOpen] = useState(false);
  const initial: DailyReportState = { ok: false };
  const [state, action] = useFormState(submitCompanyDailyReport, initial);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (state.ok) setDone(true);
  }, [state]);

  const alreadySubmitted = existing?.submitted ?? false;
  const tagged = new Set(existing?.taggedIds ?? []);

  return (
    <section className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 shadow-elevate">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Daily Report</h2>
          <p className="text-xs text-ink-muted">
            {alreadySubmitted
              ? `Filed for ${today}. The tasks you tagged are confirmed — resubmit to update.`
              : "File your report for today — the outputs you completed, blockers, and the tasks it confirms."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setDone(false);
            setOpen((v) => !v);
          }}
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
        >
          {open ? "Close" : alreadySubmitted ? "Update report" : "File Daily Report"}
        </button>
      </div>

      {open && (
        <form action={action} className="mt-4 space-y-4 border-t border-charcoal-700/60 pt-4">
          <input type="hidden" name="work_date" value={today} />

          <label className={labelCls}>
            Outputs completed
            <textarea
              name="outputs"
              rows={3}
              required
              defaultValue={existing?.outputs ?? ""}
              placeholder="The concrete outputs you finished today — one per line"
              className={inputCls}
            />
          </label>

          <div>
            <p className={labelCls}>Tasks this report confirms</p>
            <p className="mt-1 text-xs text-ink-muted">
              Tick the tasks you worked to completion. Submitting confirms them — this is what the
              scorecard reads as done.
            </p>
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-md border border-charcoal-700/60 bg-charcoal-950 p-2">
              {tasks.length === 0 ? (
                <p className="p-2 text-xs text-ink-muted">No tasks assigned to you yet.</p>
              ) : (
                tasks.map((t) => (
                  <label
                    key={t.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-ink hover:bg-charcoal-800"
                  >
                    <input
                      type="checkbox"
                      name="task_ids"
                      value={t.id}
                      defaultChecked={tagged.has(t.id)}
                      className="h-4 w-4 rounded border-charcoal-600 bg-charcoal-900 text-teal-500"
                    />
                    <span className="flex-1 truncate">{t.title}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${statusPillClasses(t.status)}`}>
                      {TASK_STATUS_LABELS[t.status]}
                    </span>
                    {t.due_date && (
                      <span className="font-mono text-[10px] text-ink-muted">due {t.due_date}</span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>

          <label className={labelCls}>
            Blockers <span className="normal-case text-ink-dim">(optional)</span>
            <textarea
              name="blockers"
              rows={2}
              defaultValue={existing?.blockers ?? ""}
              placeholder="Anything holding you up"
              className={inputCls}
            />
          </label>

          <label className={labelCls}>
            Summary <span className="normal-case text-ink-dim">(optional)</span>
            <textarea
              name="summary"
              rows={2}
              defaultValue={existing?.summary ?? ""}
              placeholder="Context worth flagging — next steps, notes"
              className={inputCls}
            />
          </label>

          <label className={labelCls}>
            Evidence links <span className="normal-case text-ink-dim">(optional, one per line)</span>
            <textarea
              name="evidence_links"
              rows={2}
              placeholder="https://… — links to the proof of your outputs"
              className={inputCls}
            />
          </label>

          {state.error && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {state.error}
            </p>
          )}
          {done && (
            <p className="rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-sm text-teal-300">
              Daily Report submitted — tagged tasks are confirmed and now count toward Efficiency.
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-ink-muted">
              Filed for {today}. Everyone files a daily report.
            </p>
            <SubmitButton resubmit={alreadySubmitted} />
          </div>
        </form>
      )}
    </section>
  );
}
