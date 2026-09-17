"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS } from "@/lib/tasks/display";
import type { Database, TaskPriority } from "@/types/database";

// Proposes a task for approval. Stands in for the AI assistant's task-generation
// (V1.5): the proposal lands in the queue as pending rather than creating a task
// directly — the human-in-the-loop gate from DECISIONS.md D-005.
export function ProposeApprovalForm({ orgId, userId }: { orgId: string; userId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);

    const payload: Database["public"]["Tables"]["approval_requests"]["Insert"] = {
      org_id: orgId,
      requested_by: userId,
      requested_by_agent: false,
      action_type: "create_task",
      title: title.trim(),
      payload: { title: title.trim(), priority },
      status: "pending",
    };

    const { error: insertError } = await supabase
      .from("approval_requests")
      .insert(payload as never);
    setBusy(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }
    setTitle("");
    setPriority("medium");
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400"
      >
        + Propose a task
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Proposed task title"
        className="mb-3 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500"
      />
      <div className="mb-3 flex items-center gap-3">
        <label className="text-xs text-ink-muted">
          Priority
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
            className="ml-2 rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1 text-sm text-ink"
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {TASK_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="mb-2 text-sm text-gold-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {busy ? "Submitting…" : "Submit for approval"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
