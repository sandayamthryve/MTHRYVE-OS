"use client";

// components/archive/RowActions.tsx — the one control cluster pages drop next to
// a row to get Edit + Soft-Archive + (leadership) hard-delete, all wired to the
// shared cluster-keyed server actions. Nothing here is cluster-specific: the
// page passes the cluster key, the row id + label, the viewer's resolved
// permissions (booleans), and — only for clusters without a bespoke editor — the
// field specs + current values for the generic edit dialog.
//
// Layout intent (from the brief): Archive/Restore read as the everyday action;
// hard-delete is visually separated (a divider + red "Delete permanently") and
// gated to ceo/coo, so the destructive path never sits flush with the safe one.

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { archiveRow, editRow, hardDeleteRow, restoreRow } from "@/lib/archive/actions";
import { requestGovernedDeletion } from "@/app/(dashboard)/approvals/governance-actions";
import type { GovActionState } from "@/lib/governance/delete-entities";
import type { ArchiveActionState, ClusterKey, FieldSpec, RowActionsProps } from "@/lib/archive/config";

const EMPTY: ArchiveActionState = { ok: false };

type EditValues = Record<string, string | number | null | undefined>;

export type { RowActionsProps };

function PendingButton({
  idle,
  busy,
  className,
  title,
  onClick,
}: {
  idle: string;
  busy: string;
  className: string;
  title?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} title={title} onClick={onClick} className={className}>
      {pending ? busy : idle}
    </button>
  );
}

const btnBase =
  "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-60";

// A one-button form bound to a shared action, with inline error surfacing.
function ActionForm({
  action,
  cluster,
  id,
  idle,
  busy,
  className,
  confirmText,
}: {
  action: (prev: ArchiveActionState | null, fd: FormData) => Promise<ArchiveActionState>;
  cluster: ClusterKey;
  id: string;
  idle: string;
  busy: string;
  className: string;
  confirmText?: string;
}) {
  const [state, formAction] = useFormState(action, EMPTY);
  return (
    <form action={formAction} className="inline-flex flex-col items-start">
      <input type="hidden" name="cluster" value={cluster} />
      <input type="hidden" name="id" value={id} />
      <PendingButton
        idle={idle}
        busy={busy}
        className={className}
        onClick={
          confirmText
            ? (e) => {
                if (!window.confirm(confirmText)) e.preventDefault();
              }
            : undefined
        }
      />
      {state && !state.ok && state.error ? (
        <span className="mt-0.5 max-w-[16rem] text-[10px] text-red-300">{state.error}</span>
      ) : null}
    </form>
  );
}

// Governed "Request deletion" — files a 2-approval delete request (COO → CEO)
// instead of deleting. Shown to EVERY role (anyone may ask); the officers decide
// in the Approvals inbox. On success it surfaces the "awaiting COO" confirmation
// inline and the button locks so a second identical request can't be stacked.
const GOV_EMPTY: GovActionState = { ok: false };
function GovernedDeleteForm({
  entity,
  id,
  label,
  className,
}: {
  entity: string;
  id: string;
  label: string;
  className: string;
}) {
  const [state, formAction] = useFormState(requestGovernedDeletion, GOV_EMPTY);
  return (
    <form action={formAction} className="inline-flex flex-col items-start">
      <input type="hidden" name="entity" value={entity} />
      <input type="hidden" name="id" value={id} />
      <PendingButton
        idle="Request deletion"
        busy="Requesting…"
        className={className}
        title={`Request a governed permanent delete of this ${label} (COO → CEO approval)`}
        onClick={
          state.ok
            ? (e) => e.preventDefault() // already requested — don't re-file
            : (e) => {
                if (
                  !window.confirm(
                    `Request permanent deletion of this ${label}? It needs COO then CEO approval before anything is deleted.`
                  )
                )
                  e.preventDefault();
              }
        }
      />
      {state.ok && state.message ? (
        <span className="mt-0.5 max-w-[16rem] text-[10px] text-teal-300">{state.message}</span>
      ) : null}
      {!state.ok && state.error ? (
        <span className="mt-0.5 max-w-[16rem] text-[10px] text-red-300">{state.error}</span>
      ) : null}
    </form>
  );
}

function EditDialog({
  cluster,
  id,
  label,
  fields,
  values,
  onClose,
}: {
  cluster: ClusterKey;
  id: string;
  label: string;
  fields: FieldSpec[];
  values: EditValues;
  onClose: () => void;
}) {
  const [state, formAction] = useFormState(editRow, EMPTY);
  const lastNonce = useRef<number | undefined>(undefined);

  // Close the dialog once a save succeeds (nonce guards against stale repeats).
  useEffect(() => {
    if (state?.ok && state.nonce !== lastNonce.current) {
      lastNonce.current = state.nonce;
      onClose();
    }
  }, [state, onClose]);

  const field = "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-xs text-ink";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-charcoal-700 bg-charcoal-900 p-5 shadow-elevate">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Edit {label}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-0.5 text-ink-muted hover:text-ink"
          >
            ✕
          </button>
        </div>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="cluster" value={cluster} />
          <input type="hidden" name="id" value={id} />
          {fields.map((f) => {
            const raw = values[f.name];
            const dv = raw == null ? "" : String(raw);
            return (
              <label key={f.name} className="block">
                <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                  {f.label}
                  {f.required ? " *" : ""}
                </span>
                {f.type === "textarea" ? (
                  <textarea name={f.name} defaultValue={dv} placeholder={f.placeholder} rows={3} className={field} />
                ) : f.type === "select" ? (
                  <select name={f.name} defaultValue={dv} className={field}>
                    <option value="">—</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    name={f.name}
                    type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                    step={f.type === "number" ? f.step ?? "any" : undefined}
                    defaultValue={dv}
                    placeholder={f.placeholder}
                    className={field}
                  />
                )}
              </label>
            );
          })}
          {state && !state.ok && state.error ? (
            <p className="text-[11px] text-red-300">{state.error}</p>
          ) : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs text-ink-muted hover:bg-charcoal-700"
            >
              Cancel
            </button>
            <SaveButton />
          </div>
        </form>
      </div>
    </div>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500/90 px-4 py-1.5 text-xs font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save changes"}
    </button>
  );
}

export function RowActions({
  cluster,
  id,
  label,
  archived,
  canWrite,
  canHardDelete,
  editFields,
  editValues,
  governedDelete,
  className,
}: RowActionsProps) {
  const [editing, setEditing] = useState(false);
  const showEdit = canWrite && !archived && !!editFields && editFields.length > 0;

  return (
    <div className={`inline-flex flex-wrap items-start gap-1.5 ${className ?? ""}`}>
      {showEdit && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={`${btnBase} bg-charcoal-800 text-teal-300 hover:bg-charcoal-700`}
        >
          Edit
        </button>
      )}

      {canWrite && !archived && (
        <ActionForm
          action={archiveRow}
          cluster={cluster}
          id={id}
          idle="Archive"
          busy="Archiving…"
          className={`${btnBase} bg-charcoal-800 text-amber-300 hover:bg-charcoal-700`}
        />
      )}

      {canWrite && archived && (
        <ActionForm
          action={restoreRow}
          cluster={cluster}
          id={id}
          idle="Restore"
          busy="Restoring…"
          className={`${btnBase} bg-charcoal-800 text-teal-300 hover:bg-charcoal-700`}
        />
      )}

      {/* Governed clusters replace the raw one-click delete with a 2-approval
          request; ungoverned clusters keep the ceo/coo one-click hard-delete. */}
      {governedDelete ? (
        <>
          {/* Visually separate the irreversible path from Archive/Restore. */}
          <span aria-hidden className="mx-0.5 self-center text-charcoal-600">
            |
          </span>
          <GovernedDeleteForm
            entity={governedDelete.entity}
            id={id}
            label={label}
            className={`${btnBase} border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20`}
          />
        </>
      ) : (
        canHardDelete && (
          <>
            {/* Visually separate the irreversible path from Archive/Restore. */}
            <span aria-hidden className="mx-0.5 self-center text-charcoal-600">
              |
            </span>
            <ActionForm
              action={hardDeleteRow}
              cluster={cluster}
              id={id}
              idle="Delete permanently"
              busy="Deleting…"
              className={`${btnBase} border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20`}
              confirmText={`Permanently delete this ${label}? This can't be undone.`}
            />
          </>
        )
      )}

      {editing && showEdit && (
        <EditDialog
          cluster={cluster}
          id={id}
          label={label}
          fields={editFields!}
          values={editValues ?? {}}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
