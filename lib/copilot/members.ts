// lib/copilot/members.ts — the ROSTER layer for the Copilot Fleet.
//
// A copilot IS a council_members row (same key / name / title / domain / persona
// / compartment_codes) made conversational, so the fleet reuses the Council's own
// reads rather than a second roster. This module is a thin, intention-revealing
// facade over lib/council/members: same rows, framed as "copilots you can talk
// to" plus each copilot's live grounding status for the hub picker.

import { readCompartmentScope } from "@/lib/cognition/scope";
import { aggregateDot, type CouncilMember } from "@/lib/council/members";
import type { HealthDot } from "@/lib/metrics/types";

export type Copilot = CouncilMember;

type Shim = { from: (t: string) => any };

// The whole fleet, in display order. RLS scopes the read to authenticated users
// (org-read for v1, like the Council). A failed/empty read yields [].
export async function readCopilots(db: Shim): Promise<Copilot[]> {
  const { data } = await db
    .from("council_members")
    .select("key, name, title, domain, persona, compartment_codes, extra_scope, sort_order")
    .order("sort_order", { ascending: true });
  return ((data ?? []) as Copilot[]).map((m) => ({
    ...m,
    compartment_codes: Array.isArray(m.compartment_codes) ? m.compartment_codes : [],
  }));
}

// One copilot by key (for the chat endpoint + per-copilot page). Null when not
// found / not readable.
export async function readCopilot(db: Shim, key: string): Promise<Copilot | null> {
  const { data } = await db
    .from("council_members")
    .select("key, name, title, domain, persona, compartment_codes, extra_scope, sort_order")
    .eq("key", key)
    .maybeSingle();
  if (!data) return null;
  const m = data as Copilot;
  return { ...m, compartment_codes: Array.isArray(m.compartment_codes) ? m.compartment_codes : [] };
}

// The at-a-glance grounding a fleet card shows: the copilot's aggregate health
// light plus honest grounded/total metric counts. Computed via the Cognition
// Loop's deterministic READ half — no model call. A copilot with no compartments
// wired reads mapped=false ("persona only" — it can still chat, just ungrounded).
export interface CopilotStatus {
  key: string;
  mapped: boolean;
  dot: HealthDot;
  grounded: number;
  total: number;
}

export async function readCopilotStatus(db: Shim, member: Copilot): Promise<CopilotStatus> {
  if ((member.compartment_codes?.length ?? 0) === 0) {
    return { key: member.key, mapped: false, dot: null, grounded: 0, total: 0 };
  }
  const scope = await readCompartmentScope(db, member.compartment_codes);
  return {
    key: member.key,
    mapped: true,
    dot: aggregateDot(scope.readings),
    grounded: scope.grounded,
    total: scope.readings.length,
  };
}
