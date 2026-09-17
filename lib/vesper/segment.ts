// Vesper Studio — highlight SEGMENT SELECTION. This is the step that reads a
// timestamped transcript and decides which moments become short-form clips:
// hooks, product mentions, high-energy beats, clean standalone thoughts.
//
// SERVICE ATTRIBUTION (be explicit, per the brief):
//   • Transcription is done by OpenAI Whisper (in the worker — it needs the
//     audio, which requires ffmpeg). See worker/vesper-clipper.mjs.
//   • Segment SELECTION here is done by the ANTHROPIC model (Claude). We send it
//     the transcript and it returns the highlight windows + suggested copy.
//
// This module is a pure server util: give it a transcript + options + an API key
// and model, it returns Highlight[]. It never throws for an API error — it
// returns { highlights: [], error } so callers can degrade honestly. The same
// prompt is mirrored (in JS) inside the standalone worker so the worker can run
// segmentation offline; keep the two in sync if you change the contract.

import {
  type Highlight,
  type Transcript,
  type ResolvedJobOptions,
  resolveOptions,
} from "@/lib/vesper/types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Render the transcript as compact `[mm:ss-mm:ss] text` lines the model can
// reason over. Long transcripts are truncated by cue count to stay within a
// sane token budget; the worker chunks very long videos before this point.
function renderTranscript(transcript: Transcript, maxCues = 1200): string {
  const cues = transcript.cues.slice(0, maxCues);
  const stamp = (s: number) => {
    const t = Math.max(0, Math.floor(s));
    const m = Math.floor(t / 60);
    const sec = t % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  return cues
    .map((c) => `[${stamp(c.start)}-${stamp(c.end)}] ${c.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

export function buildSegmentSystemPrompt(opts: ResolvedJobOptions): string {
  return (
    "You are a short-form video editor for a Southeast Asian social-commerce agency. " +
    "You are given the timestamped transcript of a long video or livestream. Your job is to " +
    "select the strongest moments to cut into vertical short-form clips.\n\n" +
    "Bias HARD toward SELLABLE moments — the ones that move product: a scroll-stopping " +
    "HOOK, a product REVEAL or demo, a PRICE DROP / discount / deal callout, a strong CTA " +
    '("add to cart", "checkout", "cop now", "link in bio"), or a high-energy / emotional beat ' +
    "tied to a product. A self-contained useful thought counts too, but a selling moment always " +
    "wins over generic chatter. Each clip must stand alone without the surrounding context.\n\n" +
    `Rules:\n` +
    `- Return at most ${opts.max_clips} clips, best first.\n` +
    `- Each clip must be between ${opts.min_seconds} and ${opts.max_seconds} seconds long ` +
    `(end - start), snapped to natural sentence boundaries from the transcript.\n` +
    "- start/end are SECONDS from the beginning of the video (numbers, not strings).\n" +
    "- Never invent facts, prices, or claims not present in the transcript. Base the hook and " +
    "caption only on what is actually said.\n" +
    "- Clips must not overlap each other.\n\n" +
    "Respond with ONLY a JSON object, no prose, no markdown fences, of the exact shape:\n" +
    '{"clips":[{"start":number,"end":number,"title":string,"hook":string,"caption":string,"reason":string,"score":number}]}\n' +
    "score is your 0..1 confidence the clip will perform. If nothing is worth clipping, return " +
    '{"clips":[]}.'
  );
}

// Extract the first JSON object from a model response that may (despite
// instructions) wrap it in prose or a ```json fence. Returns null if none.
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip a leading/trailing markdown fence if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  // Find the outermost object.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Coerce + validate the model's clips into safe Highlights, enforcing the
// duration bounds and non-overlap the prompt asked for (defense-in-depth — never
// trust the model's arithmetic blindly).
export function coerceHighlights(raw: unknown, opts: ResolvedJobOptions): Highlight[] {
  const clips = (raw as { clips?: unknown } | null)?.clips;
  if (!Array.isArray(clips)) return [];
  const out: Highlight[] = [];
  for (const c of clips) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const start = Number(o.start);
    const end = Number(o.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= start) continue;
    const s = Math.max(0, start);
    // Clamp the window to the allowed duration range.
    let e = end;
    if (e - s < opts.min_seconds) e = s + opts.min_seconds;
    if (e - s > opts.max_seconds) e = s + opts.max_seconds;
    // Reject if it overlaps an already-accepted clip.
    if (out.some((h) => s < h.end && e > h.start)) continue;
    const scoreNum = Number(o.score);
    out.push({
      start: Math.round(s * 100) / 100,
      end: Math.round(e * 100) / 100,
      title: String(o.title ?? "").trim().slice(0, 120) || "Untitled clip",
      hook: String(o.hook ?? "").trim().slice(0, 400),
      caption: String(o.caption ?? "").trim().slice(0, 1000),
      reason: String(o.reason ?? "").trim().slice(0, 500),
      score: Number.isFinite(scoreNum) ? Math.min(1, Math.max(0, scoreNum)) : 0.5,
    });
    if (out.length >= opts.max_clips) break;
  }
  return out;
}

// Token usage from the segment model call — logged as a per-job cost breadcrumb
// (see the brief's "log tokens before scaling" guardrail). Null when the call
// never reached the model (empty transcript / network error).
export interface SegmentUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SelectHighlightsResult {
  highlights: Highlight[];
  model: string;
  error: string | null;
  usage: SegmentUsage | null;
}

// Call the Anthropic model to select highlights from a transcript. Never throws.
export async function selectHighlights(
  transcript: Transcript,
  rawOptions: Parameters<typeof resolveOptions>[0],
  cfg: { apiKey: string; model: string }
): Promise<SelectHighlightsResult> {
  const opts = resolveOptions(rawOptions);
  if (!transcript.cues.length) {
    return { highlights: [], model: cfg.model, error: "empty-transcript", usage: null };
  }
  const system = buildSegmentSystemPrompt(opts);
  const userPrompt =
    `Here is the transcript (timestamps are mm:ss). Select the clips.\n\n` +
    renderTranscript(transcript);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
      cache: "no-store",
    });
    const data = (await res.json()) as {
      content?: { type: string; text: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    if (!res.ok) {
      return { highlights: [], model: cfg.model, error: `anthropic ${res.status}`, usage: null };
    }
    const usage: SegmentUsage = {
      input_tokens: Number(data.usage?.input_tokens) || 0,
      output_tokens: Number(data.usage?.output_tokens) || 0,
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const parsed = extractJson(text);
    if (parsed == null) {
      return { highlights: [], model: cfg.model, error: "unparseable-response", usage };
    }
    return { highlights: coerceHighlights(parsed, opts), model: cfg.model, error: null, usage };
  } catch (e) {
    console.error("[vesper] selectHighlights threw", e);
    return { highlights: [], model: cfg.model, error: "network", usage: null };
  }
}
