"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideGovernedDeletion } from "@/app/(dashboard)/approvals/governance-actions";

// APPROVE / REJECT for one stage of a governed permanent-delete (COO stage 1 or
// CEO stage 2). The server action re-checks the stage→role gate and walks the
// chain — this is purely the decision surface, rendered only for the officer
// whose turn it actually is. `stage` just tunes the copy so the officer knows
// exactly what their approval does.
export function GovernedDecision({
  requestId,
  stage,
}: {
  requestId: string;
  stage: "coo" | "ceo";
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function decide(decision: "approved" | "rejected") {
    setError(null);
    startTransition(async () => {
      const res = await decideGovernedDeletion(requestId, decision, note);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  }

  // The CEO's approval is the one that actually deletes; the COO's only advances
  // the chain — the verbs say so.
  const approveLabel = pending
    ? "Working…"
    : stage === "ceo"
      ? "Approve & delete"
      : "Approve → send to CEO";

  return (
    <div className="mt-3 border-t border-charcoal-700/70 pt-3">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional decision note…"
        disabled={pending}
        className="mb-2 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:border-teal-500 disabled:opacity-60"
      />
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => decide("approved")}
          disabled={pending}
          className="rounded-md bg-red-500/90 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-red-400 disabled:opacity-60"
        >
          {approveLabel}
        </button>
        <button
          onClick={() => decide("rejected")}
          disabled={pending}
          className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink disabled:opacity-60"
        >
          Reject
        </button>
      </div>
      {stage === "ceo" && (
        <p className="mt-1.5 text-[10px] text-ink-dim">
          Approving runs the delete immediately and permanently — this can’t be undone.
        </p>
      )}
    </div>
  );
}
