"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideActionRequest } from "@/app/(dashboard)/approvals/actions";
import { CopyButton } from "@/components/outreach/CopyButton";
import { isAutoSendChannel, type OutreachChannel } from "@/lib/outreach/channels";

// APPROVE / REJECT controls for one action_request, with an optional
// decision_note. The whole decision goes through the server action
// decideActionRequest — which flips the row (RLS-gated) and, on approve, runs
// the executor. We render live buttons only when the caller may decide; the
// server action re-checks, so this is purely UX.
//
// For requests that carry an editable message ('log_followup' and Vesper's
// 'send_outreach'), `draftedMessage` is provided: the approver sees the draft in
// an editable textarea and can revise it before approving. The final text is
// passed to the server action and is what gets logged/sent.
//
// For Vesper's copy-paste channels (Viber / DM), `outreachChannel` is set and the
// OS never sends: a copy button is shown, the approve button reads "Mark as
// sent", and approving only LOGS the touch (the human sent it by hand). For the
// email channel, approving actually sends (only if configured).
export function ActionDecision({
  requestId,
  canDecide,
  approverLabel = "CEO / COO",
  draftedMessage = null,
  outreachChannel = null,
  emailConfigured = null,
  recommendationOnly = false,
}: {
  requestId: string;
  canDecide: boolean;
  approverLabel?: string;
  draftedMessage?: string | null;
  outreachChannel?: OutreachChannel | null;
  emailConfigured?: boolean | null;
  // Recommendation-only requests (e.g. the Cognition Loop brief) carry no
  // executor, so approval just acknowledges the recommendation and NOTHING runs.
  // The verbs read "Approve" / "Hold" instead of "Approve & execute" / "Reject".
  recommendationOnly?: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState(draftedMessage ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const isEditable = draftedMessage != null;

  // Copy-paste channels (Viber/DM) are never auto-sent; email is.
  const copyPaste = outreachChannel != null && !isAutoSendChannel(outreachChannel);
  const autoSend = outreachChannel != null && isAutoSendChannel(outreachChannel);

  if (!canDecide) {
    return (
      <p className="mt-3 border-t border-charcoal-700/70 pt-3 text-xs text-ink-muted">
        View only — a cleared approver ({approverLabel}) decides this action.
      </p>
    );
  }

  function decide(decision: "approved" | "rejected") {
    setError(null);
    // A rejection must carry a reason — it's recorded on the audit row.
    if (decision === "rejected" && note.trim() === "") {
      setError(`Add a brief reason to ${recommendationOnly ? "hold" : "reject"} this.`);
      return;
    }
    startTransition(async () => {
      const res = await decideActionRequest(
        requestId,
        decision,
        note,
        isEditable ? message : null
      );
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  }

  // The approve verb depends on what approval actually does.
  const approveLabel = pending
    ? "Working…"
    : copyPaste
      ? "Mark as sent & log"
      : outreachChannel === "email"
        ? "Approve & send email"
        : recommendationOnly
          ? "Approve"
          : "Approve & execute";
  // Recommendation-only briefs "Hold" rather than "Reject" — holding parks the
  // brief without acting; either way nothing auto-executes.
  const rejectLabel = recommendationOnly ? "Hold" : "Reject";

  // The helper line under the textarea, honest about the effect.
  const editableHint = copyPaste
    ? "Approving logs this as sent — copy it first and send it by hand. Nothing is sent automatically."
    : outreachChannel === "email"
      ? emailConfigured === false
        ? "Email is NOT configured — approving will surface a clear error and send nothing until SMTP_/EMAIL_ vars are set."
        : "Approving sends this email (only if an email provider is configured) and logs the touch."
      : "Approving logs this message and reschedules the next touch — nothing is sent externally in v1.";

  return (
    <div className="mt-3 border-t border-charcoal-700/70 pt-3">
      {isEditable && (
        <div className="mb-2">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            {outreachChannel ? "Vesper draft · editable before you decide" : "Drafted follow-up · editable before approval"}
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={7}
            disabled={pending}
            className="w-full resize-y rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-2 text-xs leading-relaxed text-ink placeholder:text-ink-muted focus:border-teal-500 disabled:opacity-60"
          />
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] text-ink-dim">{editableHint}</p>
            {copyPaste && <CopyButton text={message} label="Copy to send" />}
          </div>
        </div>
      )}
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={`Decision note — required to ${recommendationOnly ? "hold" : "reject"}…`}
        disabled={pending}
        className="mb-2 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:border-teal-500 disabled:opacity-60"
      />
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => decide("approved")}
          disabled={pending}
          className="rounded-md bg-green-500/90 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-green-400 disabled:opacity-60"
        >
          {approveLabel}
        </button>
        <button
          onClick={() => decide("rejected")}
          disabled={pending}
          className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink disabled:opacity-60"
        >
          {rejectLabel}
        </button>
      </div>
    </div>
  );
}
