// lib/contracts/data.ts — one place that loads everything the Reports-vs-Contract
// surfaces need, RLS-scoped, and computes live attainment per scope item.
//
// All three views (all-department transparency, per-department "My delivery",
// and the contract detail page) read the same tables and the same shared metrics
// layer, so a single loader keeps them consistent and avoids re-fetching. RLS
// does the gating: contract_financials only returns rows the caller may read, so
// financialsByContract simply omits contracts whose money the caller can't see —
// the views render money columns only for contracts present in that map.

import type { createServerSupabaseClient } from "@/lib/supabase/server";
import { fetchCommerceRows, type BpmRow } from "@/lib/metrics/gmv";
import type { LiveSession } from "@/lib/metrics/live";
import {
  computeAttainment,
  contractWindow,
  type ContractRow,
  type ScopeItemRow,
  type FinancialsRow,
  type ContentItemLite,
  type ScopeAttainment,
} from "@/lib/metrics/contracts";

type Client = ReturnType<typeof createServerSupabaseClient>;

export interface NamedRow {
  id: string;
  name: string;
}
export interface DepartmentRow {
  id: string;
  name: string;
  lead_user_id: string | null;
}

export interface ContractsData {
  contracts: ContractRow[];
  scopeItems: ScopeItemRow[];
  financialsByContract: Map<string, FinancialsRow>;
  brands: NamedRow[];
  departments: DepartmentRow[];
  projects: NamedRow[];
  bpmRows: BpmRow[];
  liveSessions: LiveSession[];
  contentItems: ContentItemLite[];
}

export async function loadContractsData(
  supabase: Client,
  opts?: { archived?: boolean }
): Promise<ContractsData> {
  const u = supabase as unknown as { from: (t: string) => any };

  // The default list is active-only; the Archived view shows only archived
  // contracts. Every other caller omits `opts` and keeps active-only behavior.
  const contractsQuery = u
    .from("client_contracts")
    .select("*")
    .order("created_at", { ascending: false });

  const [contractsRes, scopeRes, finRes, brandsRes, deptsRes, projectsRes, liveRes, contentRes, bpmRows] =
    await Promise.all([
      opts?.archived
        ? contractsQuery.not("archived_at", "is", null)
        : contractsQuery.is("archived_at", null),
      u.from("contract_scope_items").select("*").order("created_at", { ascending: true }),
      u
        .from("contract_financials")
        .select("id, contract_id, monthly_fee, monthly_ad_budget, gross_margin_pct, notes"),
      supabase.from("brands").select("id, name").order("name"),
      u.from("departments").select("id, name, lead_user_id").order("name"),
      supabase.from("projects").select("id, name"),
      u.from("live_sessions").select("*"),
      u.from("content_items").select("brand_id, status, publish_date"),
      fetchCommerceRows(supabase),
    ]);

  const financialsByContract = new Map<string, FinancialsRow>();
  for (const f of (finRes.data ?? []) as FinancialsRow[]) {
    financialsByContract.set(f.contract_id, f);
  }

  return {
    contracts: (contractsRes.data ?? []) as ContractRow[],
    scopeItems: (scopeRes.data ?? []) as ScopeItemRow[],
    financialsByContract,
    brands: (brandsRes.data ?? []) as unknown as NamedRow[],
    departments: (deptsRes.data ?? []) as DepartmentRow[],
    projects: (projectsRes.data ?? []) as unknown as NamedRow[],
    bpmRows,
    liveSessions: (liveRes.data ?? []) as LiveSession[],
    contentItems: (contentRes.data ?? []) as ContentItemLite[],
  };
}

// Compute attainment for a set of scope items using pre-fetched data. Each item's
// contract window and (RLS-permitting) ad budget are resolved from `data`.
export function buildScopeAttainment(
  data: ContractsData,
  items: ScopeItemRow[],
  today?: string
): ScopeAttainment[] {
  const contractById = new Map(data.contracts.map((c) => [c.id, c]));
  return items.map((item) => {
    const contract = contractById.get(item.contract_id) ?? null;
    const window = contract ? contractWindow(contract) : null;
    const monthlyAdBudget =
      data.financialsByContract.get(item.contract_id)?.monthly_ad_budget ?? null;
    return {
      item,
      attainment: computeAttainment({
        item,
        window,
        bpmRows: data.bpmRows,
        liveSessions: data.liveSessions,
        contentItems: data.contentItems,
        monthlyAdBudget,
        today,
      }),
    };
  });
}
