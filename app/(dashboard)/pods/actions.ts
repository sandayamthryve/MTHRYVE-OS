"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Server actions behind the Pods manager. Creating a pod, setting its lead /
// target, and assigning or unassigning brands are all LEADERSHIP-GATED writes:
// RLS on pods / pod_brands (pods_write / pod_brands_write) permits INSERT/UPDATE/
// DELETE only for ceo / coo / department_head, and every write stamps org_id
// from the caller's profile so the with_check (org_id = current_org_id()) passes.
// RLS is the real authority — we add a friendly pre-check so a team member gets a
// clean message instead of a silent policy no-op.
//
// pods / pod_brands aren't in the generated Database types (provisioned
// out-of-band; see migration 0023), so they're reached through the same cast
// shim the rest of the OS uses.
type Shim = { from: (t: string) => any };
const LEADERSHIP = new Set(["ceo", "coo", "department_head"]);

export interface PodActionResult {
  ok: boolean;
  id?: string;
  error?: string;
}

function shim() {
  return createServerSupabaseClient() as unknown as Shim;
}

function toIntOrNull(v: FormDataEntryValue | null): number | null {
  const s = (typeof v === "string" ? v : "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export async function createPod(formData: FormData): Promise<PodActionResult> {
  const profile = await requireProfile();
  if (!LEADERSHIP.has(profile.role)) {
    return { ok: false, error: "Only leadership (CEO/COO/department head) can create pods." };
  }
  const name = ((formData.get("name") as string | null) ?? "").trim();
  if (!name) return { ok: false, error: "A pod needs a name." };
  const leadUserId = ((formData.get("lead_user_id") as string | null) ?? "").trim() || null;
  const targetBrands = toIntOrNull(formData.get("target_brands"));
  const notes = ((formData.get("notes") as string | null) ?? "").trim() || null;

  const { data, error } = await shim()
    .from("pods")
    .insert({
      org_id: profile.org_id,
      name,
      lead_user_id: leadUserId,
      target_brands: targetBrands,
      notes,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !(data as { id?: string } | null)?.id) {
    return { ok: false, error: error?.message || "Could not create the pod." };
  }
  revalidatePath("/pods");
  revalidatePath("/scoreboard");
  return { ok: true, id: (data as { id: string }).id };
}

export async function updatePod(formData: FormData): Promise<PodActionResult> {
  const profile = await requireProfile();
  if (!LEADERSHIP.has(profile.role)) {
    return { ok: false, error: "Only leadership can edit pods." };
  }
  const podId = ((formData.get("pod_id") as string | null) ?? "").trim();
  if (!podId) return { ok: false, error: "Missing pod." };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const name = ((formData.get("name") as string | null) ?? "").trim();
  if (name) patch.name = name;
  if (formData.has("lead_user_id")) {
    patch.lead_user_id = ((formData.get("lead_user_id") as string | null) ?? "").trim() || null;
  }
  if (formData.has("target_brands")) patch.target_brands = toIntOrNull(formData.get("target_brands"));
  const status = ((formData.get("status") as string | null) ?? "").trim();
  if (status && ["active", "paused", "archived"].includes(status)) patch.status = status;

  const { error } = await shim().from("pods").update(patch).eq("id", podId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/pods");
  revalidatePath("/scoreboard");
  return { ok: true, id: podId };
}

export async function assignBrand(formData: FormData): Promise<PodActionResult> {
  const profile = await requireProfile();
  if (!LEADERSHIP.has(profile.role)) {
    return { ok: false, error: "Only leadership can assign brands." };
  }
  const podId = ((formData.get("pod_id") as string | null) ?? "").trim();
  const brandId = ((formData.get("brand_id") as string | null) ?? "").trim();
  if (!podId || !brandId) return { ok: false, error: "Pick a pod and a brand." };

  // Idempotent: ignore a duplicate assignment (composite PK on pod_id+brand_id).
  const { error } = await shim()
    .from("pod_brands")
    .upsert({ org_id: profile.org_id, pod_id: podId, brand_id: brandId }, { onConflict: "pod_id,brand_id", ignoreDuplicates: true });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/pods");
  revalidatePath("/scoreboard");
  return { ok: true, id: podId };
}

export async function unassignBrand(formData: FormData): Promise<PodActionResult> {
  const profile = await requireProfile();
  if (!LEADERSHIP.has(profile.role)) {
    return { ok: false, error: "Only leadership can unassign brands." };
  }
  const podId = ((formData.get("pod_id") as string | null) ?? "").trim();
  const brandId = ((formData.get("brand_id") as string | null) ?? "").trim();
  if (!podId || !brandId) return { ok: false, error: "Missing pod or brand." };

  const { error } = await shim().from("pod_brands").delete().eq("pod_id", podId).eq("brand_id", brandId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/pods");
  revalidatePath("/scoreboard");
  return { ok: true, id: podId };
}
