"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

// Client chat surface for one copilot. Talks to /api/copilot/[key]/chat, which
// grounds the copilot in its live metrics + project docs, calls Sonnet with the
// persisted ai_messages thread, and gates any proposed action behind approval.
// Recommend-only: the copilot never executes — it queues an action_requests row.

type ChatMessage = { role: "user" | "assistant"; content: string };

export function CopilotChat({
  copilotKey,
  copilotName,
  initialConversationId,
  initialMessages,
}: {
  copilotKey: string;
  copilotName: string;
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
}) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setError(null);
    setBusy(true);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      // The route's key comes from the URL, so the body carries only the message
      // and (once we have one) the conversationId. Omit conversationId on the
      // first turn rather than sending null — the schema wants a uuid or nothing.
      const res = await fetch(`/api/copilot/${encodeURIComponent(copilotKey)}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(conversationId ? { conversationId, message: text } : { message: text }),
      });
      const data = (await res.json()) as {
        conversationId?: string;
        assistant?: { role: "assistant"; content: string };
        actionQueued?: boolean;
        error?: string;
      };

      if (!res.ok || !data.assistant) {
        setError(data.error ?? "Something went wrong.");
        setBusy(false);
        return;
      }

      if (data.conversationId) setConversationId(data.conversationId);
      setMessages((prev) => [...prev, { role: "assistant", content: data.assistant!.content }]);
      // A queued proposal creates a pending approval — refresh so any approvals
      // badge / queue the user later views reflects it.
      if (data.actionQueued) router.refresh();
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  return (
    <div className="flex h-[calc(100dvh-11rem)] min-h-[26rem] flex-col sm:h-[calc(100vh-10rem)]">
      <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
        {messages.length === 0 && !busy && (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-muted">
            Ask {copilotName} about your numbers, what to prioritize, or what to do next. It knows
            this domain&apos;s live metrics — and can propose an action for your approval.
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-teal-500/15 text-ink"
                  : "border border-charcoal-700 bg-charcoal-950 text-ink"
              }`}
            >
              <div className="whitespace-pre-wrap">{m.content}</div>
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex justify-start">
            <div className="rounded-lg border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink-muted">
              Thinking…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <p className="mt-2 text-sm text-gold-400">{error}</p>}

      <form onSubmit={send} className="mt-3 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e as unknown as React.FormEvent);
            }
          }}
          placeholder={`Ask ${copilotName}…  (Enter to send, Shift+Enter for a new line)`}
          rows={2}
          className="flex-1 resize-none rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          Send
        </button>
      </form>
    </div>
  );
}
