"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

// Minimal inline form to add a subtask under a parent task. Inherits org and
// project from the parent so subtasks stay grouped correctly.
export function AddSubtaskForm({
  orgId,
  userId,
  parentTaskId,
  projectId,
}: {
  orgId: string;
  userId: string;
  parentTaskId: string;
  projectId: string | null;
}) {
  const router = useRouter();
  const supabase = createClient();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);

    const payload: Database["public"]["Tables"]["tasks"]["Insert"] = {
      org_id: orgId,
      parent_task_id: parentTaskId,
      project_id: projectId,
      title: title.trim(),
      status: "todo",
      priority: "medium",
      created_by: userId,
    };

    // payload is type-checked above; `as never` sidesteps the @supabase/ssr
    // client resolving .insert()'s parameter to never[].
    await supabase.from("tasks").insert(payload as never);
    setBusy(false);
    setTitle("");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex items-center gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a subtask…"
        className="flex-1 rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500"
      />
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink disabled:opacity-60"
      >
        Add
      </button>
    </form>
  );
}
