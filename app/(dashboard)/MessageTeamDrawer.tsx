"use client";

// MessageTeamDrawer — the "Message Team" button + slide-over drawer on Mission
// Control. It reuses the EXISTING messaging feature verbatim: the drawer body is
// the same <NotifyTeamControl> composer, wired to the same `notifyTeam` server
// action (a Telegram broadcast to the team group). No new messaging backend —
// this only re-surfaces the control that lived on the old Command Center as a
// drawer instead of an always-open panel.

import { useEffect, useState } from "react";
import { NotifyTeamControl, type NotifyTeamState } from "./NotifyTeamControl";

export function MessageTeamDrawer({
  action,
}: {
  action: (prev: NotifyTeamState, formData: FormData) => Promise<NotifyTeamState>;
}) {
  const [open, setOpen] = useState(false);

  // Close on Escape while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 transition-colors hover:bg-teal-400"
      >
        <span aria-hidden>✉</span> Message Team
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Message the team">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-charcoal-950/70 backdrop-blur-sm"
          />
          <aside className="relative flex h-full w-full max-w-sm flex-col gap-4 border-l border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-5 shadow-elevate">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">Message Team</h2>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  Send a message to the team Telegram group.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-charcoal-700 px-2 py-1 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
              >
                Close
              </button>
            </div>
            <NotifyTeamControl action={action} />
          </aside>
        </div>
      )}
    </>
  );
}
