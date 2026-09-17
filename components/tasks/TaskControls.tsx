"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
} from "@/lib/tasks/display";
import type { Database, TaskStatus, TaskPriority } from "@/types/database";

type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"];

type Option = { id: string; name: string };

// Inline controls on the task detail page. Each change writes immediately via
// the browser client (RLS-guarded) and refreshes the server component so the
// rest of the page stays consistent.
export function TaskControls({
  taskId,
  status,
  priority,
  assigneeId,
  users,
  canReassign = true,
}: {
  taskId: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  users: Option[];
  // Whether the viewer may change the assignee. Reassigning SOMEONE ELSE's task
  // is coverage — routed through the audited /api/tasks/cover panel — so here we
  // only allow it for the task's own owner (and leadership on their own task).
  // When false the assignee is shown read-only, never as an editable control.
  canReassign?: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();
  const [busy, setBusy] = useState(false);

  async function patch(fields: TaskUpdate) {
    setBusy(true);
    // fields is typed as TaskUpdate; `as never` sidesteps the @supabase/ssr
    // client resolving .update()'s parameter to never.
    await supabase.from("tasks").update(fields as never).eq("id", taskId);
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <label className="text-xs text-ink-muted">
        Status
        <select
          disabled={busy}
          value={status}
          onChange={(e) => patch({ status: e.target.value as TaskStatus })}
          className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs text-ink-muted">
        Priority
        <select
          disabled={busy}
          value={priority}
          onChange={(e) => patch({ priority: e.target.value as TaskPriority })}
          className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {TASK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs text-ink-muted">
        Assignee
        {canReassign ? (
          <select
            disabled={busy}
            value={assigneeId ?? ""}
            onChange={(e) => patch({ assignee_id: e.target.value || null })}
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink-muted">
            {assigneeId ? users.find((u) => u.id === assigneeId)?.name ?? "Assigned" : "Unassigned"}
          </p>
        )}
      </label>
    </div>
  );
}
