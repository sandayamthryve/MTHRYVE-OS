// lib/briefings/anthropic.ts — the SINGLE Anthropic call for the briefing engine.
//
// Extracted verbatim from lib/briefings/generate.ts so every briefing surface —
// the button-driven org / account / department / finance briefings AND the
// per-metric Mission Control briefs (lib/briefings/metric-briefs.ts) — drives
// the exact same request path. No new engine, no new API key: this reads the
// existing ANTHROPIC_API_KEY and hits the same endpoint. Callers still own their
// own system prompt, token budget, parsing, and fallbacks.

// Token usage for one call (mirrors Anthropic's usage block), so a caller that
// must record spend (ai_usage_log) has the real figures. Zeroed when the API
// omits usage — never guessed.
export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
}

// Shared Anthropic call that ALSO returns the token usage — the single request
// path, exposed for callers (e.g. the Cognition Loop) that log the call to
// ai_usage_log. Returns the concatenated text + usage, throws on API error.
export async function anthropicMessagesWithUsage(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<{ text: string; usage: AnthropicUsage }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  const payload = (await res.json()) as {
    content?: { type: string; text: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(payload?.error?.message ?? "generation failed");
  const text = (payload.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const usage: AnthropicUsage = {
    inputTokens: Math.max(0, Math.round(Number(payload.usage?.input_tokens ?? 0)) || 0),
    outputTokens: Math.max(0, Math.round(Number(payload.usage?.output_tokens ?? 0)) || 0),
  };
  return { text, usage };
}

// Shared Anthropic call — returns the concatenated text, throws on API error.
// Thin wrapper over anthropicMessagesWithUsage so there is still exactly ONE
// request path; callers that don't track spend keep this simpler signature.
export async function anthropicMessages(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const { text } = await anthropicMessagesWithUsage(opts);
  return text;
}
