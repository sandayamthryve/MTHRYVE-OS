"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Leadership-only "Run detection" trigger for the org-wide Automation Radar page.
// POSTs to the scan endpoint (which runs the deterministic detector for the
// caller's org under the service-role client), then refreshes the page so the
// freshly upserted patterns render. Nothing is executed — detection only reads
// tasks and upserts repetition_patterns.
export function RunDetectionButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");

  async function run() {
    setState("running");
    try {
      const res = await fetch("/api/automation-radar/scan", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      setState("done");
      router.refresh();
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  }

  const label =
    state === "running"
      ? "Scanning…"
      : state === "done"
        ? "Detection complete ✓"
        : state === "error"
          ? "Failed — retry"
          : "Run detection";

  return (
    <button
      type="button"
      onClick={run}
      disabled={state === "running"}
      className="rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-200 transition-colors hover:bg-teal-500/20 disabled:opacity-50"
    >
      {label}
    </button>
  );
}
