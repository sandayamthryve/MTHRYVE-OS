"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  getCapabilityById,
  updateCapability,
} from "@/lib/capabilities/data";
import {
  CAPABILITY_REF_FIELDS,
  isCapabilityStatus,
  type CapabilityRefField,
} from "@/lib/capabilities/types";
import {
  createMissionTasks,
  draftMissionTasks,
  type MissionTaskDraft,
} from "@/lib/capabilities/missions";

// Server actions behind Vesper Core. All run on the caller's RLS client, so
// Postgres is the authority: capabilities_write restricts edits to
// ceo/coo/department_head, and task inserts follow the caller's own rights. The
// capabilities / tasks tables aren't in the generated types (seeded out of band),
// so — like the rest of the OS — they're reached through the app's cast shim.
type Shim = { from: (t: string) => any };
function shim() {
  return createServerSupabaseClient() as unknown as Shim;
}

const LEADERSHIP = ["ceo", "coo", "department_head"];

export interface EditResult {
  ok: boolean;
  error?: string;
}

// Leadership edit: update a capability's status and/or reference arrays. Only the
// allow-listed columns are writable; each ref field is coerced to a clean
// string[]. RLS rejects a non-leadership caller, but we pre-check for a clean
// message rather than a raw policy error.
export async function updateCapabilityAction(
  id: string,
  input: {
    status?: string;
    refs?: Partial<Record<CapabilityRefField, string[]>>;
    notes?: string | null;
  }
): Promise<EditResult> {
  if (!id) return { ok: false, error: "Missing capability." };
  const profile = await requireProfile();
  if (!LEADERSHIP.includes(profile.role)) {
    return { ok: false, error: "Only leadership (CEO / COO / department head) can edit capabilities." };
  }

  const patch: Record<string, unknown> = {};

  if (typeof input.status === "string") {
    if (!isCapabilityStatus(input.status)) return { ok: false, error: "Invalid status." };
    patch.status = input.status;
  }

  if (input.refs) {
    for (const field of CAPABILITY_REF_FIELDS) {
      const val = input.refs[field];
      if (val === undefined) continue;
      // Clean + de-dupe: trimmed non-empty strings, order preserved.
      const seen = new Set<string>();
      const clean: string[] = [];
      for (const raw of Array.isArray(val) ? val : []) {
        const s = typeof raw === "string" ? raw.trim() : "";
        if (s && !seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          clean.push(s);
        }
      }
      patch[field] = clean;
    }
  }

  if (input.notes !== undefined) {
    const n = typeof input.notes === "string" ? input.notes.trim() : "";
    patch.notes = n || null;
  }

  const res = await updateCapability(shim(), id, patch);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/vesper/core");
  return { ok: true };
}

export interface DraftResult {
  ok: boolean;
  error?: string;
  capability?: { id: string; name: string; status: string; domain: string };
  drafts?: MissionTaskDraft[];
}

// Draft (no writes): produce a proposed mission-task list for a live/partial
// capability. Reads the capability fresh on the caller's RLS client so a stale
// client view can't smuggle in a different capability.
export async function draftMissionTasksAction(
  capabilityId: string,
  context: string
): Promise<DraftResult> {
  await requireProfile();
  const cap = await getCapabilityById(shim(), capabilityId);
  if (!cap) return { ok: false, error: "Capability not found." };
  if (cap.status === "planned" || cap.status === "vendor") {
    return {
      ok: false,
      error: `"${cap.name}" is ${cap.status} — there's nothing to execute yet, so it can't become tasks.`,
    };
  }
  return {
    ok: true,
    capability: { id: cap.id, name: cap.name, status: cap.status, domain: cap.domain },
    drafts: draftMissionTasks(cap, context ?? ""),
  };
}

export interface CreateResult {
  ok: boolean;
  error?: string;
  created?: number;
  capability?: string;
}

// Confirm: create the reviewed tasks, each linked to the capability. The capability
// is re-read RLS-scoped and re-checked live/partial inside createMissionTasks.
export async function createMissionTasksAction(
  capabilityId: string,
  tasks: unknown[]
): Promise<CreateResult> {
  const profile = await requireProfile();
  const db = shim();
  const cap = await getCapabilityById(db, capabilityId);
  if (!cap) return { ok: false, error: "Capability not found." };

  const result = await createMissionTasks(db, profile, cap, tasks);
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath("/tasks");
  revalidatePath("/vesper/core");
  return { ok: true, created: result.created, capability: result.capability };
}
