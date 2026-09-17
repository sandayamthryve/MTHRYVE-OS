import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { parseJsonBody } from "@/lib/security/api";
import { ingestDocument } from "@/lib/knowledge/ingest";
import { isEmbeddingConfigured } from "@/lib/knowledge/embed";

const IngestSchema = z.object({
  documentId: z.string().max(200).optional(),
});

export const runtime = "nodejs";
// Read env fresh per request (Vercel "Sensitive" runtime-only vars) and never
// cache. Ingestion (extract → chunk → embed → write) can take a while on a big
// PDF, so give it headroom.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WRITE_ROLES = ["ceo", "coo", "department_head"] as const;

// POST /api/knowledge/ingest — (re)process an existing document into chunks.
//
// The document row + its uploaded file must already exist (the Knowledge upload
// action creates both). This route re-verifies the session and that the caller
// may see the document under RLS, then runs the pipeline. The chunk writes
// happen with the service role inside ingestDocument(); this handler only
// authorizes and delegates. The response's `status` field is authoritative —
// 'ready' or 'failed' with a short reason.
export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!WRITE_ROLES.includes(profile.role as (typeof WRITE_ROLES)[number])) {
    return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  }
  if (!isEmbeddingConfigured()) {
    return NextResponse.json({ error: "not-configured" }, { status: 503 });
  }

  const parsed = await parseJsonBody(request, IngestSchema, "knowledge/ingest");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const documentId = typeof body?.documentId === "string" ? body.documentId : "";
  if (!documentId) {
    return NextResponse.json({ error: "documentId is required." }, { status: 400 });
  }

  // Confirm the caller can actually see this document under their own RLS scope
  // before handing it to the service-role pipeline.
  const supabase = createServerSupabaseClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const result = await ingestDocument(documentId);
  return NextResponse.json(result);
}
