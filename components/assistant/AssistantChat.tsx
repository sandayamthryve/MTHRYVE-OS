"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  type ModelTier,
  MODEL_TIERS,
  TIER_LABEL,
  TIER_ORDER,
  defaultTierFor,
} from "@/lib/ai/models";
import { openAssistantStream } from "@/lib/assistant/client-stream";
import { RequestModelAccessForm } from "@/components/assistant/RequestModelAccessForm";

type ChatMessage = { role: "user" | "assistant"; content: string; tier?: ModelTier };

// Client chat surface for the company assistant. Talks to /api/assistant, which
// persists messages and calls Claude server-side. Recommend-only per D-005.
//
// D-012: a tier picker chooses which model answers. Tiers at or below the
// caller's role default send straight through. A tier above it needs a
// single-use grant — if the caller doesn't have one the route replies
// needsApproval and we surface the request-access flow inline.
export function AssistantChat({
  initialConversationId,
  initialMessages,
  role,
  orgId,
  userId,
}: {
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
  role: string;
  orgId: string;
  userId: string;
}) {
  const router = useRouter();
  const roleDefault = defaultTierFor(role);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [tier, setTier] = useState<ModelTier>(roleDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApprovalFor, setNeedsApprovalFor] = useState<ModelTier | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setError(null);
    setNeedsApprovalFor(null);
    setBusy(true);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);

    try {
      // Stream Tony's reply so tokens render the instant they generate — no
      // wait-for-full-reply. A JSON result instead of a stream means an error or
      // the tier-approval gate, which we handle exactly as before.
      const result = await openAssistantStream({ conversationId, message: text, tier });

      if (result.kind === "json") {
        const data = result.data;
        if (result.status === 403 && data.needsApproval) {
          setNeedsApprovalFor((data.requestedTier as ModelTier) ?? tier);
        }
        setError((data.error as string) ?? "Something went wrong.");
        setBusy(false);
        return;
      }

      // The assistant bubble is added lazily on the first token, so "Thinking…"
      // stays up until tokens actually start — then deltas fill the bubble live.
      let assistantIndex = -1;
      let acc = "";
      let replyTier: ModelTier = tier;
      let navPath: string | null = null;

      const writeContent = (content: string) => {
        setMessages((prev) => {
          const next = [...prev];
          if (assistantIndex >= 0 && next[assistantIndex]) {
            next[assistantIndex] = { ...next[assistantIndex], content, tier: replyTier };
          }
          return next;
        });
      };

      for await (const evt of result.events) {
        if (evt.type === "meta") {
          if (evt.conversationId) setConversationId(evt.conversationId);
          if (evt.tier) replyTier = evt.tier as ModelTier;
        } else if (evt.type === "delta") {
          acc += evt.text;
          if (assistantIndex < 0) {
            setMessages((prev) => {
              assistantIndex = prev.length;
              return [...prev, { role: "assistant", content: acc, tier: replyTier }];
            });
            setBusy(false); // tokens are flowing — drop the "Thinking…" indicator
          } else {
            writeContent(acc);
          }
        } else if (evt.type === "navigation") {
          navPath = evt.path;
        } else if (evt.type === "done") {
          if (evt.tier) replyTier = evt.tier as ModelTier;
          if (assistantIndex >= 0) writeContent(acc);
        } else if (evt.type === "error") {
          setError(evt.error);
        }
      }

      // Server-validated navigation: only ever changes the page shown.
      if (navPath) router.push(navPath);
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  function newChat() {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setNeedsApprovalFor(null);
    setInput("");
    setTier(roleDefault);
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[26rem] flex-col sm:h-[calc(100vh-8rem)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <p className="min-w-0 flex-1 text-xs text-ink-muted">
          Answers, and can act: small self-scoped changes directly, anything consequential only as a
          proposal for human approval. Never moves money or sends anything on its own.
        </p>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            Model
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as ModelTier)}
              className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1 text-xs text-ink focus:border-teal-500"
            >
              {MODEL_TIERS.map((t) => {
                const above = TIER_ORDER[t] > TIER_ORDER[roleDefault];
                return (
                  <option key={t} value={t}>
                    {TIER_LABEL[t]}
                    {above ? " · needs approval" : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            onClick={newChat}
            className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
          >
            New chat
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
        {messages.length === 0 && !busy && (
          <div className="flex h-full items-center justify-center text-center text-sm text-ink-muted">
            Ask about your brands, departments, priorities, or how to run today.
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
              {m.role === "assistant" && m.tier && (
                <div className="mt-1.5 text-[10px] uppercase tracking-wide text-ink-muted">
                  {TIER_LABEL[m.tier]}
                </div>
              )}
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

      {needsApprovalFor && (
        <div className="mt-2">
          <RequestModelAccessForm
            orgId={orgId}
            userId={userId}
            tier={needsApprovalFor}
            onDone={() => setTier(roleDefault)}
          />
        </div>
      )}

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
          placeholder="Ask the assistant…  (Enter to send, Shift+Enter for a new line)"
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
