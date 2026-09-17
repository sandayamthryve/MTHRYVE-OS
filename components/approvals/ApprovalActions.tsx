"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Approve / reject controls on a pending request.
//
// The entire decision is delegated to the decide_approval() RPC (migration
// 0014): a single SECURITY INVOKER, RLS-enforced transaction that validates the
// reviewer role, executes the proposed action (e.g. create_task), records the
// decision, and lets the tamper-proof audit trigger (0011) fire — atomically.
//
// The client no longer writes to tasks / approval_requests / audit_logs
// directly. That direct-write path was the INC-2026-002 weakness: a forgeable
// actor_id and a silent client-side audit insert. The server is now the sole
// authority for privileged writes, and the actor is always auth.uid().
export function ApprovalActions({ requestId }: { requestId: string }) {
  const router = useRouter();
  const supabase = createClient();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);

    // Single atomic, RLS-enforced call. decide_approval() returns
    // SETOF approval_requests, which the installed @supabase/ssr Postgrest
    // typings don't infer arguments for cleanly — so this one call keeps a
    // cast. Runtime is unaffected; the args are sent as the POST body.
    const { error: rpcErr } = await supabase.rpc("decide_approval" as never, {
      p_request_id: requestId,
      p_decision: decision,
      p_note: note.trim() || null,
    } as never);

    if (rpcErr) {
      setError(rpcErr.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  }

  return (
    <div className="mt-3 border-t border-charcoal-700/70 pt-3">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note…"
        className="mb-2 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:border-teal-500"
      />
      {error && <p className="mb-2 text-sm text-gold-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => decide("approved")}
          disabled={busy}
          className="rounded-md bg-green-500/90 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-green-400 disabled:opacity-60"
        >
          {busy ? "Working…" : "Approve"}
        </button>
        <button
          onClick={() => decide("rejected")}
          disabled={busy}
          className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink disabled:opacity-60"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
