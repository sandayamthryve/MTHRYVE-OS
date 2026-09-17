"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";

export type ImportTasksState = { imported: number; skipped: string[] } | null;

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60">{pending ? "Importing…" : "Import Tasks (CSV)"}</button>;
}

export function ImportTasksControl({ action }: { action: (prev: ImportTasksState, formData: FormData) => Promise<ImportTasksState> }) {
  const [state, formAction] = useFormState(action, null);
  const [toastMounted, setToastMounted] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const helper = "Bulk-add tasks from a spreadsheet. Each valid row inserts a task. Rows missing a title — or naming an assignee_email that matches no user — are skipped and reported. Brand and project are matched by name; unknown names resolve to none. Priority defaults to Medium and status to To do when blank.";

  useEffect(() => {
    const oldHelper = formRef.current?.previousElementSibling;
    if (oldHelper instanceof HTMLElement) oldHelper.style.display = "none";
  }, []);

  useEffect(() => {
    if (!state) return;
    setToastMounted(true);
    setToastVisible(false);
    const enter = window.setTimeout(() => setToastVisible(true), 20);
    const exit = window.setTimeout(() => setToastVisible(false), 3200);
    const unmount = window.setTimeout(() => setToastMounted(false), 3550);
    return () => { window.clearTimeout(enter); window.clearTimeout(exit); window.clearTimeout(unmount); };
  }, [state]);

  const isError = !!state && (state.imported === 0 || state.skipped.length > 0);

  return <>
    <form ref={formRef} action={formAction} className="relative space-y-3">
      <div className="absolute -top-11 left-[114px] z-20 group"><button type="button" aria-label="About task CSV imports" className="grid h-[18px] w-[18px] place-items-center rounded-full border border-charcoal-700 bg-charcoal-950 text-[10px] font-bold text-ink-muted transition hover:border-teal-400/50 hover:text-teal-300 focus-visible:border-teal-400/50 focus-visible:text-teal-300">?</button><div role="tooltip" className="pointer-events-none absolute left-0 top-[calc(100%+8px)] z-50 w-[min(360px,80vw)] rounded-lg border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-[11px] font-normal leading-relaxed text-ink-muted opacity-0 shadow-elevate transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{helper}</div></div>
      <textarea name="csv" rows={4} placeholder="Paste CSV here, or choose a .csv file below…" className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 font-mono text-xs text-ink" />
      <div className="flex flex-wrap items-center gap-3"><input type="file" name="file" accept=".csv,text/csv" className="w-full max-w-full text-xs text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-charcoal-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal-300 hover:file:bg-charcoal-700" /><SubmitButton /></div>
      <p className="text-xs text-ink-muted">columns: title, description, assignee_email, brand, project, priority, status, due_date, department</p>
    </form>
    {state && toastMounted && <div role={isError ? "alert" : "status"} className={`fixed bottom-6 left-1/2 z-[200] w-[min(420px,calc(100vw-32px))] rounded-xl border px-4 py-3 text-center text-sm shadow-elevate transition-all duration-300 ease-out ${toastVisible ? "-translate-x-1/2 translate-y-0 scale-100 opacity-100" : "-translate-x-1/2 translate-y-4 scale-95 opacity-0"} ${isError ? "border-red-500/50 bg-red-950/95 text-red-100" : "border-green-500/50 bg-green-950/95 text-green-100"}`}><div className="flex flex-col items-center justify-center"><span className={`mb-1 font-bold ${isError ? "text-red-400" : "text-green-400"}`}>{isError ? "!" : "✓"}</span><p className="font-semibold">{isError ? "Task import failed" : "Task import complete"}</p><p className={`mt-0.5 text-xs ${isError ? "text-red-200/80" : "text-green-200/80"}`}>{state.imported} row{state.imported === 1 ? "" : "s"} imported{state.skipped.length > 0 ? ` · ${state.skipped.length} skipped` : ""}</p>{state.skipped.length > 0 && <p className={`mx-auto mt-1 max-w-[350px] text-[10px] ${isError ? "text-red-300/75" : "text-green-300/75"}`}>{state.skipped.join(" / ")}</p>}</div></div>}
  </>;
}
