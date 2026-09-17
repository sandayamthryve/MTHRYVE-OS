"use client";

// components/tony/cognitive/useGraphRealtime.ts — minimal live updates (TCVE
// phase 1, step 5). Subscribes to two high-signal Supabase Realtime events —
// a NEW action_request (approval) and a task UPDATE (completion) — and fires a
// callback so the graph can pulse the relevant node/edge and refresh the data.
// Realtime enforces RLS, so this only ever receives rows the caller may see.
//
// Degrades gracefully: if the tables aren't in the `supabase_realtime`
// publication yet (see migration 0024), no events fire and nothing breaks.

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export interface GraphRealtimeEvent {
  kind: "approval_created" | "task_completed" | "task_changed";
  table: "action_requests" | "tasks";
  row: Record<string, unknown>;
}

export function useGraphRealtime(
  enabled: boolean,
  // eslint-disable-next-line no-unused-vars
  onEvent: (event: GraphRealtimeEvent) => void
) {
  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    const channel = supabase
      .channel("tcve-graph")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "action_requests" },
        (payload) => {
          onEvent({ kind: "approval_created", table: "action_requests", row: payload.new as Record<string, unknown> });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tasks" },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const status = String(row.status ?? "").toLowerCase();
          onEvent({
            kind: status === "done" ? "task_completed" : "task_changed",
            table: "tasks",
            row,
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, onEvent]);
}
