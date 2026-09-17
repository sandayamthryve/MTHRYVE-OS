"use client";

import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { submitDailyReport, type ReportFormState } from "@/app/(dashboard)/attendance/actions";

// Submit Daily Report — the deliverables gate on the workday. A contractor logs
// what they completed; the server validates it's non-empty, files a `reports`
// row, and stamps report_submitted / report_id on the day's attendance so the
// workday reads as genuinely complete (not just logged-in).

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500";
const labelCls = "block text-[11px] font-medium uppercase tracking-wide text-ink-muted";

function SubmitButton({ alreadyDone }: { alreadyDone: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Submitting…" : alreadyDone ? "Resubmit report" : "Submit Daily Report"}
    </button>
  );
}

export function SubmitReportForm({
  today,
  alreadySubmitted,
}: {
  today: string;
  alreadySubmitted: boolean;
}) {
  const initial: ReportFormState = { ok: false };
  const [state, action] = useFormState(submitDailyReport, initial);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (state.ok) setDone(true);
  }, [state]);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="work_date" value={today} />
      <label className={labelCls}>
        Deliverables completed
        <textarea
          name="deliverables"
          rows={3}
          required
          placeholder="One per line — the concrete outputs you finished today"
          className={inputCls}
        />
      </label>
      <label className={labelCls}>
        Summary <span className="normal-case text-ink-dim">(optional)</span>
        <textarea
          name="summary"
          rows={2}
          placeholder="Anything worth flagging — blockers, context, next steps"
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
          Daily Report submitted — your workday is marked complete.
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">
          {alreadySubmitted
            ? "A report is already on file for today. Resubmitting replaces it."
            : "Required to complete the workday."}
        </p>
        <SubmitButton alreadyDone={alreadySubmitted} />
      </div>
    </form>
  );
}
