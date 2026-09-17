"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { type ModelTier, TIER_LABEL } from "@/lib/ai/models";

// Requests a higher AI model tier for a specific task (DECISIONS.md D-012). The
// request lands in the approval queue as action_type = 'model_access'; on
// approval, decide_approval() (migration 0016) mints a single-use grant for the
// requester. Only CEO/COO can decide these — enforced in the RPC, not here.
//
// Mirrors ProposeApprovalForm: same queue, same insert pattern, same
// `as never` cast for the @supabase/ssr write-payload typing quirk.
export function RequestModelAccessForm({
  orgId,
  userId,
  tier,
  onDone,
}: {
  orgId: string;
  userId: string;
  tier: ModelTier;
  onDone?: () => void;
}) {
  const supabase = createClient();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!reason.trim()) {
      setError("Add a short reason so CEO/COO can decide.");
      return;
    }
    setBusy(true);
    setError(null);

    const payload = {
      org_id: orgId,
      requested_by: userId,
      requested_by_agent: false,
      action_type: "model_access",
      title: `Model access — ${TIER_LABEL[tier]}`,
      payload: { tier, reason: reason.trim() },
      status: "pending",
    };

    const { error: insertError } = await supabase
      .from("approval_requests")
      .insert(payload as never);
    setBusy(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }
    setSent(true);
    onDone?.();
  }

  if (sent) {
    return (
      <div className="rounded-lg border border-teal-500/40 bg-teal-500/10 p-3 text-sm text-ink">
        Request sent to CEO/COO for {TIER_LABEL[tier]}. You&apos;ll get a single-use
        grant once it&apos;s approved — then pick that tier again and send.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-3">
      <p className="mb-2 text-xs text-ink-muted">
        <span className="font-medium text-ink">{TIER_LABEL[tier]}</span> is above your
        default tier. Send a one-task access request to CEO/COO.
      </p>
      <textarea
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="Why this task needs the stronger model…"
        className="w-full resize-none rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500"
      />
      {error && <p className="mt-2 text-sm text-gold-400">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || !reason.trim()}
          className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {busy ? "Sending…" : "Request access"}
        </button>
      </div>
    </div>
  );
}
