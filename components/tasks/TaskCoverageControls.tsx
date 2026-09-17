"use client";

// TaskCoverageControls — Head Cover Mode on the task detail (edit) surface.
//
// Shown ONLY when the viewer may cover this task on the owner's behalf — a
// department head over a member of their own department, or leadership over
// anyone (the server enforces the same rule in /api/tasks/cover, so this panel
// never appears where the action would be refused). It lets the coverer reassign
// the task, change its status, or mark it complete. Every action routes through
// the audited /api/tasks/cover route, which writes an audit_log row and notifies
// the original owner — so a coverer's edits are never silent.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TASK_STATUSES, TASK_STATUS_LABELS } from "@/lib/tasks/display";
import type { TaskStatus } from "@/types/database";

type Option = { id: string; name: string };

type CoverBody =
  | { taskId: string; action: "complete" }
  | { taskId: string; action: "status"; status: TaskStatus }
  | { taskId: string; action: "reassign"; assigneeId: string };

export function TaskCoverageControls({
  taskId,
  status,
  ownerName,
  selfId,
  users,
}: {
  taskId: string;
  status: TaskStatus;
  // The task's current owner (assignee), shown so the coverer knows whose work
  // they're covering.
  ownerName: string;
  // The coverer's own id — offered as "Assign to me".
  selfId: string;
  // Reassignment candidates (org members). The current owner is filtered out.
  users: Option[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function cover(payload: CoverBody) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/tasks/cover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; summary?: string; error?: string }
        | null;
      if (!res.ok || !json?.ok) {
        setNote(json?.error ? `Couldn't cover — ${json.error}.` : "Couldn't cover — please try again.");
        setBusy(false);
        return;
      }
      setNote(json.summary ? `Done — ${json.summary}. Owner notified.` : "Done. Owner notified.");
      router.refresh();
    } catch {
      setNote("Couldn't reach the server — please try again.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted">
        Covering <span className="font-medium text-ink">{ownerName}</span>. Every action is audited
        and the owner is notified.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || status === "done"}
          onClick={() => cover({ taskId, action: "complete" })}
          className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {status === "done" ? "Completed" : "Mark complete"}
        </button>
      </div>

      <label className="block text-xs text-ink-muted">
        Change status
        <select
          disabled={busy}
          value={status}
          onChange={(e) => cover({ taskId, action: "status", status: e.target.value as TaskStatus })}
          className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-ink-muted">
        Reassign to
        <select
          disabled={busy}
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) cover({ taskId, action: "reassign", assigneeId: v });
          }}
          className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
        >
          <option value="">Pick a teammate…</option>
          <option value={selfId}>Me</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>

      {note && <p className="text-xs text-ink-muted">{note}</p>}
    </div>
  );
}
