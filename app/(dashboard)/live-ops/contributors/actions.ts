"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { generateContributorToken } from "@/lib/contributors/tokens";

// Contributor management actions — leadership + department head (mirrors the
// contributors_write RLS: ceo/coo/department_head). Moderator↔brand assignments
// are ceo/coo only (the modassign_write RLS). Every write goes through the
// caller's own RLS-scoped client, so the database re-checks the role on each one.

type Db = { from: (t: string) => any };

const MANAGE_ROLES = ["ceo", "coo", "department_head"] as const;
const ASSIGN_ROLES = ["ceo", "coo"] as const;

function optText(fd: FormData, key: string): string | null {
  const v = String(fd.get(key) ?? "").trim();
  return v || null;
}

// Create a contributor (host or intern). Generates the unguessable token that
// backs their /host/<token> link. Retries once on the (vanishingly unlikely)
// token-uniqueness collision. A department can be set here (or later) — it decides
// which dashboard their daily reports land on and which portal capture they see.
export async function createContributor(formData: FormData) {
  const profile = await requireRole([...MANAGE_ROLES]);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const kind = String(formData.get("kind") ?? "host") === "intern" ? "intern" : "host";
  const handle = optText(formData, "handle");
  const brandId = optText(formData, "brand_id");
  const departmentId = optText(formData, "department_id");
  const platform = optText(formData, "platform");

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  for (let attempt = 0; attempt < 3; attempt++) {
    const token = generateContributorToken();
    const { error } = await db.from("contributors").insert({
      org_id: profile.org_id,
      name,
      handle,
      brand_id: brandId,
      department_id: departmentId,
      platform,
      kind,
      token,
      status: "active",
      created_by: profile.id,
    });
    if (!error) break;
    // 23505 = unique_violation (token). Any other error: stop (don't spin).
    if ((error as { code?: string }).code !== "23505") break;
  }
  revalidatePath("/live-ops/contributors");
}

// Assign / reassign a contributor's department (and optional free-text assignment
// note). The department is what routes their daily reports to a dashboard, so
// leadership / department heads own it (mirrors the contributors_write RLS).
export async function assignDepartment(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const departmentId = optText(formData, "department_id");
  const patch: Record<string, unknown> = {
    department_id: departmentId,
    updated_at: new Date().toISOString(),
  };
  const assignment = optText(formData, "assignment");
  patch.assignment = assignment; // clearing the field to empty sets it NULL

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as Db).from("contributors").update(patch).eq("id", id);
  revalidatePath("/live-ops/contributors");
}

// Assign a task to a contributor — the contributor sees it (open, read-only) on
// their /host portal and can confirm it in today's log. The task is created in the
// caller's own org (RLS re-checks org on insert); contributor_id points at the
// target contributor. Best-effort brand from the contributor so live sessions and
// tasks share a brand.
export async function assignTaskToContributor(formData: FormData) {
  const profile = await requireRole([...MANAGE_ROLES]);
  const contributorId = String(formData.get("contributor_id") ?? "");
  const title = String(formData.get("title") ?? "").trim().slice(0, 300);
  if (!contributorId || !title) return;
  const dueDate = optText(formData, "due_date");

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // Resolve the contributor's brand (same org, RLS-scoped) so the task carries it.
  const { data: contribRow } = await db
    .from("contributors")
    .select("id, brand_id, org_id")
    .eq("id", contributorId)
    .maybeSingle();
  const contrib = contribRow as { id: string; brand_id: string | null } | null;
  if (!contrib) return; // not in caller's org → RLS hid it

  await db.from("tasks").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    title,
    contributor_id: contributorId,
    brand_id: contrib.brand_id,
    priority: "medium",
    status: "todo",
    due_date: dueDate,
  });
  revalidatePath("/live-ops/contributors");
}

// Assign / reassign a contributor's brand (and optionally platform).
export async function assignBrand(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const brandId = optText(formData, "brand_id");
  const patch: Record<string, unknown> = { brand_id: brandId, updated_at: new Date().toISOString() };
  const platform = optText(formData, "platform");
  if (platform !== null) patch.platform = platform;

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as Db).from("contributors").update(patch).eq("id", id);
  revalidatePath("/live-ops/contributors");
}

// Revoke a contributor — their token stops resolving (the /host page shows the
// clean "link expired" screen and the write endpoint rejects). Reversible via
// reactivate. Note: this is the ONLY path that sets status='revoked' — creating a
// new contributor never revokes an existing one (each is its own row + token).
export async function revokeContributor(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as Db)
    .from("contributors")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/live-ops/contributors");
}

export async function reactivateContributor(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as Db)
    .from("contributors")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/live-ops/contributors");
}

// ── Moderator ↔ brand assignments (ceo/coo only) ──────────────────────────────
// These are what scope the moderation + attendance queues: a user with an
// assignment for a brand can review that brand's contributor logs (mirrors the
// contriblogs RLS). Leadership always sees everything regardless.
export async function assignModerator(formData: FormData) {
  const profile = await requireRole([...ASSIGN_ROLES]);
  const userId = String(formData.get("user_id") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");
  if (!userId || !brandId) return;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;
  // Avoid a duplicate (user, brand) pair.
  const { data: existing } = await db
    .from("moderator_brand_assignments")
    .select("id")
    .eq("user_id", userId)
    .eq("brand_id", brandId)
    .maybeSingle();
  if (existing?.id) return;

  await db.from("moderator_brand_assignments").insert({
    org_id: profile.org_id,
    user_id: userId,
    brand_id: brandId,
    created_by: profile.id,
  });
  revalidatePath("/live-ops/contributors");
}

export async function removeModerator(formData: FormData) {
  await requireRole([...ASSIGN_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as Db).from("moderator_brand_assignments").delete().eq("id", id);
  revalidatePath("/live-ops/contributors");
}
