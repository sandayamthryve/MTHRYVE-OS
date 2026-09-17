"use client";

import { useEffect, useRef, useState } from "react";
// React 18 / Next 14: form state is react-dom's useFormState.
import { useFormState, useFormStatus } from "react-dom";
import {
  cancelLeaveRequest,
  decideLeaveRequest,
  fileLeaveRequest,
  type LeaveState,
} from "@/app/(dashboard)/leave/actions";
import { LEAVE_TYPES } from "@/lib/hr/leave-types";

const IDLE: LeaveState = { ok: true };

function Pending({ children, className }: { children: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${className} disabled:opacity-50`}>
      {pending ? "…" : children}
    </button>
  );
}

// ── File a request ──────────────────────────────────────────────────────────
export function NewLeaveRequest() {
  const [state, action] = useFormState<LeaveState, FormData>(fileLeaveRequest, IDLE);
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Close and clear only once it is actually filed; a failed submit keeps the
  // form open with what was typed still in it.
  useEffect(() => {
    if (state.ok && !state.error && open) {
      formRef.current?.reset();
      setOpen(false);
    }
    // `open` is intentionally not a dependency: reacting to it would close the
    // form the moment it is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] px-4 py-2 text-sm font-extrabold text-[#04120c] transition hover:brightness-110"
      >
        + New request
      </button>
    );
  }

  return (
    <form ref={formRef} action={action} className="rounded-xl border border-charcoal-700 bg-charcoal-900 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-ink-muted">
          Leave type
          <select
            name="leave_type"
            required
            defaultValue=""
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
          >
            <option value="" disabled>Choose…</option>
            {LEAVE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs font-semibold text-ink-muted">
            Start
            <input type="date" name="start_date" required className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink" />
          </label>
          <label className="text-xs font-semibold text-ink-muted">
            End
            <input type="date" name="end_date" required className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink" />
          </label>
        </div>
      </div>
      <label className="mt-3 block text-xs font-semibold text-ink-muted">
        Reason
        <textarea name="reason" required rows={2} maxLength={1000} className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink" />
      </label>

      {state.error && <p role="alert" className="mt-2 text-xs font-semibold text-red-400">{state.error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <Pending className="rounded-lg bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] px-4 py-2 text-sm font-extrabold text-[#04120c]">
          File request
        </Pending>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-charcoal-700 px-4 py-2 text-sm font-semibold text-ink-muted hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Decide someone else's ───────────────────────────────────────────────────
export function DecideLeave({ requestId }: { requestId: string }) {
  const [state, action] = useFormState<LeaveState, FormData>(decideLeaveRequest, IDLE);
  const [rejecting, setRejecting] = useState(false);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="request_id" value={requestId} />
      {rejecting ? (
        <>
          {/* A rejection needs a reason, so the input appears before the commit
              rather than the action failing after it. */}
          <input
            name="decision_note"
            required
            minLength={3}
            maxLength={500}
            placeholder="Reason for rejecting"
            className="w-48 rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-xs text-ink"
          />
          <button name="decision" value="rejected" type="submit" className="rounded-md bg-red-500/90 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500">
            Confirm reject
          </button>
          <button type="button" onClick={() => setRejecting(false)} className="text-xs font-semibold text-ink-muted hover:text-ink">
            Back
          </button>
        </>
      ) : (
        <>
          <button name="decision" value="approved" type="submit" className="rounded-md bg-teal-400 px-3 py-1.5 text-xs font-bold text-charcoal-950 hover:bg-teal-300">
            Approve
          </button>
          <button type="button" onClick={() => setRejecting(true)} className="rounded-md border border-charcoal-700 px-3 py-1.5 text-xs font-bold text-ink-muted hover:text-ink">
            Reject
          </button>
        </>
      )}
      {state.error && <span role="alert" className="text-xs text-red-400">{state.error}</span>}
    </form>
  );
}

// ── Withdraw your own ───────────────────────────────────────────────────────
export function CancelLeave({ requestId }: { requestId: string }) {
  const [state, action] = useFormState<LeaveState, FormData>(cancelLeaveRequest, IDLE);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="request_id" value={requestId} />
      <Pending className="rounded-md border border-charcoal-700 px-3 py-1.5 text-xs font-bold text-ink-muted hover:text-ink">
        Withdraw
      </Pending>
      {state.error && <span role="alert" className="text-xs text-red-400">{state.error}</span>}
    </form>
  );
}
