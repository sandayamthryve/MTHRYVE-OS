"use server";
// lib/briefings/generate.ts
// The ONE briefing generation engine (Step 1), extracted from the Command
// Center / Account Intelligence / Departments pages so every surface that shows
// a briefing — including the reusable <AiBrief> on Reports and Campaigns —
// drives the same server actions. No new tables, no second engine.
//
// Each action: enforces role via RLS-mirroring requireRole, gathers ONLY real
// rows, refuses to invent when data is too thin, calls Anthropic through the
// shared fetch helper, and writes back to the existing *_briefings tables.
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { todayManila } from "@/lib/metrics/windows";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";
import { runOrgBriefing } from "@/lib/briefings/org-briefing-core";
import { runAccountBriefing } from "@/lib/briefings/account-briefing-core";
import { runDepartmentActionPlan } from "@/lib/briefings/department-briefing-core";
import { parseBriefingJson } from "@/lib/briefings/account-data";
import {
  gatherFinanceData,
  buildFinancePrompt,
  financeDataSources,
  financeIsEmpty,
  financeBaselineConfidence,
  FINANCE_SYSTEM_PROMPT,
} from "@/lib/briefings/finance-data";
import type { Solution } from "@/lib/briefings/read";
import { anthropicMessages } from "@/lib/briefings/anthropic";

const MODEL_BY_ROLE: Record<string, string> = {
  ceo: "claude-opus-4-8",
  coo: "claude-opus-4-8",
  department_head: "claude-sonnet-5",
  team_member: "claude-haiku-4-5",
};

// Inserts to tables missing from the generated types go through this shim, the
// same escape hatch the pages have always used for the *_briefings tables.
type DbInsertShim = {
  from: (t: string) => { insert: (v: Record<string, unknown>) => Promise<unknown> };
};

// The shared Anthropic call now lives in lib/briefings/anthropic.ts so the
// per-metric Mission Control briefs reuse the exact same request path.

// ── ORG ──────────────────────────────────────────────────────────────────────
// The org executive briefing now runs through the SHARED core
// (lib/briefings/org-briefing-core.ts), so this interactive "Refresh briefing"
// action and the GitHub Actions daily regeneration route build the identical grounded prompt
// against the identical canonical sources and write the identical org_briefings
// shape. This action only adds the leadership gate, the role→model choice, the
// generated_by attribution, and the page revalidation.
export async function generateOrgBriefing() {
  const profile = (await requireRole([
    "ceo",
    "coo",
    "department_head",
    "team_member",
  ])) as unknown as { id: string; org_id: string; role: string };

  const supabase = createServerSupabaseClient();
  const model = MODEL_BY_ROLE[profile.role] ?? "claude-haiku-4-5";
  await runOrgBriefing(supabase as unknown as { from: (t: string) => any }, {
    orgId: profile.org_id,
    model,
    generatedBy: profile.id,
  });
  revalidatePath("/");
  revalidatePath("/reports");
}

// ── ACCOUNT (brand) ──────────────────────────────────────────────────────────
// Thin wrapper over the SHARED core (lib/briefings/account-briefing-core →
// runAccountBriefing): this interactive action and the GitHub Actions daily route build the
// identical grounded prompt against the identical canonical sources and write the
// identical account_briefings shape. This action only adds the role gate, the
// role→model choice, the generated_by attribution, and the page revalidation.
export async function generateAccountBriefing(formData: FormData) {
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
    role: string;
  };
  const brandId = String(formData.get("brand_id") ?? "");
  if (!brandId) return;

  const supabase = createServerSupabaseClient();
  const model = MODEL_BY_ROLE[profile.role] ?? "claude-haiku-4-5";
  await runAccountBriefing(supabase as unknown as { from: (t: string) => any }, {
    orgId: profile.org_id,
    brandId,
    model,
    generatedBy: profile.id,
  });
  revalidatePath("/accounts");
  revalidatePath("/campaigns");
}

// ── DEPARTMENT ────────────────────────────────────────────────────────────────
// Thin wrapper over the SHARED core (lib/briefings/department-briefing-core →
// runDepartmentActionPlan): the interactive "Refresh Action Plan" action and the
// GitHub Actions daily route build the identical grounded prompt against the identical
// canonical sources and write the identical department_briefings shape. This
// action only adds the leadership gate, the role→model choice, the generated_by
// attribution, and the page revalidation.
export async function generateDepartmentActionPlan(formData: FormData) {
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as {
    id: string;
    org_id: string;
    role: string;
  };
  const departmentId = String(formData.get("department_id") ?? "");
  if (!departmentId) return;

  const supabase = createServerSupabaseClient();
  const model = TIER_MODEL[defaultTierFor(profile.role)];
  await runDepartmentActionPlan(supabase as unknown as { from: (t: string) => any }, {
    orgId: profile.org_id,
    departmentId,
    model,
    generatedBy: profile.id,
  });
  revalidatePath("/departments");
  revalidatePath("/metrics");
  revalidatePath("/reports");
}

// ── FINANCE (ceo/coo only) ─────────────────────────────────────────────────────
// Same shape and shared engine as the account brief; only the grounding data and
// the CEO/COO gate differ. Grounds ONLY in real finance data — the cash-flow
// forecast engine as the primary input, plus settlement/retainer inflows, ledger
// outflows, upcoming payroll and contract fees/margins. Writes ONE row to
// finance_briefings. When cash_positions is empty it flags the missing position
// honestly and caps confidence — never inventing a balance or a runway.
export async function generateFinanceBriefing() {
  // Gate to ceo/coo server-side (defense in depth on top of the ceo/coo-only RLS
  // on finance_briefings). requireRole redirects anyone else away — no other role
  // can reach this action or read/insert a finance briefing.
  const profile = (await requireRole(["ceo", "coo"])) as unknown as {
    id: string;
    org_id: string;
    role: string;
  };

  const supabase = createServerSupabaseClient();
  const data = await gatherFinanceData(supabase, profile.org_id);
  const dataSources = financeDataSources(data);
  const model = MODEL_BY_ROLE[profile.role] ?? "claude-opus-4-8";
  const db = supabase as unknown as DbInsertShim;

  const today = todayManila();
  const period_start = `${today.slice(0, 7)}-01`;
  const noAnchor = !data.cashflow.anchor;

  // Nothing to brief on — no cash anchor and no finance signals at all. Record an
  // honest, low-confidence note instead of calling the model.
  if (financeIsEmpty(data)) {
    await db.from("finance_briefings").insert({
      org_id: profile.org_id,
      period_start,
      period_end: today,
      data_confidence: "insufficient",
      data_sources: dataSources,
      summary:
        "Not enough finance data to brief on yet. No cash position is set (cash_positions is empty), and there are no settlements, retainers, payroll runs, or ledger entries on file. Set the current cash on hand above and record real finance activity, then generate again — the OS never assumes a balance it wasn't given.",
      challenges: ["No cash position set — runway is unknown."],
      bottlenecks: [],
      solutions: [],
      model,
      generated_by: profile.id,
    });
    revalidatePath("/finance");
    return;
  }

  const userPrompt = buildFinancePrompt(data);

  let confidence = financeBaselineConfidence(data);
  let summary = "";
  let challenges: string[] = [];
  let bottlenecks: string[] = [];
  let solutions: Solution[] = [];

  try {
    const text = await anthropicMessages({ model, system: FINANCE_SYSTEM_PROMPT, user: userPrompt, maxTokens: 1500 });
    const parsed = parseBriefingJson<{
      data_confidence?: string;
      summary?: string;
      challenges?: string[];
      bottlenecks?: string[];
      solutions?: Solution[];
    }>(text);
    if (!parsed) throw new Error("could not parse model JSON");
    if (parsed.data_confidence) confidence = parsed.data_confidence;
    summary = parsed.summary ?? "";
    challenges = Array.isArray(parsed.challenges) ? parsed.challenges : [];
    bottlenecks = Array.isArray(parsed.bottlenecks) ? parsed.bottlenecks : [];
    solutions = Array.isArray(parsed.solutions) ? parsed.solutions : [];
  } catch (e) {
    // Never invent advice on failure — store an honest, low-confidence note.
    confidence = "insufficient";
    summary = `Could not generate an AI finance brief (${
      e instanceof Error ? e.message : "unknown error"
    }). The cash-flow forecast and P&L below are still read from your live data — try again shortly.`;
    challenges = noAnchor ? ["No cash position set — runway is unknown."] : [];
    bottlenecks = [];
    solutions = [];
  }

  // Honesty cap: with no cash position the forecast can't produce a trustworthy
  // runway, so a finance brief can never be more than "low" confidence — no matter
  // what the model claimed. And make sure the missing position is stated.
  if (noAnchor) {
    if (confidence === "high" || confidence === "medium") confidence = "low";
    if (!challenges.some((c) => /cash position/i.test(c))) {
      challenges = ["No cash position set — runway is unknown.", ...challenges];
    }
  }

  await db.from("finance_briefings").insert({
    org_id: profile.org_id,
    period_start,
    period_end: today,
    data_confidence: confidence,
    data_sources: dataSources,
    summary,
    challenges,
    bottlenecks,
    solutions,
    model,
    generated_by: profile.id,
  });
  revalidatePath("/finance");
}
