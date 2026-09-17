"use client";

// "Notify team" composer for the Command Center right rail. A textarea + button
// wired to the notifyTeam server action (passed down as a prop so the action
// stays co-located in the page). The inline result — sent / failed — is
// surfaced via useFormState. Mirrors the CSV import islands' pattern.

import { useFormState, useFormStatus } from "react-dom";

export type NotifyTeamState = { ok: boolean; message: string } | null;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Sending…" : "Send to Telegram"}
    </button>
  );
}

export function NotifyTeamControl({
  action,
}: {
  action: (prev: NotifyTeamState, formData: FormData) => Promise<NotifyTeamState>;
}) {
  const [state, formAction] = useFormState(action, null);

  return (
    <form action={formAction} className="space-y-3">
      <textarea
        name="message"
        rows={3}
        placeholder="Message the team group…"
        className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500"
      />
      <div className="flex items-center justify-between gap-3">
        <SubmitButton />
        {state && (
          <p className={`text-sm ${state.ok ? "text-teal-300" : "text-gold-400"}`}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
