"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

// Adds a comment to a task. author_id must equal auth.uid() (enforced by RLS),
// so we pass the current user's id and the check re-validates it server-side.
export function CommentForm({ taskId, userId }: { taskId: string; userId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);

    const payload: Database["public"]["Tables"]["task_comments"]["Insert"] = {
      task_id: taskId,
      author_id: userId,
      body: body.trim(),
    };

    // payload is type-checked above; `as never` sidesteps the @supabase/ssr
    // client resolving .insert()'s parameter to never[].
    const { error: insertError } = await supabase.from("task_comments").insert(payload as never);
    setBusy(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }
    setBody("");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a comment…"
        rows={3}
        className="w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500"
      />
      {error && <p className="mt-1 text-sm text-gold-400">{error}</p>}
      <button
        type="submit"
        disabled={busy || !body.trim()}
        className="mt-2 rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
      >
        {busy ? "Posting…" : "Comment"}
      </button>
    </form>
  );
}
