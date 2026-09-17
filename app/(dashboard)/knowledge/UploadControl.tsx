"use client";

// Upload island for the Knowledge base. Collects a file + metadata and hands it
// to the uploadDocument server action (passed down as a prop so the action stays
// co-located with the page). The action uploads to Storage, inserts the document
// row, and runs ingestion; the returned message is surfaced inline. Mirrors the
// warehouse/metrics import islands' shape.

import { useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";

export type UploadState = { ok: boolean; message: string } | null;

const SOURCE_TYPES = [
  { value: "sop", label: "SOP" },
  { value: "playbook", label: "Playbook" },
  { value: "contract", label: "Contract" },
  { value: "report", label: "Report" },
  { value: "other", label: "Other" },
] as const;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Uploading & indexing…" : "Upload & index"}
    </button>
  );
}

export function UploadControl({
  action,
  departments,
}: {
  action: (prev: UploadState, formData: FormData) => Promise<UploadState>;
  departments: { id: string; name: string }[];
}) {
  const [state, formAction] = useFormState(action, null);
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the file/title on a successful upload so the next one starts fresh.
  if (state?.ok && formRef.current) formRef.current.reset();

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-muted">Title</span>
          <input
            type="text"
            name="title"
            required
            maxLength={200}
            placeholder="e.g. Returns Handling SOP"
            className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink placeholder:text-ink-dim"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-muted">Source type</span>
          <select
            name="source_type"
            defaultValue="sop"
            className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink"
          >
            {SOURCE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-muted">Sensitivity</span>
          <select
            name="sensitivity"
            defaultValue="org"
            className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink"
          >
            <option value="org">Org — all members can retrieve</option>
            <option value="leadership">Leadership — CEO / COO only</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-muted">
            Department <span className="text-ink-dim">(optional)</span>
          </span>
          <select
            name="department_id"
            defaultValue=""
            className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink"
          >
            <option value="">— None —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          name="file"
          required
          accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
          className="w-full max-w-full text-xs text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-charcoal-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal-300 hover:file:bg-charcoal-700"
        />
        <SubmitButton />
      </div>

      <p className="text-[11px] text-ink-dim">
        Accepted: PDF, DOCX, TXT, MD. The file is stored privately, split into
        ~800-token chunks, and embedded for semantic search.
      </p>

      {state && (
        <p className={`text-sm ${state.ok ? "text-teal-300" : "text-red-300"}`}>{state.message}</p>
      )}
    </form>
  );
}
