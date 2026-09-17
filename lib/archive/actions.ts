"use server";

// lib/archive/actions.ts — the four shared server actions behind Edit +
// Soft-Archive on every user-facing cluster. They are cluster-KEYED, never
// table-keyed from the client: the caller sends a stable `cluster` string and an
// `id`, and the action resolves the table + gate + revalidate paths from the
// server-side registry (lib/archive/config). A malicious client therefore can't
// point these at an arbitrary table, nor smuggle a non-whitelisted column into
// an edit — the field list is read from the registry, not the form.
//
// Authority model:
//   • edit / archive / restore → the cluster's EXISTING write-gate (canWrite),
//     reused verbatim, plus any per-row guard (lead ownership, expense safe
//     state, non-sent outreach, draft payroll, op-record workflow stage).
//   • hard-delete → ceo/coo ONLY, regardless of the cluster's write-gate, and
//     executed through the service-role client so it works uniformly even on the
//     ~11 tables that have no RLS DELETE policy. Every delete is audited.
//
// Archive stamps archived_at = now() AND archived_by = the actor; restore clears
// both. Default list queries filter archived_at IS NULL (added per cluster), so
// an archived row simply drops out of the default list and reappears only in the
// cluster's Archived view.

import { revalidatePath } from "next/cache";
import { requireProfile, type SessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import {
  CLUSTERS,
  canHardDelete,
  type ArchiveActionState,
  type ClusterConfig,
  type ClusterKey,
  type FieldSpec,
} from "@/lib/archive/config";

// These tables aren't all in the generated Supabase types; the whole OS reaches
// them through the same cast shim, so we do too.
type Shim = { from: (t: string) => any };

let nonceCounter = 0;
function ok(): ArchiveActionState {
  return { ok: true, nonce: ++nonceCounter };
}
function fail(error: string): ArchiveActionState {
  return { ok: false, error, nonce: ++nonceCounter };
}

// Resolve + validate the cluster key coming from the client. Unknown keys are
// rejected before anything touches the database.
function resolve(formData: FormData): { cluster: ClusterKey; config: ClusterConfig; id: string } | null {
  const cluster = String(formData.get("cluster") ?? "") as ClusterKey;
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return null;
  const config = (CLUSTERS as Record<string, ClusterConfig>)[cluster];
  if (!config) return null;
  return { cluster, config, id };
}

function revalidate(config: ClusterConfig) {
  for (const path of config.revalidate) {
    try {
      revalidatePath(path);
    } catch {
      // A bad path must never take down the write it follows.
    }
  }
}

// Load the guard columns for a row and run the cluster's per-row guard. Returns
// a friendly error when the guard blocks the write, null when it passes.
async function checkRowGuard(
  db: Shim,
  config: ClusterConfig,
  profile: SessionProfile,
  id: string
): Promise<string | null> {
  if (!config.rowGuard) return null;
  const cols = config.guardColumns ?? "id, org_id, status";
  const { data } = await db.from(config.table).select(cols).eq("id", id).eq("org_id", profile.org_id).maybeSingle();
  if (!data) return "That record no longer exists.";
  const verdict = config.rowGuard(profile, data as Record<string, unknown>);
  return verdict.ok ? null : verdict.error ?? "That record can't be changed right now.";
}

// Coerce one submitted field to its typed value, or throw a friendly message.
function coerceField(spec: FieldSpec, raw: string): unknown {
  const v = raw.trim();
  if (!v) {
    if (spec.required) throw new Error(`${spec.label} is required.`);
    return null;
  }
  switch (spec.type) {
    case "number": {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${spec.label} must be a number.`);
      return n;
    }
    case "date":
      // A YYYY-MM-DD string; Postgres date accepts it directly.
      return v;
    default:
      return v;
  }
}

// ── Edit ────────────────────────────────────────────────────────────────────
// Generic edit for clusters that declare editFields (those without a bespoke
// edit UI). Only whitelisted fields are read; everything else in the form is
// ignored. Clusters that own their own edit form have no editFields and this
// action refuses them, so we never duplicate or loosen an existing editor.
export async function editRow(
  _prev: ArchiveActionState | null,
  formData: FormData
): Promise<ArchiveActionState> {
  const r = resolve(formData);
  if (!r) return fail("Unknown record.");
  const { config, id, cluster } = r;
  if (!config.editFields || config.editFields.length === 0) {
    return fail("This record isn't editable here.");
  }
  const profile = await requireProfile();
  if (!config.canWrite(profile)) return fail(`You don't have permission to edit this ${config.label}.`);

  const guardError = await checkRowGuard(createServerSupabaseClient() as unknown as Shim, config, profile, id);
  if (guardError) return fail(guardError);

  const patch: Record<string, unknown> = {};
  try {
    for (const spec of config.editFields) {
      // Only touch a field the form actually submitted, so a partial form never
      // nulls out untouched columns.
      if (!formData.has(spec.name)) continue;
      patch[spec.name] = coerceField(spec, String(formData.get(spec.name) ?? ""));
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Invalid input.");
  }
  if (Object.keys(patch).length === 0) return fail("Nothing to save.");

  const db = createServerSupabaseClient() as unknown as Shim;
  const { error } = await db.from(config.table).update(patch).eq("id", id).eq("org_id", profile.org_id);
  if (error) return fail(error.message || "Could not save changes.");

  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: null,
    event: "record_edited",
    actor_id: profile.id,
    actor_role: profile.role,
    detail: { cluster, table: config.table, id, fields: Object.keys(patch) },
  });
  revalidate(config);
  return ok();
}

// ── Archive ───────────────────────────────────────────────────────────────
export async function archiveRow(
  _prev: ArchiveActionState | null,
  formData: FormData
): Promise<ArchiveActionState> {
  const r = resolve(formData);
  if (!r) return fail("Unknown record.");
  const { config, id, cluster } = r;
  const profile = await requireProfile();
  if (!config.canWrite(profile)) return fail(`You don't have permission to archive this ${config.label}.`);

  const db = createServerSupabaseClient() as unknown as Shim;
  const guardError = await checkRowGuard(db, config, profile, id);
  if (guardError) return fail(guardError);

  const { error } = await db
    .from(config.table)
    .update({ archived_at: new Date().toISOString(), archived_by: profile.id })
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .is("archived_at", null); // idempotent: don't re-stamp an already-archived row
  if (error) return fail(error.message || "Could not archive.");

  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: null,
    event: "record_archived",
    actor_id: profile.id,
    actor_role: profile.role,
    detail: { cluster, table: config.table, id },
  });
  revalidate(config);
  return ok();
}

// ── Restore ─────────────────────────────────────────────────────────────────
// Clears archived_at/archived_by. Governed by the same write-gate + per-row
// guard as archive (leadership is always inside every write-gate, so leadership
// can always restore).
export async function restoreRow(
  _prev: ArchiveActionState | null,
  formData: FormData
): Promise<ArchiveActionState> {
  const r = resolve(formData);
  if (!r) return fail("Unknown record.");
  const { config, id, cluster } = r;
  const profile = await requireProfile();
  if (!config.canWrite(profile)) return fail(`You don't have permission to restore this ${config.label}.`);

  const db = createServerSupabaseClient() as unknown as Shim;
  const guardError = await checkRowGuard(db, config, profile, id);
  if (guardError) return fail(guardError);

  const { error } = await db
    .from(config.table)
    .update({ archived_at: null, archived_by: null })
    .eq("id", id)
    .eq("org_id", profile.org_id);
  if (error) return fail(error.message || "Could not restore.");

  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: null,
    event: "record_restored",
    actor_id: profile.id,
    actor_role: profile.role,
    detail: { cluster, table: config.table, id },
  });
  revalidate(config);
  return ok();
}

// ── Hard-delete ───────────────────────────────────────────────────────────
// ceo/coo ONLY. Irreversible. Runs through the service-role client so it works
// uniformly across every cluster regardless of whether the table has an RLS
// DELETE policy — the ceo/coo app gate is the authoritative guard here, and the
// delete is org-scoped and audited. This is the one action that ignores the
// cluster's own write-gate (a warehouse writer can archive a product but cannot
// hard-delete one).
export async function hardDeleteRow(
  _prev: ArchiveActionState | null,
  formData: FormData
): Promise<ArchiveActionState> {
  const r = resolve(formData);
  if (!r) return fail("Unknown record.");
  const { config, id, cluster } = r;

  // Defense in depth: a governed cluster's only permanent-delete path is the
  // COO→CEO request gate, and an archive-only cluster has NO permanent-delete
  // path at all. Refuse the raw one-click here for BOTH — even if the form is
  // POSTed directly — so this action can never bypass the gate or resurrect a
  // hard-delete the UI intentionally hides.
  if (config.archiveOnly) {
    return fail(`A ${config.label} can't be permanently deleted — archive it instead.`);
  }
  if (config.governedDeleteEntity) {
    return fail(`A ${config.label} is deleted through the COO→CEO approval gate, not here.`);
  }

  const profile = await requireProfile();
  if (!canHardDelete(profile)) {
    return fail("Only the CEO or COO can permanently delete records.");
  }

  const svc = createServiceRoleClient() as unknown as Shim;
  const { error } = await svc.from(config.table).delete().eq("id", id).eq("org_id", profile.org_id);
  if (error) return fail(error.message || "Could not delete. It may be referenced by other records.");

  // Audit through the RLS user client so org_id is stamped by the same path as
  // every other action-spine event.
  await writeActionAudit(createServerSupabaseClient() as unknown as Shim, {
    org_id: profile.org_id,
    action_request_id: null,
    event: "record_hard_deleted",
    actor_id: profile.id,
    actor_role: profile.role,
    detail: { cluster, table: config.table, id },
  });
  revalidate(config);
  return ok();
}
