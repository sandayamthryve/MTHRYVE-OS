// Splits extracted document text into overlapping chunks for embedding.
//
// Target ~800 tokens per chunk with ~100 tokens of overlap between neighbours,
// per the ingestion spec. We don't run a real tokenizer at ingest time (it would
// pull a heavy dependency); instead we size by characters using the standard
// ~4-chars-per-token heuristic for OpenAI models. That keeps chunks comfortably
// under the embedding model's 8191-token input limit while giving retrieval
// enough context per chunk. The overlap means a passage that straddles a chunk
// boundary still lands whole in at least one chunk.

const CHARS_PER_TOKEN = 4;
export const TARGET_TOKENS = 800;
export const OVERLAP_TOKENS = 100;

const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN; // ~3200
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN; // ~400

/** Rough token count for a string (~4 chars/token). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

// Collapse runs of whitespace to single spaces and trim. Extractors emit ragged
// spacing (form-feeds from PDFs, tabs from docx); embeddings don't benefit from
// that noise and it inflates the char count.
function normalizeWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Break `raw` into ~800-token chunks with ~100-token overlap, splitting only on
 * word boundaries. Returns [] for empty/whitespace input. The returned array is
 * ordered; the caller assigns chunk_index from the array position.
 */
export function chunkText(raw: string): string[] {
  const text = normalizeWhitespace(raw);
  if (!text) return [];

  const words = text.split(" ");
  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    // Grow the window until it reaches the target size (or runs out of words).
    let end = start;
    let len = 0;
    while (end < words.length && len < TARGET_CHARS) {
      len += words[end].length + 1; // +1 for the joining space
      end++;
    }

    const content = words.slice(start, end).join(" ").trim();
    if (content) chunks.push(content);

    if (end >= words.length) break;

    // Seed the next window with ~OVERLAP_CHARS of trailing words. `next` stays
    // strictly greater than `start` so the loop always makes progress.
    let back = 0;
    let next = end;
    while (next > start + 1 && back < OVERLAP_CHARS) {
      next--;
      back += words[next].length + 1;
    }
    start = next;
  }

  return chunks;
}
