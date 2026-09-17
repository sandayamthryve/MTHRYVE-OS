"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { STAGES, STAGE_LABEL, type Stage } from "@/lib/outreach/leads";

// The pipeline kanban for BizDev Outreach. One column per stage; each card can
// be moved by drag-and-drop across columns OR by the per-card dropdown (the
// accessible / no-drag fallback). Both paths call the moveLeadStage server
// action, then refresh so the server-rendered tiles and follow-ups stay in
// sync. Cards the viewer can't edit (not leadership, not the owner) render
// read-only — no drag handle, disabled dropdown.

export type BoardCard = {
  id: string;
  name: string;
  company: string | null;
  valueLabel: string; // pre-formatted peso, or "—"
  owner: string; // owner full name, or "Unassigned"
  nextActionDate: string | null; // "YYYY-MM-DD" or null
  nextActionOverdue: boolean;
  stage: Stage; // normalized
  canEdit: boolean;
};

const STAGE_ACCENT: Record<Stage, string> = {
  new: "border-t-charcoal-700",
  contacted: "border-t-violet-500/70",
  replied: "border-t-sky-500/70",
  meeting: "border-t-amber-500/70",
  proposal: "border-t-gold-500/70",
  won: "border-t-teal-500/80",
  lost: "border-t-red-500/70",
};

function fmtDate(d: string): string {
  // "YYYY-MM-DD" → "Jul 12" without constructing a timezone-shifted Date.
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = Number(m[2]) - 1;
  return `${months[mi] ?? m[2]} ${Number(m[3])}`;
}

export function PipelineBoard({
  cards: cardsProp,
  move,
}: {
  cards: BoardCard[];
  move: (id: string, stage: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [cards, setCards] = useState<BoardCard[]>(cardsProp);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local state whenever the server sends a fresh board (after refresh).
  const sig = useMemo(
    () => cardsProp.map((c) => `${c.id}:${c.stage}`).join("|"),
    [cardsProp]
  );
  const lastSig = useRef(sig);
  useEffect(() => {
    if (lastSig.current !== sig) {
      lastSig.current = sig;
      setCards(cardsProp);
    }
  }, [sig, cardsProp]);

  const byStage = useMemo(() => {
    const map: Record<Stage, BoardCard[]> = {
      new: [], contacted: [], replied: [], meeting: [], proposal: [], won: [], lost: [],
    };
    for (const c of cards) map[c.stage].push(c);
    return map;
  }, [cards]);

  function applyMove(id: string, stage: Stage) {
    const card = cards.find((c) => c.id === id);
    if (!card || card.stage === stage || !card.canEdit) return;
    const prev = cards;
    // Optimistic: move the card immediately, reconcile on the server round-trip.
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, stage } : c)));
    setError(null);
    startTransition(async () => {
      const res = await move(id, stage);
      if (!res.ok) {
        setCards(prev); // revert
        setError(res.error ?? "Move failed");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      {error && (
        <p className="mb-2 text-xs text-red-300">{error}</p>
      )}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map((stage) => {
          const list = byStage[stage];
          const colValue = list.length;
          const isOver = overStage === stage;
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                if (overStage !== stage) setOverStage(stage);
              }}
              onDragLeave={(e) => {
                // Only clear when leaving the column, not when moving over a child.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setOverStage((s) => (s === stage ? null : s));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain") || dragId;
                setOverStage(null);
                setDragId(null);
                if (id) applyMove(id, stage);
              }}
              className={`flex w-64 shrink-0 flex-col rounded-xl border bg-charcoal-900/60 ${
                isOver ? "border-teal-500/60 bg-charcoal-800/60" : "border-charcoal-700/60"
              }`}
            >
              <div className="flex items-center justify-between border-b border-charcoal-700/60 px-3 py-2">
                <span className="text-sm font-semibold text-ink">{STAGE_LABEL[stage]}</span>
                <span className="rounded-full bg-charcoal-800 px-2 py-0.5 font-mono text-[10px] text-ink-muted">
                  {colValue}
                </span>
              </div>
              <div className="flex min-h-[4rem] flex-col gap-2 p-2">
                {list.length === 0 && (
                  <p className="px-1 py-3 text-center text-[11px] text-ink-dim">Drop here</p>
                )}
                {list.map((c) => (
                  <div
                    key={c.id}
                    draggable={c.canEdit}
                    onDragStart={(e) => {
                      if (!c.canEdit) return;
                      e.dataTransfer.setData("text/plain", c.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragId(c.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverStage(null);
                    }}
                    className={`rounded-lg border border-charcoal-700/70 border-t-2 bg-charcoal-950 p-2.5 shadow-sm ${
                      STAGE_ACCENT[c.stage]
                    } ${c.canEdit ? "cursor-grab active:cursor-grabbing" : "opacity-90"} ${
                      dragId === c.id ? "opacity-50" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/outreach/${c.id}`}
                        className="text-sm font-medium text-ink hover:text-teal-300"
                      >
                        {c.name}
                      </Link>
                      <span className="shrink-0 font-mono text-[11px] text-teal-300">{c.valueLabel}</span>
                    </div>
                    {c.company && <p className="truncate text-[11px] text-ink-muted">{c.company}</p>}
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <span className="truncate text-[11px] text-ink-dim">{c.owner}</span>
                      {c.nextActionDate && (
                        <span
                          className={`shrink-0 font-mono text-[10px] ${
                            c.nextActionOverdue ? "text-amber-300" : "text-ink-dim"
                          }`}
                          title="Next action date"
                        >
                          ⏱ {fmtDate(c.nextActionDate)}
                        </span>
                      )}
                    </div>
                    <select
                      aria-label={`Move ${c.name} to another stage`}
                      value={c.stage}
                      disabled={!c.canEdit || isPending}
                      onChange={(e) => applyMove(c.id, e.target.value as Stage)}
                      className="mt-2 w-full rounded-md border border-charcoal-700 bg-charcoal-900 p-1 text-[11px] text-ink-muted disabled:opacity-50"
                    >
                      {STAGES.map((s) => (
                        <option key={s} value={s}>
                          {STAGE_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
