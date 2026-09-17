// lib/csi/types.ts — the shared contract for Agent CSI (grounded deep research).
//
// These types cross the server/client boundary: the engine (research.ts /
// persist.ts, server-only) produces CsiFinding[], the API route hands them back,
// and the /csi feed renders them. No server imports here so the client can pull
// the shape in without dragging the Supabase/Anthropic code into the bundle.
//
// GOLDEN RULE: Agent CSI never fabricates. Every CsiFinding that reaches the DB
// carries a real `source_url` that came from a live web_search citation — a
// candidate with no verifiable source is dropped, never stored.

export type CsiJobType = "trend" | "business_opportunity";

// One grounded finding. Nullable fields stay null rather than being padded with
// a fabricated placeholder (see persist.ts) — an honest gap beats an invented 0.
export interface CsiFinding {
  title: string;
  summary: string;
  source_url: string; // a URL web_search actually retrieved; never invented
  source_title: string | null;
  relevance_score: number | null; // 0-100, or null when the model gave no usable score
  category: string | null;
  job_type: CsiJobType;
  brand_id?: string | null;
}

// The request shape for POST /api/csi/research and research().
export interface CsiResearchInput {
  job_type: CsiJobType;
  query: string;
  brand_id?: string | null;
  max_results?: number;
}
