"use client";

import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { updateContractor, type ContractorFormState } from "@/app/(dashboard)/people/actions";
import type { UserRole } from "@/types/database";

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "ceo", label: "CEO" },
  { value: "coo", label: "COO" },
  { value: "department_head", label: "Department Head" },
  { value: "team_member", label: "Team Member" },
];

// "Edit Contractor Information" — the leadership-only editor behind each person
// on the People roster. It writes the master record (professional + personal +,
// for leadership, pay) that every other HR view reads by join. Rendered as a
// modal so the ~16 fields don't bloat the table row. The server action enforces
// the real gate (requireRole + RLS); this component just presents the form.

export type ContractorPerson = {
  id: string;
  full_name: string;
  email: string;
  position: string | null;
  department_id: string | null;
  employment_status: string | null;
  probation_end: string | null;
  date_started: string | null;
  base_pay: number | null;
  commission_structure: string | null;
  compensation_frequency: string | null;
  supervisor_id: string | null;
  team_assignment: string | null;
  contractor_code: string | null;
  role: UserRole;
  mobile: string | null;
  home_address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_number: string | null;
  telegram_username: string | null;
};

type Named = { id: string; name: string };

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500";
const labelCls = "block text-[11px] font-medium uppercase tracking-wide text-ink-muted";

const FREQUENCIES = ["Monthly", "Semi-monthly", "Bi-weekly", "Weekly", "Per project", "Hourly"];

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save changes"}
    </button>
  );
}

export function ContractorEditor({
  person,
  departments,
  supervisors,
  canSeePay,
}: {
  person: ContractorPerson;
  departments: Named[];
  supervisors: Named[];
  canSeePay: boolean;
}) {
  const [open, setOpen] = useState(false);
  const initial: ContractorFormState = { ok: false };
  const [state, formAction] = useFormState(updateContractor, initial);

  // Close on a successful save (the server action has already revalidated).
  useEffect(() => {
    if (state.ok && open) setOpen(false);
  }, [state.ok]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-charcoal-800 px-2.5 py-1 text-xs font-semibold text-teal-300 hover:bg-charcoal-700"
      >
        Edit
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit contractor information for ${person.full_name}`}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-2xl rounded-2xl border border-charcoal-700 bg-charcoal-900 shadow-elevate">
            <div className="flex items-center justify-between border-b border-charcoal-700/70 p-4">
              <div>
                <h2 className="text-sm font-semibold text-ink">Edit Contractor Information</h2>
                <p className="text-xs text-ink-muted">{person.full_name}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-md p-1.5 text-ink-muted hover:bg-charcoal-800 hover:text-ink"
              >
                ✕
              </button>
            </div>

            <form action={formAction} className="max-h-[75vh] overflow-y-auto p-4">
              <input type="hidden" name="id" value={person.id} />

              {/* Professional */}
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-teal-300">
                Professional details
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={labelCls}>
                  Full name
                  <input name="full_name" defaultValue={person.full_name} required className={inputCls} />
                </label>
                <label className={labelCls}>
                  Contractor code
                  <input
                    name="contractor_code"
                    defaultValue={person.contractor_code ?? ""}
                    placeholder="e.g. MTH-0007"
                    className={inputCls}
                  />
                </label>
                <label className={labelCls}>
                  Job title
                  <input
                    name="position"
                    defaultValue={person.position ?? ""}
                    placeholder="e.g. Growth Strategist"
                    className={inputCls}
                  />
                </label>
                <label className={labelCls}>
                  Department
                  <select name="department_id" defaultValue={person.department_id ?? ""} className={inputCls}>
                    <option value="">No department</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelCls}>
                  Employment status
                  <input
                    name="employment_status"
                    defaultValue={person.employment_status ?? "Independent Contractor"}
                    list="employment-status-options"
                    className={inputCls}
                  />
                  <datalist id="employment-status-options">
                    <option value="probationary" />
                    <option value="active" />
                    <option value="Independent Contractor" />
                  </datalist>
                </label>
                <label className={labelCls}>
                  Date started
                  <input
                    name="date_started"
                    type="date"
                    defaultValue={person.date_started ?? ""}
                    className={inputCls}
                  />
                </label>
                <label className={`${labelCls} sm:col-span-2`}>
                  Probation end
                  <input
                    name="probation_end"
                    type="date"
                    defaultValue={person.probation_end ?? ""}
                    className={inputCls}
                  />
                  <span className="mt-1 block text-[11px] normal-case tracking-normal text-ink-muted">
                    For a new hire, set status to <span className="text-amber-300">probationary</span>{" "}
                    and pick the date probation ends. Once that date passes, access is
                    paused until you Make Permanent.
                  </span>
                </label>
                <label className={labelCls}>
                  Supervisor
                  <select name="supervisor_id" defaultValue={person.supervisor_id ?? ""} className={inputCls}>
                    <option value="">None</option>
                    {supervisors
                      .filter((s) => s.id !== person.id)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className={labelCls}>
                  Team assignment
                  <input
                    name="team_assignment"
                    defaultValue={person.team_assignment ?? ""}
                    placeholder="e.g. Pod A"
                    className={inputCls}
                  />
                </label>
                <label className={labelCls}>
                  System role
                  <select name="role" defaultValue={person.role} className={inputCls}>
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Pay — leadership only */}
              {canSeePay && (
                <>
                  <h3 className="mb-3 mt-6 text-xs font-semibold uppercase tracking-wider text-gold-400">
                    Compensation <span className="font-normal text-ink-muted">· leadership only</span>
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className={labelCls}>
                      Base pay (PHP)
                      <input
                        name="base_pay"
                        type="number"
                        step="0.01"
                        defaultValue={person.base_pay ?? ""}
                        placeholder="0.00"
                        className={inputCls}
                      />
                    </label>
                    <label className={labelCls}>
                      Compensation frequency
                      <select
                        name="compensation_frequency"
                        defaultValue={person.compensation_frequency ?? ""}
                        className={inputCls}
                      >
                        <option value="">—</option>
                        {FREQUENCIES.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={`${labelCls} sm:col-span-2`}>
                      Commission structure
                      <input
                        name="commission_structure"
                        defaultValue={person.commission_structure ?? ""}
                        placeholder="e.g. 5% of attributed GMV over quota"
                        className={inputCls}
                      />
                    </label>
                  </div>
                </>
              )}

              {/* Personal */}
              <h3 className="mb-3 mt-6 text-xs font-semibold uppercase tracking-wider text-violet-300">
                Personal details
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={labelCls}>
                  Mobile
                  <input name="mobile" defaultValue={person.mobile ?? ""} className={inputCls} />
                </label>
                <label className={labelCls}>
                  Email
                  <input name="email" type="email" defaultValue={person.email} required className={inputCls} />
                </label>
                <label className={`${labelCls} sm:col-span-2`}>
                  Telegram @username
                  <input
                    name="telegram_username"
                    defaultValue={person.telegram_username ?? ""}
                    placeholder="e.g. janedoe (no @ needed)"
                    className={inputCls}
                  />
                  <span className="mt-1 block text-[11px] normal-case tracking-normal text-ink-muted">
                    Required for task Snap-Tag to @mention this person in the team
                    Telegram group. Without it they&apos;re named in plain text (no ping).
                  </span>
                </label>
                <label className={`${labelCls} sm:col-span-2`}>
                  Home address
                  <input name="home_address" defaultValue={person.home_address ?? ""} className={inputCls} />
                </label>
                <label className={labelCls}>
                  Emergency contact name
                  <input
                    name="emergency_contact_name"
                    defaultValue={person.emergency_contact_name ?? ""}
                    className={inputCls}
                  />
                </label>
                <label className={labelCls}>
                  Emergency contact number
                  <input
                    name="emergency_contact_number"
                    defaultValue={person.emergency_contact_number ?? ""}
                    className={inputCls}
                  />
                </label>
              </div>

              {state.error && (
                <p className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {state.error}
                </p>
              )}

              <div className="mt-6 flex items-center justify-end gap-2 border-t border-charcoal-700/70 pt-4">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md bg-charcoal-800 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-700"
                >
                  Cancel
                </button>
                <SaveButton />
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
