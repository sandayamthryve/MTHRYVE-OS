// Semantic retrieval over the knowledge base.
//
// searchKnowledge embeds the query with the SAME model used at ingest (so the
// vectors live in one space) and calls the match_document_chunks() SQL function
// through the CALLER'S RLS-scoped client. That function is SECURITY INVOKER, so
// it only ever returns chunks the caller is allowed to see: 'org' docs to any
// member, 'leadership' docs only to ceo/coo. Permission enforcement is the
// database's job here — this function adds no filtering of its own, which is
// exactly why a team member searching for a leadership-only SOP gets nothing
// back rather than a redacted hit.

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { DocumentSourceType } from "@/types/database";
import { embedText, toVectorLiteral } from "./embed";

export interface KnowledgeHit {
  document_id: string;
  content: string;
  title: string;
  source_type: DocumentSourceType;
  /** Cosine similarity in [0,1]; higher is closer. */
  similarity: number;
}

/**
 * Embed `query` and return up to `k` most-similar chunks the caller may read.
 * Empty query → []. Throws EmbeddingError if OPENAI_API_KEY is missing/unusable,
 * so callers can distinguish "no results" from "search unavailable".
 */
export async function searchKnowledge(query: string, k = 6): Promise<KnowledgeHit[]> {
  const q = query.trim();
  if (!q) return [];

  const embedding = await embedText(q);
  const supabase = createServerSupabaseClient();

  // AI-spine guardrail: chunks whose parent document is soft-archived MUST NOT
  // feed RAG. The chunk→document join lives inside the out-of-band
  // match_document_chunks() SQL function, which we can't amend here (code-only,
  // no DDL), so we over-fetch candidates and drop archived parents in a second,
  // RLS-scoped round-trip below. Over-fetching keeps k results even after some
  // candidates are excluded.
  const overfetch = Math.min(Math.max(k * 3, k + 6), 40);

  // The installed @supabase/ssr Postgrest typings don't infer rpc args/returns
  // cleanly (same quirk decide_approval works around), so this one call is cast
  // and the row shape asserted below. Runtime is unaffected — the args are the
  // POST body and match match_document_chunks(query_embedding, match_count).
  const { data, error } = await supabase.rpc("match_document_chunks" as never, {
    // pgvector accepts its canonical text literal ("[0.1,0.2,…]") for the vector
    // argument; this round-trips regardless of JSON coercion on the wire.
    query_embedding: toVectorLiteral(embedding),
    match_count: overfetch,
  } as never);

  if (error) {
    console.error("[knowledge] search rpc failed", (error as { message?: string }).message);
    return [];
  }

  const rows = (data ?? []) as {
    document_id: string;
    content: string;
    title: string;
    source_type: string;
    similarity: number;
  }[];
  if (rows.length === 0) return [];

  // Which of these candidates' parent documents are archived? Look them up once
  // (same RLS-scoped client) and drop their chunks. A failed lookup fails
  // CLOSED — better to under-return than to leak an archived document into RAG.
  const docIds = Array.from(new Set(rows.map((r) => r.document_id)));
  const archived = new Set<string>();
  const { data: archRows, error: archErr } = await supabase
    .from("documents")
    .select("id")
    .in("id", docIds)
    .not("archived_at", "is", null);
  if (archErr) {
    console.error("[knowledge] archived-document check failed", (archErr as { message?: string }).message);
    return [];
  }
  for (const d of (archRows ?? []) as { id: string }[]) archived.add(d.id);

  return rows
    .filter((row) => !archived.has(row.document_id))
    .slice(0, k)
    .map((row) => ({
      document_id: row.document_id,
      content: row.content,
      title: row.title,
      source_type: row.source_type as DocumentSourceType,
      similarity: row.similarity,
    }));
}
