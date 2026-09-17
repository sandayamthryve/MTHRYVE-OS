"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
// React 18 / Next 14: form state comes from react-dom's useFormState, not
// React 19's useActionState, which is what the rest of the app uses too.
import { useFormState, useFormStatus } from "react-dom";
import { addLogEntry, type LogEntryState } from "@/app/(dashboard)/team-workspace/actions";
import type { LogEntry } from "@/lib/team-workspace/data";

function LogButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] px-4 py-2.5 text-[13px] font-extrabold text-[#04120c] transition hover:brightness-110 disabled:opacity-60"
    >
      {pending ? "Logging…" : "+ Log entry"}
    </button>
  );
}

export function LogWork({ entries, filed }: { entries: LogEntry[]; filed: boolean }) {
  const [state, action] = useFormState<LogEntryState, FormData>(addLogEntry, { ok: true });
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the box only once the entry is actually saved — a failed write must
  // keep the text, or the person loses what they typed.
  useEffect(() => {
    if (state.ok && !state.error) formRef.current?.reset();
  }, [state]);

  return (
    <section className="rounded-2xl border border-[#20313c] bg-[#0b1319] p-5">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-[15px] font-extrabold text-[#e9f0f6]">📝 Log your work</h2>
        <p className="text-[12.5px] text-[#8b9aa8]">· where they LOG it</p>
      </header>

      <form ref={formRef} action={action} className="rounded-xl border border-dashed border-[#243741] p-4">
        <label htmlFor="tw-entry" className="sr-only">What did you do?</label>
        <textarea
          id="tw-entry"
          name="entry"
          rows={3}
          maxLength={500}
          placeholder="e.g. Shipped 128 orders; flagged QC on batch #221…"
          className="w-full resize-y rounded-lg border border-[#1e2a35] bg-[#080e13] p-3 text-[13px] text-[#e9f0f6] outline-none placeholder:text-[#60707d] focus:border-[#2dd4bf]/55"
        />
        {state.error && (
          <p role="alert" className="mt-2 text-[12px] font-semibold text-[#f87171]">{state.error}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <LogButton />
          <Link
            href="/daily-report"
            className="rounded-lg border border-[#20313c] bg-[#0d141b] px-4 py-2.5 text-[13px] font-bold text-[#e9f0f6] transition hover:border-[#2dd4bf]/45"
          >
            📋 File daily report
          </Link>
        </div>
      </form>

      <div className="mt-5">
        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#8b9aa8]">
          Logged today{filed ? " · filed" : ""}
        </p>
        {entries.length === 0 ? (
          <p className="mt-3 text-[12.5px] text-[#6f8491]">
            Nothing logged yet today. What you add here becomes the outputs on your daily report.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-2 text-[13px] text-[#e9f0f6]">
                <span aria-hidden className="mt-[2px] text-[#3ecf8e]">✓</span>
                <span className="min-w-0">{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
