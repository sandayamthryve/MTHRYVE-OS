"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { fileRequest, type RequestFormState } from "@/app/(dashboard)/attendance/actions";
import { LEAVE_LABELS, LEAVE_TYPES, REQUEST_LABELS, REQUEST_TYPES, type RequestType } from "@/lib/hr/requests";

// The online request forms. One control set backs all six types; changing the
// type reveals only that type's fields. Anyone can file their OWN request — it
// posts to daily_log_requests as `pending` for a supervisor / leadership
// decision. Reuses the app's form styling so it reads like the rest of HR.

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500";
const labelCls = "block text-[11px] font-medium uppercase tracking-wide text-ink-muted";

function FileButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Filing…" : "File request"}
    </button>
  );
}

export function NewRequestForm({ today }: { today: string }) {
  const [type, setType] = useState<RequestType>("leave");
  const initial: RequestFormState = { ok: false };
  const [state, action] = useFormState(fileRequest, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setType("leave");
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 4000);
      return () => clearTimeout(t);
    }
  }, [state]);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelCls}>
          Request type
          <select
            name="request_type"
            value={type}
            onChange={(e) => setType(e.target.value as RequestType)}
            className={inputCls}
          >
            {REQUEST_TYPES.map((t) => (
              <option key={t} value={t}>
                {REQUEST_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {type === "leave" && (
          <label className={labelCls}>
            Leave type
            <select name="leave_type" className={inputCls} defaultValue="vacation">
              {LEAVE_TYPES.map((l) => (
                <option key={l} value={l}>
                  {LEAVE_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Work date — every type carries one (Leave date, holiday worked, etc.) */}
        <label className={labelCls}>
          {type === "holiday_duty" ? "Holiday worked" : "Work date"}
          <input name="work_date" type="date" defaultValue={today} className={inputCls} />
        </label>

        {type === "overtime" && (
          <>
            <label className={labelCls}>
              Start time
              <input name="start_time" type="time" className={inputCls} />
            </label>
            <label className={labelCls}>
              End time
              <input name="end_time" type="time" className={inputCls} />
            </label>
            <label className={labelCls}>
              Total hours
              <input name="total_hours" type="number" step="0.25" min="0" className={inputCls} />
            </label>
          </>
        )}

        {type === "undertime" && (
          <label className={labelCls}>
            Time out
            <input name="time_out" type="time" className={inputCls} />
          </label>
        )}

        {type === "ooo" && (
          <>
            <label className={labelCls}>
              Duration
              <input name="duration" placeholder="e.g. 2 hours, half day" className={inputCls} />
            </label>
            <label className={labelCls}>
              Expected return
              <input name="expected_return" type="date" className={inputCls} />
            </label>
            <label className={`${labelCls} sm:col-span-2`}>
              Purpose
              <input name="purpose" placeholder="Reason for being out of office" className={inputCls} />
            </label>
          </>
        )}

        {(type === "rest_day_duty" || type === "holiday_duty") && (
          <label className={labelCls}>
            {type === "holiday_duty" ? "Hours rendered" : "Total hours"}
            <input name="total_hours" type="number" step="0.25" min="0" className={inputCls} />
          </label>
        )}

        {(type === "leave" ||
          type === "overtime" ||
          type === "undertime" ||
          type === "rest_day_duty") && (
          <label className={`${labelCls} sm:col-span-2`}>
            Reason
            <input name="reason" placeholder="Optional context for the approver" className={inputCls} />
          </label>
        )}

        {type === "holiday_duty" && (
          <label className={`${labelCls} sm:col-span-2`}>
            Remarks
            <input name="remarks" placeholder="Optional remarks" className={inputCls} />
          </label>
        )}
      </div>

      {state.error && (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}
      {flash && (
        <p className="rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-sm text-teal-300">
          Request filed — it's now pending approval.
        </p>
      )}

      <div className="flex justify-end">
        <FileButton />
      </div>
    </form>
  );
}
