// lib/snapfill/vision.ts — SnapFill's photo/vision reader (Claude vision, 'lite' tier).
//
// The generalization of the metric "Snap to fill" reader: instead of a fixed metric
// list it takes an ARBITRARY field whitelist and reads ONLY those fields off one
// image, returning { key: value } for the ones it can confidently see. It handles
// both text fields (a TikTok handle, a Viber number, a Facebook link) and numeric
// fields (followers, GMV), coercing numbers but keeping text verbatim.
//
// Whitelist-bounded by construction: a key the model returns that isn't in the
// provided schema is dropped here (and again in the route + client), so vision can
// only ever fill whitelisted keys and IGNORES everything else it reads. Honest
// failure: an unset key or a failed call returns an error the route turns into a
// graceful "couldn't read it — enter manually"; a value that isn't clearly legible
// is simply omitted, never fabricated.

import { TIER_MODEL } from "@/lib/ai/models";
import { isNumericField, type SnapField } from "./schema";
import { coerceCell } from "./match";

// 'lite' tier = Haiku, the cheapest Anthropic vision model (one source of truth).
export const SNAPFILL_VISION_MODEL = TIER_MODEL.lite;

export type SnapVisionResult =
  | {
      ok: true;
      // whitelisted key -> the value the model read (string for text, number for
      // numeric fields). Only schema keys, only legible values.
      values: Record<string, string | number>;
      // The raw JSON object the model returned, kept verbatim for the evidence trail.
      extract: Record<string, unknown>;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { ok: false; error: "not-configured" | "failed"; detail?: string };

export function isVisionConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Normalize a model-returned value to a raw string the shared sanitizer (coerceCell)
// can vet. Numbers stringify; anything else that isn't a string is dropped.
function rawString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

// The FIXED instruction — identical on every call, so it stays prompt-cacheable.
const SYSTEM =
  "You read structured fields off a screenshot or photo — a dashboard, a profile " +
  "page, a TikTok Shop / creator panel, a business card, a chat, or a spreadsheet. " +
  "You are given a fixed list of fields (each with a stable key, a label, a type, " +
  "and sometimes a unit). Read ONLY the values you can clearly and confidently see, " +
  "and match each to the field whose label it belongs to. Respond with STRICT JSON " +
  "ONLY — a single flat object mapping field key to its value. For a 'number' field " +
  "return a JSON number with currency/percent/thousands separators stripped " +
  "(₱1,234.50 -> 1234.5; 12.3% -> 12.3). For any other type return the exact text " +
  "you see as a string (a @handle, a phone number, a URL — verbatim, do not " +
  "reformat). Include a key ONLY when you are confident of its value; OMIT any field " +
  "you cannot read. NEVER invent, guess, or estimate. Do not use keys that are not " +
  "in the provided list. No prose, no code fences — just the JSON object.";

// Read the given field whitelist off one image. `target` is a short context label
// (e.g. "Affiliate creator", "BizDev lead", a department) that helps the model
// orient. Best-effort + defensive: malformed model output degrades to an empty read
// (ok:true, values:{}) rather than throwing, so the host stays usable.
export async function readFields(
  base64: string,
  mediaType: string,
  target: string,
  fields: readonly SnapField[]
): Promise<SnapVisionResult> {
  if (!isVisionConfigured()) return { ok: false, error: "not-configured" };

  const byKey = new Map(fields.map((f) => [f.key, f]));
  const fieldList = fields
    .map((f) => {
      const type = isNumericField(f) ? "number" : "text";
      return `- ${f.key}: ${f.label} (type: ${type}${f.unit ? `, unit: ${f.unit}` : ""})`;
    })
    .join("\n");

  // Fixed instruction is the cacheable system block; the per-mount field list is the
  // first user block; the image is LAST.
  const listText =
    `Context: ${target || "record"}\n` +
    `Fields to read (return their keys only):\n${fieldList}\n\n` +
    "Return the STRICT JSON object now.";

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: SNAPFILL_VISION_MODEL,
        max_tokens: 1024,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: listText },
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            ],
          },
        ],
      }),
    });

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    if (!res.ok) {
      return { ok: false, error: "failed", detail: data?.error?.message };
    }

    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();

    // Strict JSON is asked for; be defensive and pull the first {...} block in case
    // it wrapped it. A parse failure → an empty (honest) read, never a fabrication.
    const match = text.match(/\{[\s\S]*\}/);
    let parsed: Record<string, unknown> = {};
    if (match) {
      try {
        parsed = JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    // Keep only whitelisted keys, run through the SAME sanitizer as paste/import
    // (coerceCell): binary/control-char/overlong values are rejected, numeric fields
    // must parse as a real number. Everything else the model returned is dropped.
    const values: Record<string, string | number> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      const field = byKey.get(key);
      if (!field) continue;
      const clean = coerceCell(field, rawString(raw));
      if (clean == null) continue;
      values[key] = isNumericField(field) ? Number(clean) : clean;
    }

    return {
      ok: true,
      model: SNAPFILL_VISION_MODEL,
      values,
      extract: parsed,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  } catch (e) {
    return { ok: false, error: "failed", detail: e instanceof Error ? e.message : undefined };
  }
}
