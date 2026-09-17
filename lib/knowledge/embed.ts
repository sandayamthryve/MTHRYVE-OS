// The single embedding helper for the knowledge base — used by BOTH ingestion
// (embedding each chunk) and retrieval (embedding the query). Keeping one model
// constant in one file is the guarantee that stored vectors and query vectors
// always share the same 1536-dim space; if you change the model, change it once
// here and re-ingest.
//
// OpenAI text-embedding-3-small → 1536 dimensions, matching the
// document_chunks.embedding vector(1536) column and the match_document_chunks
// query_embedding argument.
//
// Server-only. OPENAI_API_KEY is read at CALL TIME (never module load) so Vercel
// "Sensitive" runtime vars are seen fresh per request and never captured into a
// build artifact. The key is never logged and never returned to the browser.

const OPENAI_BASE = "https://api.openai.com/v1";
export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIMS = 1536;

// OpenAI accepts up to 2048 inputs per request; we batch well under that so a
// large document's chunks embed in a handful of calls without risking the
// per-request token ceiling.
const MAX_INPUTS_PER_CALL = 96;

/** The API key, trimmed, read fresh each call. Undefined when unset. */
export function openAiKey(): string | undefined {
  const raw = process.env.OPENAI_API_KEY?.trim();
  return raw ? raw : undefined;
}

/** True only when the key is present. Routes use this to fail cleanly (503). */
export function isEmbeddingConfigured(): boolean {
  return Boolean(openAiKey());
}

/**
 * Thrown when embedding can't proceed. `.reason` is a short, non-secret token
 * ("not-configured" | "openai <status>" | "network") suitable for surfacing as a
 * document's failure message.
 */
export class EmbeddingError extends Error {
  reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "EmbeddingError";
    this.reason = reason;
  }
}

// Embed one batch (<= MAX_INPUTS_PER_CALL). Returns vectors in input order.
async function embedBatch(inputs: string[], key: string): Promise<number[][]> {
  let res: Response;
  try {
    res = await fetch(`${OPENAI_BASE}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs, encoding_format: "float" }),
      cache: "no-store",
    });
  } catch (e) {
    console.error("[knowledge] embed threw", e);
    throw new EmbeddingError("network", "Could not reach the embedding service.");
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    console.error("[knowledge] embed failed", res.status, raw.slice(0, 300));
    throw new EmbeddingError(`openai ${res.status}`, "The embedding service rejected the request.");
  }

  const json = (await res.json().catch(() => null)) as
    | { data?: { embedding: number[]; index: number }[] }
    | null;
  const data = json?.data;
  if (!data || data.length !== inputs.length) {
    throw new EmbeddingError("bad-response", "The embedding service returned an unexpected shape.");
  }
  // Reorder defensively by the returned index rather than trusting array order.
  const out = new Array<number[]>(inputs.length);
  for (const row of data) out[row.index] = row.embedding;
  return out;
}

/**
 * Embed many texts, preserving order. Batches internally. Throws EmbeddingError
 * on any failure so the caller can mark the document 'failed' with the reason.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const key = openAiKey();
  if (!key) throw new EmbeddingError("not-configured", "OPENAI_API_KEY is not set.");
  if (texts.length === 0) return [];

  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_INPUTS_PER_CALL) {
    const batch = texts.slice(i, i + MAX_INPUTS_PER_CALL);
    vectors.push(...(await embedBatch(batch, key)));
  }
  return vectors;
}

/** Embed a single text (e.g. a search query). Throws EmbeddingError on failure. */
export async function embedText(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  return vector;
}

// pgvector's text input format is a bracketed, comma-separated list: "[0.1,0.2]".
// PostgREST hands JS number[] to a vector() argument fine for rpc, but for column
// INSERTs we serialize to this canonical literal so the value round-trips
// regardless of client-side JSON coercion.
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
