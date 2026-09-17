// A small, dependency-free reader for the Anthropic Messages *streaming* API
// (server-sent events). It exists so the assistant route can forward tokens to
// the browser the instant they generate — no wait-for-full-reply — while still
// reconstructing the complete assistant turn (text + any tool_use blocks) that
// the agentic loop needs to continue.
//
// We only depend on the documented event shape:
//   content_block_start   → a new text or tool_use block begins
//   content_block_delta   → text_delta (a token) or input_json_delta (tool args)
//   content_block_stop    → that block is complete
//   message_delta         → carries the final stop_reason
//   message_stop / ping / error
//
// The parser is defensive: unknown events are ignored, malformed JSON lines are
// skipped, and a torn network read never throws past the caller — it just ends
// the stream with whatever was assembled so far.

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ContentBlock = TextBlock | ToolUseBlock;

export type StreamedMessage = {
  /** The assistant turn's content blocks, in order (echoed back into the loop). */
  content: ContentBlock[];
  /** Just the tool_use blocks, for convenience. */
  toolUses: ToolUseBlock[];
  /** The concatenated visible text of this turn. */
  text: string;
  /** Anthropic's stop_reason ("tool_use" | "end_turn" | "max_tokens" | ...). */
  stopReason: string | null;
  /** Token usage for this turn (for ai_usage_log / spend monitoring). */
  usage: { inputTokens: number; outputTokens: number };
};

type Handlers = {
  /** Fired for every text token as it arrives (already de-chunked to a string). */
  onText?: (delta: string) => void;
};

// Per-block accumulation while streaming. tool_use inputs arrive as a stream of
// partial JSON strings we concatenate and parse once the block closes.
type Building =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; partialJson: string };

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Consume an Anthropic streaming Response, forwarding text tokens through
 * `handlers.onText` and returning the fully-assembled turn. The Response must be
 * the raw `fetch` result of a `stream: true` Messages call (res.ok already
 * checked by the caller).
 */
export async function consumeAnthropicStream(
  res: Response,
  handlers: Handlers = {}
): Promise<StreamedMessage> {
  const blocks = new Map<number, Building>();
  let stopReason: string | null = null;
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const body = res.body;
  if (!body) {
    return { content: [], toolUses: [], text: "", stopReason: null, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleEvent = (dataLine: string) => {
    const evt = safeJson(dataLine) as { type?: string; [k: string]: unknown };
    switch (evt.type) {
      case "content_block_start": {
        const index = evt.index as number;
        const cb = evt.content_block as { type: string; id?: string; name?: string };
        if (cb?.type === "text") {
          blocks.set(index, { type: "text", text: "" });
        } else if (cb?.type === "tool_use") {
          blocks.set(index, {
            type: "tool_use",
            id: cb.id ?? "",
            name: cb.name ?? "",
            partialJson: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const index = evt.index as number;
        const delta = evt.delta as { type?: string; text?: string; partial_json?: string };
        const b = blocks.get(index);
        if (!b) break;
        if (delta?.type === "text_delta" && b.type === "text") {
          const t = delta.text ?? "";
          b.text += t;
          fullText += t;
          if (t) handlers.onText?.(t);
        } else if (delta?.type === "input_json_delta" && b.type === "tool_use") {
          b.partialJson += delta.partial_json ?? "";
        }
        break;
      }
      case "message_start": {
        // The initial message carries input token usage.
        const msg = evt.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
        if (msg?.usage?.input_tokens) inputTokens = msg.usage.input_tokens;
        if (msg?.usage?.output_tokens) outputTokens = msg.usage.output_tokens;
        break;
      }
      case "message_delta": {
        const delta = evt.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        // Cumulative output tokens arrive on message_delta.usage.
        const usage = evt.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens) outputTokens = usage.output_tokens;
        break;
      }
      // content_block_stop / message_start / message_stop / ping / error:
      // nothing to accumulate here.
      default:
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; each frame may carry one or
      // more `data:` lines. Process every complete frame in the buffer.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split("\n")) {
          const trimmed = line.trimStart();
          if (trimmed.startsWith("data:")) {
            const data = trimmed.slice(5).trim();
            if (data && data !== "[DONE]") handleEvent(data);
          }
        }
      }
    }
  } catch {
    // Torn read — fall through and return whatever assembled so far.
  }

  // Finalize blocks in index order.
  const content: ContentBlock[] = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const b = blocks.get(index)!;
    if (b.type === "text") {
      content.push({ type: "text", text: b.text });
    } else {
      content.push({
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.partialJson ? safeJson(b.partialJson) : {},
      });
    }
  }
  const toolUses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");

  return { content, toolUses, text: fullText, stopReason, usage: { inputTokens, outputTokens } };
}
