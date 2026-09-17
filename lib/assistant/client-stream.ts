// Client-side reader for the streaming /api/assistant endpoint.
//
// Both the typed chat (AssistantChat) and the voice hook (useTonyVoice) talk to
// the same streaming route; this is the one place that knows the wire format, so
// they share it. It POSTs { stream: true } and either:
//   • returns a live event stream (tokens as they generate), or
//   • falls back to a plain JSON result when the route answered with JSON instead
//     of an event-stream — e.g. a 403 "needs approval" that must be handled
//     before any tokens flow. Callers branch on `kind`.
//
// The event shapes mirror what app/api/assistant/route.ts emits.

export type AssistantStreamEvent =
  | { type: "meta"; conversationId?: string; tier?: string; model?: string }
  | { type: "delta"; text: string }
  | { type: "navigation"; path: string; label: string }
  | { type: "done"; tier?: string; model?: string }
  | { type: "error"; error: string };

export type AssistantStreamPayload = {
  conversationId: string | null;
  message: string;
  tier?: string;
};

export type OpenStreamResult =
  | { kind: "stream"; events: AsyncGenerator<AssistantStreamEvent> }
  | { kind: "json"; status: number; data: Record<string, unknown> };

async function* parseSse(res: Response): AsyncGenerator<AssistantStreamEvent> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        try {
          yield JSON.parse(data) as AssistantStreamEvent;
        } catch {
          // ignore a malformed frame — the next one usually recovers.
        }
      }
    }
  }
}

/**
 * Open a streaming assistant turn. Resolves to `{ kind: "stream" }` with an async
 * generator of events on success, or `{ kind: "json" }` when the route returned
 * JSON (an error or an approval gate) that the caller handles the old way.
 */
export async function openAssistantStream(
  payload: AssistantStreamPayload,
  signal?: AbortSignal
): Promise<OpenStreamResult> {
  const res = await fetch("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("text/event-stream")) {
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      data = { error: "The assistant is temporarily unavailable." };
    }
    return { kind: "json", status: res.status, data };
  }

  return { kind: "stream", events: parseSse(res) };
}
