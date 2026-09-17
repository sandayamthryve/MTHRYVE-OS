"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// The tap's call-to-action. Opening the linked brief IS acting on the tap, so
// this marks it ACTED (POST /api/daily-tap/acted, self-only, server-verified)
// and then navigates. Best-effort: navigation happens even if the mark fails, so
// the button never traps the user. Used by the inbox card and the nudge toast.
export function TapBriefLink({
  href,
  label,
  tone = "primary",
  onDone,
}: {
  href: string;
  label: string;
  tone?: "primary" | "subtle";
  onDone?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/daily-tap/acted", { method: "POST", cache: "no-store" });
    } catch {
      /* best-effort — still navigate */
    }
    onDone?.();
    router.push(href);
    router.refresh();
  }

  const cls =
    tone === "primary"
      ? "bg-gradient-to-b from-teal-300 to-teal-500 text-charcoal-950 hover:brightness-110"
      : "border border-charcoal-700/60 bg-charcoal-850 text-ink-muted hover:text-ink";

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-60 ${cls}`}
    >
      {label}
      <span aria-hidden>→</span>
    </button>
  );
}
