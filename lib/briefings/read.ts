// lib/briefings/read.ts
// Shared read helpers + types for the existing briefing engine (Step 1). These
// are the SAME org_briefings / account_briefings rows the Command Center and
// Account Intelligence pages already write — surfaced here so the reusable
// <AiBrief> component (Reports, Campaigns) reads them without a second engine.
// Everything is org-scoped by Postgres RLS through the passed client. No new
// tables, no new generation logic.
import { createServerSupabaseClient } from "@/lib/supabase/server";

type Supabase = ReturnType<typeof createServerSupabaseClient>;

// ── Shared briefing value types ──────────────────────────────────────────────
export type Chip = { label: string; tone: "up" | "down" | "warn" | "flag" };
export type Highlight = { kind: "opportunity" | "risk" | "ops"; text: string };
export type Solution = { solution: string; why: string; steps: string[] };

export type OrgBriefing = {
  id: string;
  data_confidence: string | null;
  summary: string | null;
  chips: Chip[] | null;
  highlights: Highlight[] | null;
  model: string | null;
  created_at: string;
};

export type AccountBriefing = {
  id: string;
  data_confidence: string | null;
  summary: string | null;
  challenges: string[] | null;
  bottlenecks: string[] | null;
  solutions: Solution[] | null;
  model: string | null;
  created_at: string;
};

// finance_briefings mirrors account_briefings' AI shape plus a data_sources
// object. RLS on the table is ceo/coo ONLY, so this read returns rows only for
// leadership — department_head / team_member see zero regardless of the caller.
export type FinanceBriefing = {
  id: string;
  data_confidence: string | null;
  summary: string | null;
  challenges: string[] | null;
  bottlenecks: string[] | null;
  solutions: Solution[] | null;
  data_sources: Record<string, number> | null;
  model: string | null;
  created_at: string;
};

// Latest org-wide briefing (most recent by created_at).
export async function getLatestOrgBriefing(supabase: Supabase): Promise<OrgBriefing | null> {
  const res = await supabase
    .from("org_briefings")
    .select("id, data_confidence, summary, chips, highlights, model, created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  return ((res.data ?? [])[0] ?? null) as unknown as OrgBriefing | null;
}

// Latest AI briefing for a brand/account (most recent by created_at).
export async function getLatestAccountBriefing(
  supabase: Supabase,
  brandId: string
): Promise<AccountBriefing | null> {
  const res = await supabase
    .from("account_briefings")
    .select("id, data_confidence, summary, challenges, bottlenecks, solutions, model, created_at")
    .eq("brand_id", brandId)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((res.data ?? [])[0] ?? null) as unknown as AccountBriefing | null;
}

// Latest finance briefing (most recent by created_at). ceo/coo only via RLS.
export async function getLatestFinanceBriefing(supabase: Supabase): Promise<FinanceBriefing | null> {
  const res = await supabase
    .from("finance_briefings")
    .select("id, data_confidence, summary, challenges, bottlenecks, solutions, data_sources, model, created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  return ((res.data ?? [])[0] ?? null) as unknown as FinanceBriefing | null;
}

// Re-exported so callers have a single import surface for briefing reads.
export {
  getLatestDepartmentBriefing,
  type DepartmentBriefing,
} from "@/lib/departments/activity";
