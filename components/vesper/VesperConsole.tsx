"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Vesper console — the Operator agent chat. Posts to /api/vesper, which runs the
// same agentic tool-loop as Tony but with Vesper's persona + tools (propose_play
// / preview_scoreboard). Vesper never executes anything itself: proposing a play
// files a PENDING approval, so this surface is safe by construction.

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "How are the pods doing right now?",
  "Forecast restock across the warehouse.",
  "Compile the scoreboard for last 7 days.",
  "Rank creators for our top brand.",
];

export function VesperConsole({ canFile }: { canFile: boolean }) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  function send(text: string) {
    const msg = text.trim();
    if (!msg || pending) return;
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: msg }]);
    startTransition(async () => {
      try {
        const res = await fetch("/api/vesper", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId, message: msg }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Vesper is unavailable.");
          return;
        }
        setConversationId(data.conversationId ?? conversationId);
        setMessages((m) => [...m, { role: "assistant", content: data.assistant?.content ?? "" }]);
        // A filed play changes the approvals queue + recent-plays list.
        router.refresh();
        requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
      } catch {
        setError("Vesper is unavailable. Please try again.");
      }
    });
  }

  return (
    <div className="flex h-[32rem] flex-col rounded-xl border border-charcoal-700/60 bg-charcoal-900 shadow-elevate">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="text-sm text-ink-muted">
            <p className="mb-3">
              I&apos;m Vesper, the Operator. Tell me what to run and I&apos;ll file the play for approval —
              or ask me to read the scoreboard.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  disabled={pending}
                  className="rounded-full border border-charcoal-700 px-3 py-1 text-xs text-ink-muted hover:bg-charcoal-800 disabled:opacity-60"
                >
                  {s}
                </button>
              ))}
            </div>
            {!canFile && (
              <p className="mt-3 text-[11px] text-amber-300">
                Your role can preview the scoreboard but can&apos;t file plays (filing is leadership-only).
              </p>
            )}
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
              <div
                className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-teal-500/15 text-ink"
                    : "border border-charcoal-700/60 bg-charcoal-950 text-ink-muted"
                }`}
              >
                {m.content}
              </div>
            </div>
          ))
        )}
        {pending && <p className="text-xs text-ink-dim">Vesper is working…</p>}
      </div>

      {error && <p className="px-4 pb-2 text-xs text-red-400">{error}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-center gap-2 border-t border-charcoal-700/60 p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Vesper to run a play or read the scoreboard…"
          disabled={pending}
          className="flex-1 rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-dim"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          Send
        </button>
      </form>
    </div>
  );
}
