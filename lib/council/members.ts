// lib/council/members.ts — the READ + SHAPE layer for the Executive AI Council.
//
// The council is NOT a new engine: each member IS the Cognition Loop (lib/
// cognition) scoped to that officer's compartment_codes and framed through the
// member's persona. This module only reads the seeded council_members roster,
// aggregates each member's compartment health via the loop's own READ half, and
// maps a completed plan onto the council's action_requests shape. It writes
// nothing — the run action stamps org_id / created_by / status and inserts.

import type { HealthDot } from "@/lib/metrics/types";
import { readCompartmentScope } from "@/lib/cognition/scope";
import { planToDraft } from "@/lib/cognition/plan";
import type { CognitionPlan, CompartmentScope, MetricReading } from "@/lib/cognition/types";
import type { CognitionLens } from "@/lib/cognition/plan";

type Shim = { from: (t: string) => any };

// One roster row (public.council_members — RLS: authenticated read).
export interface CouncilMember {
  key: string; // e.g. "coo"
  name: string; // e.g. "COO AI"
  title: string; // e.g. "Operations & Fulfilment Director"
  domain: string; // e.g. "Ops · Fulfilment · Customer Service"
  persona: string; // the operating lens injected into the plan prompt
  compartment_codes: string[]; // the metric compartments this officer owns
  extra_scope: string | null; // human note on out-of-band scope (v1: display only)
  sort_order: number;
}

// A member is "mapped" (runnable in v1) only when it owns at least one metric
// compartment. cto / bi / hr ship with empty compartment_codes and show a
// "scope pending" state until their reads are wired.
export function isMapped(member: Pick<CouncilMember, "compartment_codes">): boolean {
  return (member.compartment_codes?.length ?? 0) > 0;
}

// The persona → the loop's executive lens (name/title/persona), or undefined for
// an unmapped member (never run).
export function lensFor(member: CouncilMember): CognitionLens {
  return { name: member.name, title: member.title, persona: member.persona };
}

// Read the whole roster, in display order. RLS scopes the read to authenticated
// users; a missing/failed read yields [] (the page shows an honest empty state).
export async function readCouncilMembers(db: Shim): Promise<CouncilMember[]> {
  const { data } = await db
    .from("council_members")
    .select("key, name, title, domain, persona, compartment_codes, extra_scope, sort_order")
    .order("sort_order", { ascending: true });
  return ((data ?? []) as CouncilMember[]).map((m) => ({
    ...m,
    compartment_codes: Array.isArray(m.compartment_codes) ? m.compartment_codes : [],
  }));
}

// One member by key (for the run action). Null when not found / not readable.
export async function readCouncilMember(db: Shim, key: string): Promise<CouncilMember | null> {
  const { data } = await db
    .from("council_members")
    .select("key, name, title, domain, persona, compartment_codes, extra_scope, sort_order")
    .eq("key", key)
    .maybeSingle();
  if (!data) return null;
  const m = data as CouncilMember;
  return { ...m, compartment_codes: Array.isArray(m.compartment_codes) ? m.compartment_codes : [] };
}

// Aggregate one member's compartment health into a single status light —
// worst-wins over the loop's own per-metric dots (healthFor already resolved in
// readCompartmentScope). Any red → red; else any amber → amber; else any green →
// green; else null ("no data yet"). Never fabricated: a compartment with no
// grounded entries aggregates to null, not green.
export function aggregateDot(readings: MetricReading[]): HealthDot {
  let sawAmber = false;
  let sawGreen = false;
  for (const r of readings) {
    if (r.dot === "red") return "red";
    if (r.dot === "amber") sawAmber = true;
    if (r.dot === "green") sawGreen = true;
  }
  if (sawAmber) return "amber";
  if (sawGreen) return "green";
  return null;
}

// The at-a-glance status a member card renders: its aggregate light plus the
// honest grounded/total metric counts. Computed via the loop's READ half over
// the member's compartment_codes — one deterministic read, no model call.
export interface MemberStatus {
  key: string;
  mapped: boolean;
  dot: HealthDot;
  grounded: number;
  total: number;
  scopeLabel: string | null;
}

export async function readMemberStatus(db: Shim, member: CouncilMember): Promise<MemberStatus> {
  if (!isMapped(member)) {
    return { key: member.key, mapped: false, dot: null, grounded: 0, total: 0, scopeLabel: null };
  }
  const scope = await readCompartmentScope(db, member.compartment_codes);
  return {
    key: member.key,
    mapped: true,
    dot: aggregateDot(scope.readings),
    grounded: scope.grounded,
    total: scope.readings.length,
    scopeLabel: scope.label,
  };
}

// The latest council brief filed per member — for the "latest brief" link on the
// council board. Reads the org's council action_requests (RLS-scoped), keeps the
// newest row per member key. The deep link targets #req-<id> on /approvals.
export interface LatestBrief {
  id: string;
  status: string;
  created_at: string;
}

export async function readLatestBriefs(db: Shim): Promise<Map<string, LatestBrief>> {
  const { data } = await db
    .from("action_requests")
    .select("id, status, created_at, source_ref")
    .eq("source_module", "council")
    .order("created_at", { ascending: false });
  const latest = new Map<string, LatestBrief>();
  for (const row of (data ?? []) as Array<LatestBrief & { source_ref: { member?: string } | null }>) {
    const key = row.source_ref?.member;
    if (!key || latest.has(key)) continue; // rows arrive newest-first → first wins
    latest.set(key, { id: row.id, status: row.status, created_at: row.created_at });
  }
  return latest;
}

// Map a completed plan onto the COUNCIL action_requests row. It reuses the loop's
// own planToDraft (evidence / options / confidence / risk / role all identical),
// then re-stamps the row as a council brief: source_module='council',
// source_ref carries the member key (plus the codes for traceability), and the
// title names the officer + domain. proposed_action stays null — a council brief
// is recommendation-only, so NOTHING auto-executes.
export function memberDraft(plan: CognitionPlan, scope: CompartmentScope, member: CouncilMember) {
  const base = planToDraft(plan, scope);
  return {
    ...base,
    source_module: "council" as const,
    source_ref: {
      member: member.key,
      codes: scope.codes,
      compartment: base.source_ref.compartment,
    },
    title: `${member.name} · ${member.domain} — ${scope.grounded}/${scope.readings.length} metrics grounded`,
  };
}
