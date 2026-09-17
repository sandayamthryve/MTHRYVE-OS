"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { ProjectStatus } from "@/types/database";
import {
  BOARD_COLUMNS,
  MOVABLE_STATUSES,
  PROJECT_STATUS_LABELS,
  columnAccent,
  formatDate,
} from "@/lib/projects/display";

export type ProjectCard = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  due_date: string | null;
  brand_id: string | null;
  owner_id: string | null;
  department_id: string | null;
};

type Option = { id: string; name: string };

// The Projects Log — Tony's working memory of what the org is doing, made
// visible. A three/four-column board (Working On · Next · Paused · Done) where
// every card can change status (move columns), be edited inline, or be added
// from a column. All reads/writes go through the RLS-scoped browser client, so
// scoping is automatic; nothing here can reach another org's rows.
//
// `showNext` hides the optional "Next" (planned) column. `compact` tightens the
// layout for the /tony side panel vs. the full /projects page.
export function ProjectsLog({
  orgId,
  userId,
  projects: initial,
  brands,
  users,
  departments,
  showNext = true,
  compact = false,
}: {
  orgId: string;
  userId: string;
  projects: ProjectCard[];
  brands: Option[];
  users: Option[];
  departments: Option[];
  showNext?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();

  const [projects, setProjects] = useState<ProjectCard[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingIn, setAddingIn] = useState<ProjectStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const brandName = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);
  const userName = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);

  const columns = BOARD_COLUMNS.filter((c) => showNext || c.status !== "planned");

  async function moveTo(id: string, status: ProjectStatus) {
    setError(null);
    const prev = projects;
    // Optimistic: reflect the move immediately, roll back on failure.
    setProjects((list) => list.map((p) => (p.id === id ? { ...p, status } : p)));
    const { error: err } = await supabase
      .from("projects")
      .update({ status, updated_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (err) {
      setProjects(prev);
      setError(err.message);
    } else {
      router.refresh();
    }
  }

  function upsertLocal(card: ProjectCard) {
    setProjects((list) => {
      const idx = list.findIndex((p) => p.id === card.id);
      if (idx === -1) return [card, ...list];
      const next = [...list];
      next[idx] = card;
      return next;
    });
  }

  return (
    <div>
      {error && (
        <p className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      <div
        className={`grid gap-3 ${
          columns.length >= 4
            ? "sm:grid-cols-2 xl:grid-cols-4"
            : "sm:grid-cols-3"
        }`}
      >
        {columns.map((col) => {
          const accent = columnAccent(col.status);
          const cards = projects.filter((p) => p.status === col.status);
          return (
            <div
              key={col.status}
              className="flex flex-col rounded-lg border border-charcoal-700 bg-charcoal-950/40 p-2"
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${accent.dot}`} />
                  <h3 className={`text-xs font-semibold uppercase tracking-wide ${accent.text}`}>
                    {col.title}
                  </h3>
                  <span className="rounded bg-charcoal-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
                    {cards.length}
                  </span>
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-2">
                {cards.length === 0 && addingIn !== col.status && (
                  <p className="px-1 py-2 text-[11px] text-ink-dim">{col.hint}</p>
                )}

                {cards.map((p) =>
                  editingId === p.id ? (
                    <ProjectForm
                      key={p.id}
                      orgId={orgId}
                      userId={userId}
                      supabase={supabase}
                      brands={brands}
                      users={users}
                      departments={departments}
                      initial={p}
                      onDone={(card) => {
                        if (card) upsertLocal(card);
                        setEditingId(null);
                        router.refresh();
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <ProjectCardView
                      key={p.id}
                      card={p}
                      compact={compact}
                      brandLabel={p.brand_id ? brandName.get(p.brand_id) ?? null : null}
                      ownerLabel={p.owner_id ? userName.get(p.owner_id) ?? null : null}
                      onMove={(status) => moveTo(p.id, status)}
                      onEdit={() => setEditingId(p.id)}
                    />
                  )
                )}

                {addingIn === col.status ? (
                  <ProjectForm
                    orgId={orgId}
                    userId={userId}
                    supabase={supabase}
                    brands={brands}
                    users={users}
                    departments={departments}
                    initial={{
                      id: "",
                      name: "",
                      description: null,
                      status: col.status,
                      due_date: null,
                      brand_id: null,
                      owner_id: userId,
                      department_id: null,
                    }}
                    onDone={(card) => {
                      if (card) upsertLocal(card);
                      setAddingIn(null);
                      router.refresh();
                    }}
                    onCancel={() => setAddingIn(null)}
                  />
                ) : (
                  <button
                    onClick={() => {
                      setEditingId(null);
                      setAddingIn(col.status);
                    }}
                    className="rounded-md border border-dashed border-charcoal-700 px-2 py-1.5 text-left text-[11px] text-ink-muted hover:border-teal-500/50 hover:text-ink"
                  >
                    + Add
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A single project card: name, brand, owner, due date, plus a quick status
// control (move columns) and an edit affordance.
function ProjectCardView({
  card,
  brandLabel,
  ownerLabel,
  compact,
  onMove,
  onEdit,
}: {
  card: ProjectCard;
  brandLabel: string | null;
  ownerLabel: string | null;
  compact: boolean;
  onMove: (status: ProjectStatus) => void;
  onEdit: () => void;
}) {
  return (
    <div className="group rounded-md border border-charcoal-700 bg-charcoal-900 p-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug text-ink">{card.name}</p>
        <button
          onClick={onEdit}
          aria-label={`Edit ${card.name}`}
          className="shrink-0 rounded p-0.5 text-ink-dim opacity-0 transition group-hover:opacity-100 hover:text-teal-400"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {brandLabel && (
          <span className="rounded bg-charcoal-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
            {brandLabel}
          </span>
        )}
        {ownerLabel && (
          <span className="text-[11px] text-ink-muted">{ownerLabel}</span>
        )}
        {card.due_date && (
          <span className="font-mono text-[10px] text-ink-dim">{formatDate(card.due_date)}</span>
        )}
      </div>

      {!compact && card.description && (
        <p className="mt-1.5 line-clamp-2 text-[11px] text-ink-muted">{card.description}</p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <label className="sr-only" htmlFor={`move-${card.id}`}>
          Move {card.name}
        </label>
        <select
          id={`move-${card.id}`}
          value={card.status}
          onChange={(e) => onMove(e.target.value as ProjectStatus)}
          className="w-full rounded border border-charcoal-700 bg-charcoal-950 px-1.5 py-1 text-[11px] text-ink-muted focus:border-teal-500"
        >
          {MOVABLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PROJECT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// Shared add/edit form. When `initial.id` is empty it inserts, otherwise it
// updates. Writes go through the RLS-scoped browser client. On success it hands
// the resulting card back so the board can update without waiting on a refresh.
function ProjectForm({
  orgId,
  userId,
  supabase,
  brands,
  users,
  departments,
  initial,
  onDone,
  onCancel,
}: {
  orgId: string;
  userId: string;
  supabase: ReturnType<typeof createClient>;
  brands: Option[];
  users: Option[];
  departments: Option[];
  initial: ProjectCard;
  onDone: (card: ProjectCard | null) => void;
  onCancel: () => void;
}) {
  const isNew = !initial.id;
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [brandId, setBrandId] = useState(initial.brand_id ?? "");
  const [ownerId, setOwnerId] = useState(initial.owner_id ?? "");
  const [departmentId, setDepartmentId] = useState(initial.department_id ?? "");
  const [dueDate, setDueDate] = useState(initial.due_date ?? "");
  const [status, setStatus] = useState<ProjectStatus>(initial.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const field =
    "w-full rounded border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-dim focus:border-teal-500";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);

    const values = {
      name: name.trim(),
      description: description.trim() || null,
      brand_id: brandId || null,
      owner_id: ownerId || null,
      department_id: departmentId || null,
      due_date: dueDate || null,
      status,
    };

    if (isNew) {
      const { data, error } = await supabase
        .from("projects")
        .insert({ ...values, org_id: orgId, created_by: userId } as never)
        .select("id")
        .single();
      setBusy(false);
      if (error || !data) {
        setErr(error?.message ?? "Could not create project.");
        return;
      }
      onDone({ ...initial, ...values, id: (data as { id: string }).id });
    } else {
      const { error } = await supabase
        .from("projects")
        .update({ ...values, updated_at: new Date().toISOString() } as never)
        .eq("id", initial.id);
      setBusy(false);
      if (error) {
        setErr(error.message);
        return;
      }
      onDone({ ...initial, ...values });
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-md border border-teal-500/40 bg-charcoal-900 p-2.5"
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name"
        className={`${field} mb-2`}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        className={`${field} mb-2`}
      />
      <div className="mb-2 grid grid-cols-2 gap-2">
        <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className={field}>
          <option value="">No brand</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={field}>
          <option value="">No owner</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          className={field}
        >
          <option value="">No department</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className={field}
        />
      </div>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value as ProjectStatus)}
        className={`${field} mb-2`}
      >
        {MOVABLE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {PROJECT_STATUS_LABELS[s]}
          </option>
        ))}
      </select>

      {err && <p className="mb-2 text-[11px] text-red-300">{err}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded bg-teal-500 px-2.5 py-1 text-[12px] font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {busy ? "Saving…" : isNew ? "Add" : "Save"}
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
