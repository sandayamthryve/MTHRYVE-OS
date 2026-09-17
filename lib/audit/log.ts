// lib/audit/log.ts — the ONE writer for the privileged-action audit trail
// (public.audit_log). Every privileged site (role / employment changes, the
// governed permanent-delete lifecycle, probation decisions, approval decisions)
// records ONE row here through writeAudit.
//
// TWO non-negotiable properties, both enforced in this file:
//   1. SERVICE-ROLE write. audit_log has no INSERT policy, so a user (RLS)
//      client can never write — or forge — a row. writeAudit always uses the
//      service-role key, which bypasses RLS. This is why the trail can never be
//      blocked by RLS (audit must always be able to record) and can never be
//      tampered with from a session.
//   2. BEST-EFFORT. writeAudit NEVER throws. A failed audit insert must not
//      break the action it records — recording the trail is a side effect, not a
//      precondition. Every path is wrapped; failures are swallowed silently.
//
// audit_log isn't in the generated Database types, so it's reached through the
// same cast shim the rest of the OS uses for not-yet-typed tables.

import { createServiceRoleClient } from "@/lib/supabase/service";

type Shim = { from: (t: string) => any };

export interface WriteAuditInput {
  // Caps-snake verb — the action being recorded. The one required field.
  action: string;
  // What it touched: the kind ('user' | 'action_request' | 'task' | ...) and the
  // row id. Both optional (some actions are org-level, not row-level).
  entityType?: string | null;
  entityId?: string | null;
  // Small before→after / decision payload. Keep it tiny — never the full row,
  // never secrets.
  detail?: Record<string, unknown> | null;
  // The actor, from the verified session. Null => a system-executed step, which
  // is stamped actor_role 'system' by default.
  actorUserId?: string | null;
  actorRole?: string | null;
  // The owning org. Passed explicitly by every call site (each has the verified
  // profile.org_id). When omitted, it's resolved from actorUserId; if it still
  // can't be determined the row is skipped — an audit_log row is worthless
  // without an org, and the write must never guess or throw.
  orgId?: string | null;
  // Best-effort client IP. When omitted, writeAudit reads it from the request
  // headers (call sites run inside a server action / route). Never required.
  ip?: string | null;
}

// Read the caller's IP from the request headers, best-effort. Uses a dynamic
// import so this module stays usable outside a request scope (where next/headers
// throws) — any failure just yields null.
async function resolveIp(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const h = headers();
    const xff = h.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim() || null;
    return h.get("x-real-ip")?.trim() || null;
  } catch {
    return null;
  }
}

// Resolve the actor's org from their user row (service-role, RLS-bypassing).
// Only used as a fallback when a call site didn't pass orgId.
async function resolveOrgFromActor(db: Shim, actorUserId: string): Promise<string | null> {
  try {
    const { data } = await db
      .from("users")
      .select("org_id")
      .eq("id", actorUserId)
      .maybeSingle();
    return (data as { org_id?: string } | null)?.org_id ?? null;
  } catch {
    return null;
  }
}

// Record ONE privileged action. Best-effort: returns quietly on any failure and
// never throws, so a caller can `await writeAudit(...)` inline without a guard.
export async function writeAudit(input: WriteAuditInput): Promise<void> {
  try {
    const db = createServiceRoleClient() as unknown as Shim;

    // Every row needs an org. Prefer the explicit one; otherwise derive it from
    // the actor. No org → skip (never guess, never throw).
    let orgId = input.orgId ?? null;
    if (!orgId && input.actorUserId) {
      orgId = await resolveOrgFromActor(db, input.actorUserId);
    }
    if (!orgId) return;

    const ip = input.ip !== undefined ? input.ip : await resolveIp();

    await db.from("audit_log").insert({
      org_id: orgId,
      actor_user_id: input.actorUserId ?? null,
      // A missing actor means a system step; stamp it so the trail reads honestly.
      actor_role: input.actorRole ?? (input.actorUserId ? null : "system"),
      action: input.action,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      detail: input.detail ?? null,
      ip: ip ?? null,
    });
  } catch {
    // Recording the trail must never break the action it describes.
  }
}
