"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CAPABILITY_REF_FIELDS,
  CAPABILITY_REF_LABELS,
  CAPABILITY_STATUSES,
  STATUS_META,
  type Capability,
  type CapabilityRefField,
  type CapabilityStatus,
} from "@/lib/capabilities/types";
import type { RegistryOption } from "@/lib/capabilities/data";
import { updateCapabilityAction } from "@/app/(dashboard)/vesper/core/actions";

// Capability detail + leadership edit. Read-only for everyone; ceo/coo/
// department_head get an inline editor for the status and the eight reference
// arrays. required_skills links to skill_registry keys and required_workflows to
// automation_registry keys via a picker; the rest are free-text chip lists. The
// save runs the RLS-scoped server action (Postgres rejects a non-leadership write
// regardless of this UI). Live/partial capabilities also expose "Create mission
// tasks" here.
export function CapabilityDetailModal({
  capability,
  canEdit,
  skillOptions,
  workflowOptions,
  onClose,
  onCreateMission,
}: {
  capability: Capability;
  canEdit: boolean;
  skillOptions: RegistryOption[];
  workflowOptions: RegistryOption[];
  onClose: () => void;
  onCreateMission?: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<CapabilityStatus>(capability.status);
  const [refs, setRefs] = useState<Record<CapabilityRefField, string[]>>(() => ({
    required_skills: [...capability.required_skills],
    required_tools: [...capability.required_tools],
    required_knowledge: [...capability.required_knowledge],
    required_agents: [...capability.required_agents],
    required_workflows: [...capability.required_workflows],
    required_permissions: [...capability.required_permissions],
    kpis: [...capability.kpis],
    outputs: [...capability.outputs],
  }));
  const [notes, setNotes] = useState(capability.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = STATUS_META[status];

  const pickerFor = (field: CapabilityRefField): RegistryOption[] | undefined => {
    if (field === "required_skills") return skillOptions;
    if (field === "required_workflows") return workflowOptions;
    return undefined;
  };

  async function save() {
    setBusy(true);
    setError(null);
    const res = await updateCapabilityAction(capability.id, { status, refs, notes });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Could not save.");
      return;
    }
    setEditing(false);
    router.refresh();
    onClose();
  }

  return (
    <Overlay onClose={onClose}>
      <div className="flex items-start justify-between gap-3 border-b border-charcoal-700 px-5 py-4">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-ink-dim">
            {String(capability.domain_no).padStart(2, "0")} · {capability.domain}
          </p>
          <h2 className="mt-0.5 truncate text-lg font-semibold text-ink">{capability.name}</h2>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${meta.chip}`}>
          {meta.label}
        </span>
      </div>

      <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
        {editing ? (
          <>
            <label className="block text-xs text-ink-muted">
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as CapabilityStatus)}
                className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-1.5 text-sm text-ink"
              >
                {CAPABILITY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label} — {STATUS_META[s].blurb}
                  </option>
                ))}
              </select>
            </label>

            {CAPABILITY_REF_FIELDS.map((field) => (
              <ArrayEditor
                key={field}
                label={CAPABILITY_REF_LABELS[field]}
                values={refs[field]}
                options={pickerFor(field)}
                onChange={(next) => setRefs((prev) => ({ ...prev, [field]: next }))}
              />
            ))}

            <label className="block text-xs text-ink-muted">
              Notes
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="mt-1 w-full resize-none rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-1.5 text-sm text-ink"
              />
            </label>
          </>
        ) : (
          <>
            {CAPABILITY_REF_FIELDS.map((field) => (
              <RefRow
                key={field}
                label={CAPABILITY_REF_LABELS[field]}
                values={capability[field]}
                options={pickerFor(field)}
              />
            ))}
            {capability.notes && (
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-dim">Notes</p>
                <p className="mt-1 text-sm text-ink-muted">{capability.notes}</p>
              </div>
            )}
          </>
        )}

        {error && <p className="text-sm text-gold-400">{error}</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-charcoal-700 px-5 py-3">
        <div className="flex items-center gap-2">
          {onCreateMission && !editing && (
            <button
              type="button"
              onClick={onCreateMission}
              className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400"
            >
              Create mission tasks
            </button>
          )}
          {canEdit && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink"
            >
              Edit
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

// Read-only reference row: a labelled list of chips. For skills/workflows, the
// value is a registry KEY — we show its friendly name when we can resolve it.
function RefRow({
  label,
  values,
  options,
}: {
  label: string;
  values: string[];
  options?: RegistryOption[];
}) {
  if (values.length === 0) return null;
  const nameFor = (key: string) =>
    options?.find((o) => o.key === key)?.name ?? key;
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-dim">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-0.5 text-xs text-ink-muted"
            title={options ? v : undefined}
          >
            {nameFor(v)}
          </span>
        ))}
      </div>
    </div>
  );
}

// Editable chip list: remove existing entries, add new ones (free text, or picked
// from a registry option list for skills/workflows).
function ArrayEditor({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options?: RegistryOption[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const nameFor = (key: string) => options?.find((o) => o.key === key)?.name ?? key;

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };

  const remaining = options?.filter((o) => !values.includes(o.key)) ?? [];

  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-dim">
        {label}
        {options ? <span className="ml-1 normal-case text-ink-dim/70">(from registry)</span> : null}
      </p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-0.5 text-xs text-ink"
            title={options ? v : undefined}
          >
            {nameFor(v)}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
              className="text-ink-dim hover:text-red-300"
            >
              ×
            </button>
          </span>
        ))}
        {values.length === 0 && <span className="text-xs text-ink-dim">None</span>}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        {options ? (
          <select
            value=""
            onChange={(e) => e.target.value && add(e.target.value)}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1 text-xs text-ink"
          >
            <option value="">＋ Add {label.toLowerCase()}…</option>
            {remaining.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name ?? o.key}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add(draft);
                }
              }}
              placeholder={`Add ${label.toLowerCase()}…`}
              className="flex-1 rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1 text-xs text-ink placeholder:text-ink-dim"
            />
            <button
              type="button"
              onClick={() => add(draft)}
              className="rounded-md border border-charcoal-700 px-2 py-1 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
            >
              Add
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Shared centered overlay panel. Click the backdrop to close.
function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-charcoal-700 bg-charcoal-900 shadow-elevate sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
