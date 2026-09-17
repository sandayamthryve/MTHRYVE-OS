// lib/csi/persist.ts — write grounded findings to public.csi_findings.
//
// Uses the SERVICE-ROLE client, the same trusted-backend pattern as
// lib/knowledge ingestion: the caller (a leadership/department-head session, or
// the GitHub Actions automation bearer) is already authorized to run research; the row
// writes are trusted backend work, so the service role bypasses per-row RLS. It
// only ever touches csi_findings for the one org it's handed.
//
// GOLDEN RULE, defended one more time here: csi_findings.source_url is NOT NULL
// and must be real. Even though research.ts already grounds every finding to a
// retrieved URL, this layer independently drops anything missing an http(s)
// source_url and de-dupes within the batch, so nothing fabricated or malformed
// can reach the table. Nullable columns are left null — never a fabricated 0.

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { CsiFinding } from "./types";

// csi_findings isn't in the generated Database types yet — reach it through the
// same untyped shim the rest of the app uses for not-yet-typed tables. Reads
// nothing back except the ids of the rows actually inserted.
type InsertShim = {
  from: (t: string) => {
    upsert: (
      values: Record<string, unknown>[],
      opts: { onConflict: string; ignoreDuplicates: boolean }
    ) => {
      select: (cols: string) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
};

export interface SaveResult {
  inserted: number;
  skipped: number;
}

/**
 * Persist findings for one research run. `createdBy` is the leadership user's id
 * for a session-driven run, or null for the GitHub Actions bearer path (no logged-in user).
 * Inserts with ON CONFLICT (org_id, source_url) DO NOTHING, so re-discovering a
 * source the org already has is a silent skip, not a duplicate.
 */
export async function saveFindings(
  orgId: string,
  runId: string,
  createdBy: string | null,
  findings: CsiFinding[]
): Promise<SaveResult> {
  let skipped = 0;
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];

  for (const f of findings) {
    const url = typeof f.source_url === "string" ? f.source_url.trim() : "";
    // Defensive: never write a finding without a real http(s) source_url.
    if (!url || !/^https?:\/\//i.test(url)) {
      skipped++;
      continue;
    }
    if (seen.has(url)) {
      // Duplicate source within this batch — insert once, count the rest skipped.
      skipped++;
      continue;
    }
    seen.add(url);
    rows.push({
      org_id: orgId,
      run_id: runId,
      created_by: createdBy,
      job_type: f.job_type,
      title: f.title,
      summary: f.summary,
      source_url: url,
      source_title: f.source_title ?? null,
      relevance_score: f.relevance_score ?? null,
      category: f.category ?? null,
      brand_id: f.brand_id ?? null,
      status: "new",
    });
  }

  if (rows.length === 0) return { inserted: 0, skipped };

  const db = createServiceRoleClient() as unknown as InsertShim;
  const { data, error } = await db
    .from("csi_findings")
    .upsert(rows, { onConflict: "org_id,source_url", ignoreDuplicates: true })
    .select("id");

  if (error) {
    // A write failure stores nothing — report the whole batch as skipped rather
    // than pretending anything landed.
    console.error("[csi] saveFindings failed", error.message);
    return { inserted: 0, skipped: skipped + rows.length };
  }

  const inserted = (data ?? []).length;
  // Rows not returned were ignored as existing-source duplicates.
  return { inserted, skipped: skipped + (rows.length - inserted) };
}
