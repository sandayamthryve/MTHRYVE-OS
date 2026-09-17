"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { STATUS_META, type Capability } from "@/lib/capabilities/types";
import {
  MISSION_TASK_PRIORITIES,
  type MissionTaskDraft,
  type MissionTaskPriority,
} from "@/lib/capabilities/missions";
import {
  draftMissionTasksAction,
  createMissionTasksAction,
} from "@/app/(dashboard)/vesper/core/actions";

type UserOption = { id: string; name: string };

// Mission-task creation, human-in-the-loop by construction:
//   1. Vesper DRAFTS a task list from the capability's outputs/steps + context.
//   2. The user reviews — edits titles/descriptions, sets assignee/priority/due
//      date, removes rows, adds their own.
//   3. On confirm, the tasks are created via the existing task flow, each linked
//      to the capability (tasks.capability_id) for traceability.
// Nothing is created until the user hits confirm. Only live/partial capabilities
// reach this modal (the registry gates the entry point), and the server action
// re-checks that.
export function MissionTaskModal({
  capability,
  users,
  onClose,
}: {
  capability: Capability;
  users: UserOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [context, setContext] = useState("");
  const [rows, setRows] = useState<MissionTaskDraft[]>([]);
  const [phase, setPhase] = useState<"loading" | "review" | "done">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdCount, setCreatedCount] = useState(0);

  const meta = STATUS_META[capability.status];

  const draft = useCallback(
    async (ctx: string) => {
      setPhase("loading");
      setError(null);
      const res = await draftMissionTasksAction(capability.id, ctx);
      if (!res.ok || !res.drafts) {
        setError(res.error ?? "Could not draft tasks.");
        setPhase("review");
        return;
      }
      setRows(res.drafts);
      setPhase("review");
    },
    [capability.id]
  );

  useEffect(() => {
    void draft("");
  }, [draft]);

  const updateRow = (i: number, patch: Partial<MissionTaskDraft>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));
  const addRow = () =>
    setRows((prev) => [
      ...prev,
      { title: "", description: "", priority: "medium", due_date: null, assignee_id: null, assignee_hint: null },
    ]);

  async function confirm() {
    const tasks = rows
      .filter((r) => r.title.trim())
      .map((r) => ({
        title: r.title.trim(),
        description: r.description.trim(),
        priority: r.priority,
        due_date: r.due_date,
        assignee_id: r.assignee_id,
      }));
    if (tasks.length === 0) {
      setError("Add at least one task with a title.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await createMissionTasksAction(capability.id, tasks);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Could not create tasks.");
      return;
    }
    setCreatedCount(res.created ?? tasks.length);
    setPhase("done");
    router.refresh();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[94vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-charcoal-700 bg-charcoal-900 shadow-elevate sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-charcoal-700 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-ink-dim">Create mission tasks</p>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-ink">{capability.name}</h2>
            <p className="mt-0.5 font-mono text-[11px] text-ink-dim">{capability.domain}</p>
          </div>
          <span className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${meta.chip}`}>
            {meta.label}
          </span>
        </div>

        {phase === "done" ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/15 text-green-400">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <p className="text-sm text-ink">
              Created {createdCount} task{createdCount === 1 ? "" : "s"}, linked to{" "}
              <span className="font-medium">{capability.name}</span>.
            </p>
            <div className="flex items-center gap-2">
              <a
                href="/tasks"
                className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400"
              >
                Go to tasks
              </a>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="max-h-[62vh] space-y-3 overflow-y-auto px-5 py-4">
              <div className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-3">
                <label className="text-xs text-ink-muted">
                  Context (optional) — what's this mission for?
                  <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={context}
                      onChange={(e) => setContext(e.target.value)}
                      placeholder="e.g. Q3 push for Crayola on TikTok Shop"
                      className="flex-1 rounded-md border border-charcoal-700 bg-charcoal-900 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-dim"
                    />
                    <button
                      type="button"
                      onClick={() => void draft(context)}
                      disabled={phase === "loading"}
                      className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink disabled:opacity-60"
                    >
                      Re-draft
                    </button>
                  </div>
                </label>
                <p className="mt-1.5 text-[11px] text-ink-dim">
                  Vesper drafts the tasks below — review, edit, remove, or add before you create them.
                  Nothing is created until you confirm.
                </p>
              </div>

              {phase === "loading" ? (
                <p className="py-6 text-center text-sm text-ink-muted">Drafting tasks…</p>
              ) : (
                <>
                  {rows.map((r, i) => (
                    <TaskRow
                      key={i}
                      row={r}
                      users={users}
                      onChange={(patch) => updateRow(i, patch)}
                      onRemove={() => removeRow(i)}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={addRow}
                    className="w-full rounded-md border border-dashed border-charcoal-700 py-2 text-xs text-ink-muted hover:border-teal-500/50 hover:text-ink"
                  >
                    ＋ Add a task
                  </button>
                </>
              )}

              {error && <p className="text-sm text-gold-400">{error}</p>}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-charcoal-700 px-5 py-3">
              <p className="text-xs text-ink-dim">
                {rows.filter((r) => r.title.trim()).length} task
                {rows.filter((r) => r.title.trim()).length === 1 ? "" : "s"} ready
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="rounded-md px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirm}
                  disabled={busy || phase === "loading" || rows.filter((r) => r.title.trim()).length === 0}
                  className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
                >
                  {busy ? "Creating…" : `Create ${rows.filter((r) => r.title.trim()).length} tasks`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TaskRow({
  row,
  users,
  onChange,
  onRemove,
}: {
  row: MissionTaskDraft;
  users: UserOption[];
  onChange: (patch: Partial<MissionTaskDraft>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-3">
      <div className="flex items-start gap-2">
        <input
          value={row.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Task title"
          className="flex-1 rounded-md border border-charcoal-700 bg-charcoal-900 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-dim focus:border-teal-500"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove task"
          className="mt-0.5 rounded-md p-1.5 text-ink-dim hover:bg-charcoal-800 hover:text-red-300"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <textarea
        value={row.description}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="Description"
        rows={2}
        className="mt-2 w-full resize-none rounded-md border border-charcoal-700 bg-charcoal-900 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-dim"
      />
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-[11px] text-ink-dim">
          Priority
          <select
            value={row.priority}
            onChange={(e) => onChange({ priority: e.target.value as MissionTaskPriority })}
            className="mt-0.5 w-full rounded-md border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-ink"
          >
            {MISSION_TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-ink-dim">
          Due date
          <input
            type="date"
            value={row.due_date ?? ""}
            onChange={(e) => onChange({ due_date: e.target.value || null })}
            className="mt-0.5 w-full rounded-md border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-ink"
          />
        </label>
        <label className="text-[11px] text-ink-dim">
          Assignee
          <select
            value={row.assignee_id ?? ""}
            onChange={(e) => onChange({ assignee_id: e.target.value || null })}
            className="mt-0.5 w-full rounded-md border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-ink"
          >
            <option value="">
              {row.assignee_hint ? `Unassigned · suggest ${row.assignee_hint}` : "Unassigned"}
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
