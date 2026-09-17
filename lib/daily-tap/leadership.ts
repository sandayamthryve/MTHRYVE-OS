// lib/daily-tap/leadership.ts — the leadership (ceo/coo) tap: the ONE place the
// Daily Tap spends a model call.
//
// It reads the org-wide signals (Operating Score, off-target fires, pending
// approvals, latest council briefs) deterministically from real rows, then makes
// a SINGLE Sonnet synthesis call to frame them into a short morning read. The
// call is logged to ai_usage_log with feature='daily_tap' (reusing the Cognition
// logger). Money stays gated: the digest SURFACES the pending-approval count and
// the council briefs, it never approves or acts on anything.
//
// If the model call fails (no key / network / unreadable), the tap degrades to
// the same deterministic signals with no synthesis paragraph — an honest brief,
// never a fabricated one.

import { logCognitionUsage } from "@/lib/cognition/usage";
import { anthropicMessagesWithUsage } from "@/lib/briefings/anthropic";
import { TIER_MODEL } from "@/lib/ai/models";
import {
  allCompartmentCodes,
  readOrgReadings,
  operatingScore,
  verdictWord,
  type TapReading,
} from "@/lib/daily-tap/metrics";

type Shim = { from: (t: string) => any };

const SONNET = TIER_MODEL.standard; // "claude-sonnet-5"

export interface CouncilBrief {
  member: string;
  status: string;
  created_at: string;
}

export interface LeadershipSignals {
  score: { value: number | null; graded: number };
  total: number; // total graded-or-not readings
  offTarget: TapReading[]; // red first, then amber (top fires)
  pendingApprovals: number;
  councilBriefs: CouncilBrief[];
}

// Read the org-wide leadership signals. All reads are org-scoped explicitly
// because the tap runs on the service-role client (no RLS). Best-effort: a
// failed sub-read degrades to a neutral value, never throws.
export async function readLeadershipSignals(db: Shim, orgId: string): Promise<LeadershipSignals> {
  const codes = await allCompartmentCodes(db);
  const readings = await readOrgReadings(db, orgId, codes);
  const score = operatingScore(readings);

  // Off-target fires: red first, then amber. Ungraded / green are not fires.
  const offTarget = readings
    .filter((r) => r.dot === "red" || r.dot === "amber")
    .sort((a, b) => (a.dot === "red" ? 0 : 1) - (b.dot === "red" ? 0 : 1))
    .slice(0, 5);

  const [pendingApprovals, councilBriefs] = await Promise.all([
    countPendingApprovals(db, orgId),
    readLatestCouncilBriefs(db, orgId),
  ]);

  return { score, total: readings.length, offTarget, pendingApprovals, councilBriefs };
}

async function countPendingApprovals(db: Shim, orgId: string): Promise<number> {
  try {
    const { count } = await db
      .from("action_requests")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending");
    return count ?? 0;
  } catch {
    return 0;
  }
}

// The newest council brief per member key (source_module='council'), org-scoped.
async function readLatestCouncilBriefs(db: Shim, orgId: string): Promise<CouncilBrief[]> {
  try {
    const { data } = await db
      .from("action_requests")
      .select("status, created_at, source_ref")
      .eq("org_id", orgId)
      .eq("source_module", "council")
      .order("created_at", { ascending: false })
      .limit(30);
    const latest = new Map<string, CouncilBrief>();
    for (const row of (data ?? []) as Array<{
      status: string;
      created_at: string;
      source_ref: { member?: string } | null;
    }>) {
      const member = row.source_ref?.member;
      if (!member || latest.has(member)) continue; // newest-first → first wins
      latest.set(member, { member, status: row.status, created_at: row.created_at });
    }
    return Array.from(latest.values()).slice(0, 4);
  } catch {
    return [];
  }
}

// The deterministic facts block the synthesis grounds on — real numbers only,
// honest "—" where a signal is empty. Also used verbatim as the fallback body.
export function leadershipFacts(sig: LeadershipSignals): string[] {
  const lines: string[] = [];
  lines.push(
    sig.score.value == null
      ? `Operating Score: no score yet — no metrics are graded against a target.`
      : `Operating Score: ${sig.score.value}/100 across ${sig.score.graded} graded metric${
          sig.score.graded === 1 ? "" : "s"
        }.`
  );
  if (sig.offTarget.length === 0) {
    lines.push("Off-target fires: none — every graded metric is on target.");
  } else {
    lines.push(`Off-target fires (${sig.offTarget.length}):`);
    for (const r of sig.offTarget) {
      const vs = r.targetText ? ` vs target ${r.targetText}` : "";
      lines.push(`  • ${r.label} — ${r.valueText}${vs} · ${verdictWord(r.dot)}`);
    }
  }
  lines.push(
    `Pending approvals: ${sig.pendingApprovals} awaiting a decision (surfaced for review — nothing auto-approves).`
  );
  if (sig.councilBriefs.length > 0) {
    lines.push(`Latest council briefs: ${sig.councilBriefs.map((b) => `${b.member} (${b.status})`).join(", ")}.`);
  }
  return lines;
}

const SYSTEM_PROMPT = [
  "You are the Chief of Staff writing a CEO/COO's morning brief for Mthryve OS.",
  "You are given the day's REAL operating signals as a facts block. Write a tight,",
  "2-4 sentence synthesis a leader can read in ten seconds: what the numbers say,",
  "which fire to look at first, and what decision is waiting.",
  "",
  "ABSOLUTE RULES:",
  "- Ground every claim in the facts block. Never invent, round, or extrapolate a number.",
  "- Where a signal reads 'no score yet' or 'none', say so plainly — do not manufacture one.",
  "- You SURFACE the pending approvals and council briefs; you never approve, act, or",
  "  recommend spending money. This is a read, not an action.",
  "- Plain prose, no headers, no markdown, no lists. Just the synthesis paragraph.",
].join("\n");

// Build the leadership tap summary. Makes ONE Sonnet call and logs it; on any
// failure returns the deterministic facts with aiUsed=false. Returns the body
// text and whether AI was used (so the caller records ai_used honestly).
export async function buildLeadershipBody(
  db: Shim,
  orgId: string,
  userId: string,
  sig: LeadershipSignals
): Promise<{ body: string; aiUsed: boolean }> {
  const facts = leadershipFacts(sig);
  const factsBlock = facts.join("\n");

  let synthesis: string | null = null;
  try {
    const { text, usage } = await anthropicMessagesWithUsage({
      model: SONNET,
      system: SYSTEM_PROMPT,
      user: `Today's operating signals:\n\n${factsBlock}\n\nWrite the morning synthesis.`,
      maxTokens: 400,
    });
    // Log the spend regardless of how usable the text is — it cost money.
    await logCognitionUsage(db as any, {
      orgId,
      userId,
      model: SONNET,
      usage,
      feature: "daily_tap",
    });
    const trimmed = text.trim();
    if (trimmed) synthesis = trimmed;
  } catch {
    synthesis = null; // honest degrade to the deterministic facts
  }

  const parts: string[] = [];
  if (synthesis) parts.push(synthesis, "");
  parts.push(factsBlock);
  return { body: parts.join("\n"), aiUsed: synthesis != null };
}
