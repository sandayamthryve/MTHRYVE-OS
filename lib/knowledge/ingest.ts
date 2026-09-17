// Ingestion pipeline: turns an uploaded file into embedded, searchable chunks.
//
// Runs entirely server-side with the SERVICE-ROLE client for the chunk writes.
// That's deliberate: the caller (a leadership / department-head session) has
// already been authorized to create the document row and upload the file under
// RLS, but writing potentially hundreds of document_chunks rows is trusted
// backend work — the service role bypasses RLS so it isn't re-checked per row.
// The service role never touches anything the caller couldn't; it only acts on
// the one document id it's handed.
//
// Flow: mark 'processing' → download original from Storage → extract text →
// chunk (~800 tok / ~100 overlap) → embed each chunk → replace chunks →
// mark 'ready' with chunk_count. Any failure flips the row to 'failed' and
// returns a short, non-secret reason. Re-running is idempotent: existing chunks
// are deleted before the new ones are inserted, so re-ingest just refreshes.

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { DocumentChunkInsert, DocumentStatus } from "@/types/database";
import { chunkText } from "./chunk";
import { embedTexts, toVectorLiteral, EmbeddingError } from "./embed";
import { extForFilename, extractText, ExtractionError } from "./extract";

export interface IngestResult {
  status: DocumentStatus;
  chunkCount: number;
  /** Short, non-secret reason when status is 'failed'. */
  error?: string;
}

// How many chunk rows to insert per request. Each row carries a 1536-float
// vector (~15 KB as text), so we keep batches modest to stay well under
// PostgREST's payload limits on large documents.
const INSERT_BATCH = 100;

export async function ingestDocument(documentId: string): Promise<IngestResult> {
  const service = createServiceRoleClient();

  // Load the row first — we need org_id + storage_path. If it's gone, there's
  // nothing to flip to 'failed'; just report it.
  const { data: doc, error: loadErr } = await service
    .from("documents")
    .select("id, org_id, storage_path, title")
    .eq("id", documentId)
    .single();

  if (loadErr || !doc) {
    console.error("[knowledge] ingest: document not found", documentId, loadErr?.message);
    return { status: "failed", chunkCount: 0, error: "not-found" };
  }

  const markFailed = async (reason: string): Promise<IngestResult> => {
    await service
      .from("documents")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", documentId);
    return { status: "failed", chunkCount: 0, error: reason };
  };

  // Announce processing so a re-ingest shows the right state immediately.
  await service
    .from("documents")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", documentId);

  try {
    if (!doc.storage_path) return await markFailed("no-file");

    const ext = extForFilename(doc.storage_path);
    if (!ext) return await markFailed("unsupported");

    // Download the original with the service role (bypasses Storage RLS).
    const { data: blob, error: dlErr } = await service.storage
      .from("documents")
      .download(doc.storage_path);
    if (dlErr || !blob) {
      console.error("[knowledge] ingest: download failed", doc.storage_path, dlErr?.message);
      return await markFailed("download");
    }

    const bytes = Buffer.from(await blob.arrayBuffer());
    const text = await extractText(bytes, ext); // throws ExtractionError
    const chunks = chunkText(text);
    if (chunks.length === 0) return await markFailed("empty");

    const vectors = await embedTexts(chunks); // throws EmbeddingError
    if (vectors.length !== chunks.length) return await markFailed("embed-mismatch");

    // Replace any prior chunks (idempotent re-ingest), then insert fresh ones.
    const { error: delErr } = await service
      .from("document_chunks")
      .delete()
      .eq("document_id", documentId);
    if (delErr) {
      console.error("[knowledge] ingest: clear chunks failed", delErr.message);
      return await markFailed("db-clear");
    }

    const rows: DocumentChunkInsert[] = chunks.map((content, i) => ({
      org_id: doc.org_id,
      document_id: documentId,
      chunk_index: i,
      content,
      embedding: toVectorLiteral(vectors[i]),
    }));

    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const { error: insErr } = await service
        .from("document_chunks")
        .insert(rows.slice(i, i + INSERT_BATCH));
      if (insErr) {
        console.error("[knowledge] ingest: insert chunks failed", insErr.message);
        return await markFailed("db-insert");
      }
    }

    const { error: readyErr } = await service
      .from("documents")
      .update({
        status: "ready",
        chunk_count: chunks.length,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId);
    if (readyErr) {
      console.error("[knowledge] ingest: finalize failed", readyErr.message);
      return await markFailed("db-finalize");
    }

    console.log("[knowledge] ingest ok", { documentId, title: doc.title, chunks: chunks.length });
    return { status: "ready", chunkCount: chunks.length };
  } catch (e) {
    const reason =
      e instanceof ExtractionError || e instanceof EmbeddingError ? e.reason : "error";
    console.error("[knowledge] ingest threw", documentId, reason, e);
    return await markFailed(reason);
  }
}
