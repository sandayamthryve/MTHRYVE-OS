"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import {
  proposeAutomation,
  keepHuman,
  dismissPattern,
} from "@/app/(dashboard)/automation-radar/actions";

// The row actions for one pattern: "Propose automation" (→ pending action_request),
// "Keep human", "Dismiss". Nothing executes — propose only drafts an approval.
// A client island so the buttons can show a pending state; the real gate is RLS +
// the DB guard trigger (team members act on their own department only).

function SubmitButton({
  children,
  tone = "muted",
  title,
}: {
  children: React.ReactNode;
  tone?: "teal" | "muted" | "danger";
  title?: string;
}) {
  const { pending } = useFormStatus();
  const toneClass =
    tone === "teal"
      ? "border-teal-500/40 bg-teal-500/10 text-teal-200 hover:bg-teal-500/20"
      : tone === "danger"
        ? "border-charcoal-700 bg-charcoal-900 text-ink-dim hover:border-red-500/40 hover:text-red-300"
        : "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:bg-charcoal-800 hover:text-ink";
  return (
    <button
      type="submit"
      disabled={pending}
      title={title}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${toneClass}`}
    >
      {pending ? "…" : children}
    </button>
  );
}

export function RadarRowActions({
  patternId,
  status,
  automatability,
}: {
  patternId: string;
  status: string;
  automatability: string | null;
}) {
  // Once dismissed or already automated there's nothing left to do here.
  const [done] = useState(status === "dismissed" || status === "automated");
  if (done) {
    return <span className="text-xs text-ink-dim">No actions</span>;
  }

  const canPropose = automatability !== "keep_human";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canPropose && (
        <form action={proposeAutomation}>
          <input type="hidden" name="pattern_id" value={patternId} />
          <SubmitButton tone="teal" title="File a pending approval — nothing runs until a leader approves">
            {status === "proposed" ? "Re-propose" : "Propose automation"}
          </SubmitButton>
        </form>
      )}
      {automatability !== "keep_human" && (
        <form action={keepHuman}>
          <input type="hidden" name="pattern_id" value={patternId} />
          <SubmitButton title="Flag as needing a human each run">Keep human</SubmitButton>
        </form>
      )}
      <form action={dismissPattern}>
        <input type="hidden" name="pattern_id" value={patternId} />
        <SubmitButton tone="danger" title="Not worth automating — hide from the radar">
          Dismiss
        </SubmitButton>
      </form>
    </div>
  );
}
