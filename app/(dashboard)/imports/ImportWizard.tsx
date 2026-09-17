"use client";

// The Bulk Import wizard: pick what you're importing → upload/paste a CSV →
// map columns → PREVIEW (valid / errors / duplicates flagged) → confirm commit.
// Preview and commit are two server actions (passed in as props so they stay
// co-located with the page). Nothing writes until "Confirm import"; the raw CSV
// is carried in a hidden field so the confirm submits the exact same bytes with
// the operator's final mapping. Invalid + duplicate rows come back as a
// downloadable error report — never dropped silently.

import { useEffect, useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { PreviewState, CommitState, ColumnMeta } from "./types";

export interface ImporterMeta {
  entity: string;
  label: string;
  description: string;
  ownerHint: string;
  dedupLabel: string;
  columns: ColumnMeta[];
}

const fieldCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-dim focus:border-teal-500 focus:outline-none";

function PreviewButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-charcoal-800 px-4 py-2 text-sm font-semibold text-teal-300 hover:bg-charcoal-700 disabled:opacity-60"
    >
      {pending ? "Reading…" : "Preview"}
    </button>
  );
}

function ConfirmButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Importing…" : `Confirm import (${count})`}
    </button>
  );
}

const STATUS_STYLE: Record<string, string> = {
  valid: "text-teal-300",
  duplicate: "text-amber-300",
  error: "text-rose-300",
};

function csvEscape(v: unknown): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

export function ImportWizard({
  entities,
  initialEntity,
  previewAction,
  commitAction,
}: {
  entities: ImporterMeta[];
  // Preselected importer from a deep-link (e.g. /imports?entity=products). Only
  // honoured when it's one of the entities this caller may run; otherwise the
  // first is selected.
  initialEntity?: string;
  previewAction: (prev: PreviewState, fd: FormData) => Promise<PreviewState>;
  commitAction: (prev: CommitState, fd: FormData) => Promise<CommitState>;
}) {
  const preselected = entities.some((e) => e.entity === initialEntity) ? (initialEntity as string) : "";
  const [entity, setEntity] = useState(preselected || entities[0]?.entity || "");
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [mapDirty, setMapDirty] = useState(false);

  const [previewState, preview] = useFormState(previewAction, null);
  const [commitState, commit] = useFormState(commitAction, null);

  const meta = useMemo(() => entities.find((e) => e.entity === entity), [entities, entity]);

  // When a fresh preview arrives, adopt its (auto or echoed) mapping.
  useEffect(() => {
    if (previewState?.ok && previewState.mapping) {
      setMapping(previewState.mapping);
      setMapDirty(false);
    }
  }, [previewState]);

  const headers = previewState?.ok ? previewState.headers ?? [] : [];
  const columns = previewState?.ok ? previewState.columns ?? [] : [];
  const csv = previewState?.ok ? previewState.csv ?? "" : "";
  const fileName = previewState?.ok ? previewState.fileName ?? "" : "";
  const fileSize = previewState?.ok ? previewState.fileSize ?? 0 : 0;
  const headerRow = previewState?.ok ? previewState.headerRow : undefined;
  const ignoredColumns = previewState?.ok ? previewState.ignoredColumns ?? [] : [];
  const resolvedBrands = previewState?.ok ? previewState.resolvedBrands ?? [] : [];
  const totals = previewState?.ok ? previewState.preview?.totals : undefined;
  const rows = previewState?.ok ? previewState.preview?.rows ?? [] : [];
  const sampleTruncated = previewState?.ok ? previewState.preview?.sampleTruncated : false;
  const mappedSample = previewState?.ok ? previewState.preview?.mappedSample ?? [] : [];
  const sampleFields = mappedSample[0]?.fields ?? [];

  const mappedKeys = new Set(Object.values(mapping).filter(Boolean));
  const missingRequired = columns.filter((c) => c.required && !mappedKeys.has(c.key));
  const mappingJson = JSON.stringify(mapping);

  function downloadReport() {
    const report = commitState?.ok ? commitState.report ?? [] : commitState?.report ?? [];
    const head = ["line", "status", "label", "reason"];
    const lines = [head.map(csvEscape).join(",")];
    for (const r of report) {
      lines.push([r.line, r.status, r.label, r.reason].map(csvEscape).join(","));
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-errors-${entity}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const reportCount = commitState?.report?.length ?? 0;

  return (
    <div className="space-y-6">
      {/* ── Step 1 — choose + upload ─────────────────────────────────────── */}
      <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5">
        <h2 className="mb-3 text-base font-semibold text-ink">1 · What are you importing?</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {entities.map((e) => (
            <label
              key={e.entity}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                entity === e.entity ? "border-teal-500/60 bg-teal-500/5" : "border-charcoal-700/60 hover:border-charcoal-600"
              }`}
            >
              <input
                type="radio"
                name="entityPick"
                checked={entity === e.entity}
                onChange={() => setEntity(e.entity)}
                className="mt-1 h-4 w-4 accent-teal-500"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{e.label}</span>
                <span className="block text-xs text-ink-muted">{e.description}</span>
                <span className="mt-1 block text-[11px] text-ink-dim">
                  Dedup on {e.dedupLabel} · {e.ownerHint}
                </span>
              </span>
            </label>
          ))}
        </div>

        {meta && (
          <p className="mt-3 text-[11px] text-ink-dim">
            Recognised columns:{" "}
            <span className="font-mono text-ink-muted">
              {meta.columns.map((c) => c.key + (c.required ? "*" : "")).join(", ")}
            </span>{" "}
            &nbsp;(*required). Unknown headers are ignored; you can remap below.
          </p>
        )}

        {/* Step 1 always re-parses the fresh file/paste and auto-maps on the
            server — no stale mapping or echoed CSV is carried here. */}
        <form action={preview} className="mt-4 space-y-3">
          <input type="hidden" name="entity" value={entity} />
          <textarea
            name="pasted"
            rows={4}
            placeholder="Paste CSV here (with a header row), or choose a .csv, .xlsx or .xls file below…"
            className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 font-mono text-xs text-ink"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              name="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="w-full max-w-full text-xs text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-charcoal-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal-300 hover:file:bg-charcoal-700"
            />
            <PreviewButton />
          </div>
          <p className="text-[11px] text-ink-dim">
            Accepts CSV, XLSX and XLS. PDF and images are not accepted — export as CSV or Excel from Seller Center.
          </p>
        </form>

        {previewState && !previewState.ok && previewState.error && (
          <p className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs text-rose-200">
            {previewState.error}
          </p>
        )}
      </div>

      {/* ── Step 2 — map + preview ───────────────────────────────────────── */}
      {previewState?.ok && (
        <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5">
          <h2 className="mb-1 text-base font-semibold text-ink">2 · Map columns &amp; preview</h2>
          <p className="mb-2 text-xs text-ink-muted">
            {fileName ? `${fileName} · ` : ""}
            {totals?.total ?? 0} data row(s)
            {headerRow ? ` · header detected on row ${headerRow}` : ""}. Adjust any mapping, then re-preview.
          </p>

          {/* Resolved brand(s) + ignored columns — confirm before anything writes. */}
          {(resolvedBrands.length > 0 || ignoredColumns.length > 0) && (
            <div className="mb-4 space-y-1 text-[11px] text-ink-dim">
              {resolvedBrands.length > 0 && (
                <p>
                  <span className="text-ink-muted">Brand{resolvedBrands.length > 1 ? "s" : ""} resolved:</span>{" "}
                  {resolvedBrands.map((b) => `${b.value} → ${b.brand}`).join(" · ")}
                </p>
              )}
              {ignoredColumns.length > 0 && (
                <p>
                  <span className="text-ink-muted">Ignored:</span> {ignoredColumns.join(", ")}
                </p>
              )}
            </div>
          )}

          <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {headers.map((h, i) => (
              <label key={i} className="flex items-center justify-between gap-2 rounded-md border border-charcoal-700/50 px-2.5 py-1.5">
                <span className="min-w-0 truncate font-mono text-xs text-ink-muted" title={h}>
                  {h || `(column ${i + 1})`}
                </span>
                <select
                  value={mapping[i] ?? ""}
                  onChange={(ev) => {
                    const v = ev.target.value;
                    setMapping((m) => {
                      const next = { ...m };
                      if (v) next[i] = v;
                      else delete next[i];
                      return next;
                    });
                    setMapDirty(true);
                  }}
                  className={fieldCls}
                >
                  <option value="">(ignore)</option>
                  {columns.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                      {c.required ? " *" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {missingRequired.length > 0 && (
            <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">
              Unmapped required column(s): {missingRequired.map((c) => c.label).join(", ")}. The whole file is refused until every
              required column is mapped — nothing is imported.
            </p>
          )}

          {/* Re-preview with the edited mapping (re-uses the echoed CSV). */}
          <form action={preview} className="mb-4">
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="mapping" value={mappingJson} />
            <input type="hidden" name="csv" value={csv} />
            <button
              type="submit"
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                mapDirty ? "bg-teal-500 text-charcoal-950 hover:bg-teal-400" : "bg-charcoal-800 text-teal-300 hover:bg-charcoal-700"
              }`}
            >
              {mapDirty ? "Update preview →" : "Re-run preview"}
            </button>
          </form>

          {/* Totals */}
          <div className="mb-4 flex flex-wrap gap-4 text-sm">
            <span className="text-teal-300">{totals?.valid ?? 0} valid</span>
            <span className="text-amber-300">{totals?.duplicates ?? 0} duplicate</span>
            <span className="text-rose-300">{totals?.invalid ?? 0} invalid</span>
            {(previewState.droppedRows ?? 0) > 0 && (
              <span className="text-ink-dim">{previewState.droppedRows} beyond row cap</span>
            )}
          </div>

          {/* First rows mapped to destination fields — confirm the mapping is right
              before anything is written. */}
          {mappedSample.length > 0 && sampleFields.length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs text-ink-muted">
                First {mappedSample.length} row{mappedSample.length > 1 ? "s" : ""} mapped to destination fields:
              </p>
              <div className="overflow-x-auto rounded-lg border border-charcoal-700/50">
                <table className="w-full text-left text-xs">
                  <thead className="bg-charcoal-900 text-ink-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Line</th>
                      {sampleFields.map((f) => (
                        <th key={f.key} className="px-3 py-2 font-medium whitespace-nowrap">
                          {f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mappedSample.map((r) => (
                      <tr key={r.line} className="border-t border-charcoal-800/60">
                        <td className="px-3 py-1.5 text-ink-dim">{r.line}</td>
                        {r.fields.map((f) => (
                          <td key={f.key} className="px-3 py-1.5 text-ink whitespace-nowrap">
                            {f.value}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Row table */}
          <div className="max-h-80 overflow-auto rounded-lg border border-charcoal-700/50">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-charcoal-900 text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Line</th>
                  <th className="px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line} className="border-t border-charcoal-800/60">
                    <td className="px-3 py-1.5 text-ink-dim">{r.line}</td>
                    <td className="px-3 py-1.5 text-ink">{r.label}</td>
                    <td className={`px-3 py-1.5 font-semibold ${STATUS_STYLE[r.status] ?? "text-ink"}`}>{r.status}</td>
                    <td className="px-3 py-1.5 text-ink-muted">{r.messages.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sampleTruncated && (
            <p className="mt-2 text-[11px] text-ink-dim">Showing the first 300 rows — all rows are counted above and will be imported.</p>
          )}

          {/* ── Step 3 — confirm ──────────────────────────────────────────── */}
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-charcoal-800 pt-4">
            <form action={commit}>
              <input type="hidden" name="entity" value={entity} />
              <input type="hidden" name="mapping" value={mappingJson} />
              <input type="hidden" name="csv" value={csv} />
              <input type="hidden" name="fileName" value={fileName} />
              <input type="hidden" name="fileSize" value={String(fileSize)} />
              <ConfirmButton count={totals?.valid ?? 0} />
            </form>
            <span className="text-xs text-ink-dim">
              Only the {totals?.valid ?? 0} valid row(s) are written. Duplicates and invalid rows are reported, not imported.
            </span>
          </div>
        </div>
      )}

      {/* ── Result ───────────────────────────────────────────────────────── */}
      {commitState && (
        <div
          className={`rounded-xl border p-5 ${
            commitState.ok ? "border-teal-500/40 bg-teal-500/5" : "border-rose-500/40 bg-rose-500/5"
          }`}
        >
          <h2 className="mb-1 text-base font-semibold text-ink">{commitState.ok ? "Import complete" : "Import failed"}</h2>
          <p className="text-sm text-ink-muted">{commitState.ok ? commitState.message : commitState.error}</p>
          {commitState.ok && (commitState.errorLines?.length ?? 0) > 0 && (
            <ul className="mt-3 space-y-0.5 text-xs text-amber-200/90">
              {commitState.errorLines!.map((line, i) => (
                <li key={i} className="font-mono">
                  {line}
                </li>
              ))}
            </ul>
          )}
          {reportCount > 0 && (
            <button
              type="button"
              onClick={downloadReport}
              className="mt-3 rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-charcoal-700"
            >
              Download error report ({reportCount}) — CSV
            </button>
          )}
        </div>
      )}
    </div>
  );
}
