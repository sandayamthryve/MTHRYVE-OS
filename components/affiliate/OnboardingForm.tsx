"use client";

// Onboarding intake. Upserts creator_onboarding keyed on (org_id, creator_id):
// choosing a creator who already has a profile prefills every field so the form
// edits in place instead of starting blank. "Mark complete" is honoured only
// when the required fields are actually present — the server re-checks and
// reports back inline what's still missing, so a checked box can never mark an
// incomplete profile complete.

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { OnboardingState } from "@/app/(dashboard)/affiliate/actions";

const fieldCls =
  "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

type Option = { value: string; label: string };

export type OnboardingRecord = {
  creator_id: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  platform_links: Record<string, string> | null;
  preferred_schedule: string | null;
  shipping_details: string | null;
  complete: boolean | null;
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save onboarding"}
    </button>
  );
}

export function OnboardingForm({
  action,
  creators,
  existing,
}: {
  action: (prev: OnboardingState, formData: FormData) => Promise<OnboardingState>;
  creators: readonly Option[];
  existing: readonly OnboardingRecord[];
}) {
  const [state, formAction] = useFormState(action, null);
  const byCreator = useMemo(
    () => new Map(existing.map((r) => [r.creator_id, r])),
    [existing]
  );

  const [creatorId, setCreatorId] = useState("");
  const [f, setF] = useState<OnboardingRecord | null>(null);

  function pick(id: string) {
    setCreatorId(id);
    setF(byCreator.get(id) ?? null);
  }

  const links = f?.platform_links ?? {};

  return (
    <form action={formAction} className="grid gap-3">
      <label className="text-xs text-ink-muted">
        Creator
        <select
          name="creator_id"
          required
          value={creatorId}
          onChange={(e) => pick(e.target.value)}
          className={`mt-1 ${fieldCls}`}
        >
          <option value="" disabled>
            Choose a creator…
          </option>
          {creators.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
              {byCreator.get(c.value)?.complete ? " ✓" : ""}
            </option>
          ))}
        </select>
      </label>

      {/* key forces the inputs to remount with fresh defaults when the creator
          changes, so switching creators reliably reloads their saved values. */}
      <div key={creatorId} className="grid gap-3 sm:grid-cols-2">
        <input name="email" type="email" placeholder="Email *" defaultValue={f?.email ?? ""} className={fieldCls} />
        <input name="phone" placeholder="Phone *" defaultValue={f?.phone ?? ""} className={fieldCls} />
        <input name="address" placeholder="Address *" defaultValue={f?.address ?? ""} className={`${fieldCls} sm:col-span-2`} />
        <input name="link_tiktok" placeholder="TikTok link" defaultValue={links.tiktok ?? ""} className={fieldCls} />
        <input name="link_instagram" placeholder="Instagram link" defaultValue={links.instagram ?? ""} className={fieldCls} />
        <input name="link_facebook" placeholder="Facebook link" defaultValue={links.facebook ?? ""} className={fieldCls} />
        <input name="link_youtube" placeholder="YouTube link" defaultValue={links.youtube ?? ""} className={fieldCls} />
        <input name="link_other" placeholder="Other link" defaultValue={links.other ?? ""} className={`${fieldCls} sm:col-span-2`} />
        <input name="preferred_schedule" placeholder="Preferred schedule" defaultValue={f?.preferred_schedule ?? ""} className={fieldCls} />
        <input name="shipping_details" placeholder="Shipping details *" defaultValue={f?.shipping_details ?? ""} className={fieldCls} />
      </div>

      <p className="text-[11px] text-ink-dim">
        Required for completion (*): email, phone, address, shipping details, and at least one
        platform link.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input type="checkbox" name="mark_complete" className="h-4 w-4 rounded border-charcoal-700 bg-charcoal-950" />
          Mark complete
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input type="checkbox" name="advance_onboarded" className="h-4 w-4 rounded border-charcoal-700 bg-charcoal-950" />
          {/* The deck calls this step migrating the creator into the creator
              community. Same action, the team's word for it — the stored value
              is unchanged. */}
          Migrate to the creator community (on complete)
        </label>
      </div>

      {state?.error && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="rounded-md border border-teal-500/30 bg-teal-500/5 p-2.5 text-xs text-teal-200">
          {state.ok}
        </p>
      )}

      <div>
        <SubmitButton />
      </div>
    </form>
  );
}
