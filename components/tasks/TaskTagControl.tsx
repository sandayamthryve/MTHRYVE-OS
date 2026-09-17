"use client";

// TaskTagControl — Snap-Tag on the task detail (edit) surface. Shown to
// leadership / department heads only. It lists who's currently tagged and lets
// the caller add more teammates; picking a set and pressing "Tag & notify"
// writes task_tags and fans out the three notify channels via the shared
// /api/tasks/snap-tag route. Add-only by design — the same route the create
// form uses, so create and edit tag identically.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TagUsersField } from "@/components/tasks/TagUsersField";

type Option = { id: string; name: string };

export function TaskTagControl({
  taskId,
  users,
  taggedUserIds,
  creatorId,
}: {
  taskId: string;
  users: Option[];
  taggedUserIds: string[];
  // The task creator — never offered as a tag target (they're never notified).
  creatorId: string | null;
}) {
  const router = useRouter();
  const tagged = new Set(taggedUserIds);
  // Candidates: org teammates not already tagged, and not the creator.
  const candidates = users.filter((u) => !tagged.has(u.id) && u.id !== creatorId);

  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function submit() {
    if (pick.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/tasks/snap-tag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, userIds: pick }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; tagged?: number } | null;
      if (!res.ok || !json?.ok) {
        setNote("Couldn't tag — please try again.");
        setBusy(false);
        return;
      }
      setNote(json.tagged ? `Tagged ${json.tagged} · notified.` : "Already tagged.");
      setPick([]);
      router.refresh();
    } catch {
      setNote("Couldn't reach the server — please try again.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <TagUsersField
        users={candidates}
        value={pick}
        onChange={setPick}
        label="Add teammates"
        hint="Tagged teammates get an in-app bell, an email, and a Telegram group ping."
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || pick.length === 0}
          className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {busy ? "Tagging…" : "Tag & notify"}
        </button>
        {note && <span className="text-xs text-ink-muted">{note}</span>}
      </div>
    </div>
  );
}
