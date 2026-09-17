"use client";

// PerfSnapFill — mounts the shared <SnapFill> on the Creative Studio · Performance
// metrics form. Snap a screenshot of a platform insights panel (or paste a row) and
// it pre-fills the whitelisted numeric inputs of the SURROUNDING server-rendered
// form by name. It only fills — the existing savePerformance server action still
// does the write (source='manual', honest nulls, same role-gate), and it upserts on
// (org_id, external_id) so it can never clobber a future API-synced row.
//
// The perf form is a big uncontrolled server form, so rather than lift it all into
// client state we set the sibling inputs' values via the DOM (uncontrolled inputs
// read their current value into FormData on submit) and highlight the ones filled.

import { useRef } from "react";
import { SnapFill } from "@/components/snapfill/SnapFill";
import { CONTENT_PERF_SNAP_FIELDS } from "@/lib/snapfill/schema";
import type { SnapFillResult } from "@/lib/snapfill/schema";

export function PerfSnapFill() {
  const ref = useRef<HTMLDivElement>(null);

  function applyFill(result: SnapFillResult) {
    const form = ref.current?.closest("form");
    if (!form) return;
    for (const f of CONTENT_PERF_SNAP_FIELDS) {
      const v = result.values[f.key];
      if (v === undefined) continue;
      const input = form.querySelector<HTMLInputElement>(`[name="${f.key}"]`);
      if (!input) continue;
      input.value = v;
      // Nudge any listeners + flag the field as an AI/paste suggestion to review.
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.classList.add("border-amber-500/60", "bg-amber-500/5");
    }
  }

  return (
    <div ref={ref} className="mb-4">
      <SnapFill
        target="Content performance metrics"
        schema={CONTENT_PERF_SNAP_FIELDS}
        onFill={applyFill}
        modes={["photo", "paste"]}
      />
    </div>
  );
}
