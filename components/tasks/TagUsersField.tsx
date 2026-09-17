"use client";

// TagUsersField — a compact, controlled multi-select of teammates, used by
// Snap-Tag on task create (NewTaskForm) and task edit (TaskTagControl). It's a
// scrollable checkbox list rather than a native <select multiple> so the picked
// set is obvious and touch-friendly. Purely presentational — the caller owns the
// selected ids and decides when to write them.

type Option = { id: string; name: string };

export function TagUsersField({
  users,
  value,
  onChange,
  label = "Tag teammates",
  hint,
}: {
  users: Option[];
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  hint?: string;
}) {
  const selected = new Set(value);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  }

  return (
    <div className="text-xs text-ink-muted">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        {selected.size > 0 && <span className="text-teal-300">{selected.size} selected</span>}
      </div>
      {users.length === 0 ? (
        <p className="mt-1 rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-ink-muted">
          No teammates to tag.
        </p>
      ) : (
        <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-md border border-charcoal-700 bg-charcoal-950 p-2">
          {users.map((u) => (
            <label
              key={u.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm text-ink hover:bg-charcoal-800"
            >
              <input
                type="checkbox"
                checked={selected.has(u.id)}
                onChange={() => toggle(u.id)}
                className="h-3.5 w-3.5 accent-teal-500"
              />
              {u.name}
            </label>
          ))}
        </div>
      )}
      {hint && <p className="mt-1 text-[11px] text-ink-dim">{hint}</p>}
    </div>
  );
}
