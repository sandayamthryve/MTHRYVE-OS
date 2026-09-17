"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export type MemoryItem = {
  id: string;
  category: string;
  content: string;
  pinned: boolean;
  source: string | null;
  updated_at: string;
};

// Suggested categories (free text is still allowed via the input). These are
// the buckets the panel groups by; anything else falls under its own heading.
const SUGGESTED_CATEGORIES = ["fact", "decision", "preference", "person", "process", "goal"];

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Tony Memory — the org's durable, human-curated facts, made visible. Pinned
// items float to the top of each category; everything else is ordered by most
// recently touched. A "Remember this" quick-add drops a fact in one line;
// each item can be pinned/unpinned, edited, or (for leadership) deleted. Every
// read/write is RLS-scoped by the browser client, so the org boundary and the
// leadership-only delete policy are enforced in Postgres, not here — `canDelete`
// only decides whether to show the affordance.
export function TonyMemoryPanel({
  orgId,
  userId,
  canDelete,
  memories: initial,
}: {
  orgId: string;
  userId: string;
  canDelete: boolean;
  memories: MemoryItem[];
}) {
  const router = useRouter();
  const supabase = createClient();

  const [memories, setMemories] = useState<MemoryItem[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Group by category; within a category, pinned first, then most-recent.
  const grouped = useMemo(() => {
    const byCat = new Map<string, MemoryItem[]>();
    for (const m of memories) {
      const key = (m.category || "fact").toLowerCase();
      const list = byCat.get(key) ?? [];
      list.push(m);
      byCat.set(key, list);
    }
    for (const list of byCat.values()) {
      list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updated_at.localeCompare(a.updated_at);
      });
    }
    // Categories that have any pinned item sort first, then alphabetically.
    return Array.from(byCat.entries()).sort((a, b) => {
      const aPinned = a[1].some((m) => m.pinned);
      const bPinned = b[1].some((m) => m.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });
  }, [memories]);

  function upsertLocal(item: MemoryItem) {
    setMemories((list) => {
      const idx = list.findIndex((m) => m.id === item.id);
      if (idx === -1) return [item, ...list];
      const next = [...list];
      next[idx] = item;
      return next;
    });
  }

  async function togglePin(item: MemoryItem) {
    setError(null);
    const pinned = !item.pinned;
    upsertLocal({ ...item, pinned });
    const { error: err } = await supabase
      .from("tony_memory")
      .update({ pinned, updated_at: new Date().toISOString() } as never)
      .eq("id", item.id);
    if (err) {
      upsertLocal(item); // roll back
      setError(err.message);
    } else {
      router.refresh();
    }
  }

  async function remove(item: MemoryItem) {
    if (!window.confirm("Delete this memory? This can't be undone.")) return;
    setError(null);
    const prev = memories;
    setMemories((list) => list.filter((m) => m.id !== item.id));
    const { error: err } = await supabase.from("tony_memory").delete().eq("id", item.id);
    if (err) {
      setMemories(prev);
      setError(err.message);
    } else {
      router.refresh();
    }
  }

  return (
    <div>
      <QuickAdd
        orgId={orgId}
        userId={userId}
        supabase={supabase}
        onAdded={(item) => {
          upsertLocal(item);
          router.refresh();
        }}
      />

      {error && (
        <p className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {memories.length === 0 ? (
        <p className="mt-4 rounded-md border border-charcoal-700 bg-charcoal-950/40 px-3 py-4 text-xs text-ink-muted">
          No memories yet. Add a durable fact above — a decision you made, a
          preference, a person, anything Tony should remember.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {grouped.map(([category, items]) => (
            <div key={category}>
              <h3 className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-dim">
                {titleCase(category)}
                <span className="rounded bg-charcoal-800 px-1.5 py-0.5 text-ink-muted">
                  {items.length}
                </span>
              </h3>
              <ul className="space-y-1.5">
                {items.map((m) =>
                  editingId === m.id ? (
                    <li key={m.id}>
                      <MemoryForm
                        supabase={supabase}
                        initial={m}
                        onDone={(item) => {
                          if (item) upsertLocal(item);
                          setEditingId(null);
                          router.refresh();
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    </li>
                  ) : (
                    <li
                      key={m.id}
                      className="group flex items-start gap-2 rounded-md border border-charcoal-700 bg-charcoal-900 px-2.5 py-2"
                    >
                      <button
                        onClick={() => togglePin(m)}
                        aria-label={m.pinned ? "Unpin" : "Pin"}
                        title={m.pinned ? "Unpin" : "Pin"}
                        className={`mt-0.5 shrink-0 ${
                          m.pinned ? "text-gold-400" : "text-ink-dim hover:text-ink-muted"
                        }`}
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill={m.pinned ? "currentColor" : "none"}
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 17v5M9 10.76V6a3 3 0 0 1 6 0v4.76a2 2 0 0 0 .49 1.32l1.4 1.6A1 1 0 0 1 16.14 15H7.86a1 1 0 0 1-.75-1.66l1.4-1.6A2 2 0 0 0 9 10.76Z" />
                        </svg>
                      </button>
                      <p className="min-w-0 flex-1 text-[12px] leading-snug text-ink">{m.content}</p>
                      <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={() => setEditingId(m.id)}
                          aria-label="Edit memory"
                          className="rounded p-0.5 text-ink-dim hover:text-teal-400"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                          </svg>
                        </button>
                        {canDelete && (
                          <button
                            onClick={() => remove(m)}
                            aria-label="Delete memory"
                            className="rounded p-0.5 text-ink-dim hover:text-red-300"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </li>
                  )
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The "Remember this" one-line quick-add. Content + a category picker; adds a
// durable fact tagged as manually curated.
function QuickAdd({
  orgId,
  userId,
  supabase,
  onAdded,
}: {
  orgId: string;
  userId: string;
  supabase: ReturnType<typeof createClient>;
  onAdded: (item: MemoryItem) => void;
}) {
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("fact");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = content.trim();
    if (!body) return;
    setBusy(true);
    setErr(null);
    const cat = category.trim().toLowerCase() || "fact";
    const { data, error } = await supabase
      .from("tony_memory")
      .insert({
        org_id: orgId,
        content: body,
        category: cat,
        source: "manual",
        created_by: userId,
      } as never)
      .select("id, updated_at")
      .single();
    setBusy(false);
    if (error || !data) {
      setErr(error?.message ?? "Could not save.");
      return;
    }
    const row = data as { id: string; updated_at: string };
    onAdded({
      id: row.id,
      category: cat,
      content: body,
      pinned: false,
      source: "manual",
      updated_at: row.updated_at,
    });
    setContent("");
    setCategory("fact");
  }

  const field =
    "rounded border border-charcoal-700 bg-charcoal-950 px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-dim focus:border-teal-500";

  return (
    <form onSubmit={submit} className="rounded-md border border-charcoal-700 bg-charcoal-950/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Remember this…"
          className={`${field} min-w-[12rem] flex-1`}
        />
        <input
          list="tony-memory-categories"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="category"
          className={`${field} w-28`}
        />
        <datalist id="tony-memory-categories">
          {SUGGESTED_CATEGORIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <button
          type="submit"
          disabled={busy || !content.trim()}
          className="rounded bg-teal-500 px-3 py-1.5 text-[12px] font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Remember"}
        </button>
      </div>
      {err && <p className="mt-1.5 text-[11px] text-red-300">{err}</p>}
    </form>
  );
}

// Inline edit form for one memory (content + category).
function MemoryForm({
  supabase,
  initial,
  onDone,
  onCancel,
}: {
  supabase: ReturnType<typeof createClient>;
  initial: MemoryItem;
  onDone: (item: MemoryItem | null) => void;
  onCancel: () => void;
}) {
  const [content, setContent] = useState(initial.content);
  const [category, setCategory] = useState(initial.category);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const field =
    "w-full rounded border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-dim focus:border-teal-500";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = content.trim();
    if (!body) return;
    setBusy(true);
    setErr(null);
    const cat = category.trim().toLowerCase() || "fact";
    const { error } = await supabase
      .from("tony_memory")
      .update({ content: body, category: cat, updated_at: new Date().toISOString() } as never)
      .eq("id", initial.id);
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onDone({ ...initial, content: body, category: cat });
  }

  return (
    <form onSubmit={submit} className="rounded-md border border-teal-500/40 bg-charcoal-900 p-2.5">
      <textarea
        autoFocus
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
        className={`${field} mb-2`}
      />
      <div className="mb-2 flex items-center gap-2">
        <input
          list="tony-memory-categories"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="category"
          className={`${field} w-32`}
        />
      </div>
      {err && <p className="mb-2 text-[11px] text-red-300">{err}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !content.trim()}
          className="rounded bg-teal-500 px-2.5 py-1 text-[12px] font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-[12px] text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
