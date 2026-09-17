"use client";

// Vesper Reach → INBOUND REPLY. Paste a creator's incoming message, pick who sent
// it and the channel, and Vesper drafts a tone-matched reply grounded ONLY in that
// creator's real context (status / stage / notes). Saved as status='draft' — the
// human still reviews, edits and approves before anything goes out.

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { CHANNEL_LABEL, OUTREACH_CHANNELS, type OutreachChannel } from "@/lib/affiliate/domain";
import type { VesperDraftState } from "@/app/(dashboard)/affiliate/vesper-actions";

const fieldCls = "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

type CreatorOption = { value: string; label: string };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-violet-500/90 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
    >
      {pending ? "Vesper is drafting…" : "Draft a reply with Vesper"}
    </button>
  );
}

export function VesperReplyForm({
  action,
  creators,
}: {
  action: (prev: VesperDraftState, formData: FormData) => Promise<VesperDraftState>;
  creators: readonly CreatorOption[];
}) {
  const [state, formAction] = useFormState(action, null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);

  return (
    <form ref={ref} action={formAction} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          Creator who messaged
          <select name="creator_id" required defaultValue="" className={`mt-1 ${fieldCls}`}>
            <option value="" disabled>
              Choose a creator…
            </option>
            {creators.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Reply channel
          <select name="channel" defaultValue="tiktok_dm" className={`mt-1 ${fieldCls}`}>
            {OUTREACH_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="text-xs text-ink-muted">
        Their incoming message
        <textarea
          name="incoming_message"
          required
          rows={4}
          placeholder="Paste exactly what the creator sent you…"
          className={`mt-1 ${fieldCls}`}
        />
      </label>

      <p className="rounded-md border border-charcoal-700 bg-charcoal-850 p-2.5 text-[11px] text-ink-muted">
        Vesper mirrors their tone and answers the question — but never quotes a price, rate, or promise that isn&apos;t
        on file; it leaves a [bracketed] placeholder for you to fill. The reply saves as a draft to review below.
      </p>

      {state?.error && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">{state.error}</p>
      )}
      {state?.ok && (
        <p className="rounded-md border border-teal-500/30 bg-teal-500/5 p-2.5 text-xs text-teal-200">{state.ok}</p>
      )}

      <div>
        <SubmitButton />
      </div>
    </form>
  );
}
