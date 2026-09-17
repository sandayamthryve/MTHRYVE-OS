// lib/briefings/account-briefing-core.ts
// PR 8 — the ONE account-briefing generation core, shared by the interactive
// "Refresh briefing" server action (lib/briefings/generate.ts →
// generateAccountBriefing) and the GitHub Actions daily regeneration route
// (app/api/automation/account-briefings). Extracting it means a human refresh and
// the scheduled machine run gather the SAME real rows, build the SAME grounded
// prompt, and write the SAME account_briefings shape — the narrative can never
// diverge by path. This mirrors lib/briefings/org-briefing-core.ts exactly.
//
// Every read is brand-scoped (brand_id is globally unique) with an explicit org_id
// where a table is org-wide, so it works unchanged under the request-scoped RLS
// client AND under the RLS-bypassing service-role client the machine run uses.
//
// Grounds ONLY in real rows; refuses to invent when data is too thin (records an
// honest "insufficient" note, no AI call). Never throws for the caller — returns a
// small status object so the route can fold many brands and the action can revalidate.
import {
  gatherBrandData,
  computeBadge,
  computeFlags,
  buildAccountPrompt,
  parseBriefingJson,
  ACCOUNT_SYSTEM_PROMPT,
} from "@/lib/briefings/account-data";
import { anthropicMessages } from "@/lib/briefings/anthropic";
import type { Solution } from "@/lib/briefings/read";

// A minimal structural client — satisfied by both the RLS server client and the
// service-role client, the same shim the rest of the briefing layer casts to.
type AnyClient = { from: (t: string) => any };

export interface RunAccountBriefingResult {
  status: "generated" | "insufficient" | "error";
  data_confidence: string;
}

// Full generate + persist for ONE brand. No auth, no revalidate — the caller owns
// those. generatedBy is null for a machine run (the GitHub Actions schedule has no user).
export async function runAccountBriefing(
  client: AnyClient,
  opts: { orgId: string; brandId: string; model: string; generatedBy: string | null }
): Promise<RunAccountBriefingResult> {
  const { orgId, brandId, model, generatedBy } = opts;

  const data = await gatherBrandData(client as any, brandId, orgId);
  const badge = computeBadge(data);
  const flags = computeFlags(data);
  const dataSources = {
    platform_rows: data.bpm.length,
    snapshots: data.snaps.length,
    tasks: data.tasks.length,
    campaigns: data.campaigns.length,
  };

  // Data-sufficiency guard: refuse to advise on essentially no usable data.
  if (data.bpm.length === 0 && data.tasks.length < 2) {
    await client.from("account_briefings").insert({
      org_id: orgId,
      brand_id: brandId,
      data_confidence: "insufficient",
      data_sources: dataSources,
      summary:
        "Not enough data to give trustworthy advice yet. To unlock a real briefing: connect a marketplace (TikTok Shop / Shopee) or import a platform metrics row for this client, record a metrics snapshot, and log at least a couple of tasks. Once real figures exist, generate again.",
      challenges: [],
      bottlenecks: [],
      solutions: [],
      model,
      generated_by: generatedBy,
    });
    return { status: "insufficient", data_confidence: "insufficient" };
  }

  const userPrompt = buildAccountPrompt(data, badge, flags);

  let confidence = badge.confidence;
  let summary = "";
  let challenges: string[] = [];
  let bottlenecks: string[] = [];
  let solutions: Solution[] = [];

  try {
    const text = await anthropicMessages({
      model,
      system: ACCOUNT_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 1500,
    });
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
    summary = `Could not generate an AI briefing (${
      e instanceof Error ? e.message : "unknown error"
    }). The truthfulness badge and red flags above are still computed from your real data — try again shortly.`;
    challenges = flags;
    bottlenecks = [];
    solutions = [];
  }

  await client.from("account_briefings").insert({
    org_id: orgId,
    brand_id: brandId,
    data_confidence: confidence,
    data_sources: dataSources,
    summary,
    challenges,
    bottlenecks,
    solutions,
    model,
    generated_by: generatedBy,
  });
  return {
    status: summary && confidence !== "insufficient" ? "generated" : "error",
    data_confidence: confidence,
  };
}
