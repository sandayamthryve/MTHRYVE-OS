"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { parseLeadsCsv } from "@/lib/leads/csv";
import {
  OUTREACH_ROLES,
  canEditLead,
  isStage,
  isActivityType,
} from "@/lib/outreach/leads";
import type { ImportLeadsState } from "../leads/ImportLeadsControl";

// Server actions for the BizDev Outreach module. Every write is org/RLS-scoped
// (the row's org_id is set from the caller's profile so it satisfies the
// leads / outreach_activities with_check (org_id = current_org_id()) policy).
// Editing an existing lead — stage moves, field edits, activity logging — is
// additionally gated to leadership or the lead owner in this layer, since RLS
// only isolates orgs. Nothing is fabricated: a left-blank field is stored as
// null (unknown), never a zero or an invented date.

type ActorProfile = { id: string; org_id: string; role: (typeof OUTREACH_ROLES)[number] };

// The generated Database types don't include the outreach columns/tables yet,
// so we reach them through the same cast shim used across the app.
type DbShim = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (col: string, val: string) => { maybeSingle: () => Promise<{ data: unknown }> };
    };
    insert: (v: Record<string, unknown>) => Promise<{ error: unknown }>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
  };
};

// A blank text field → null (unknown), never an empty string.
function optText(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "").trim();
  return v || null;
}

// A blank numeric field → null (unknown), never 0.
function optNum(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// An <input type="date"> value ("YYYY-MM-DD") kept as-is for a date column, or
// null when blank/malformed. No timezone shifting — a date is a calendar day.
function optDate(formData: FormData, key: string): string | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

// A datetime-local value ("2026-07-12T14:30") → ISO, pinned to Asia/Manila (the
// company timezone, fixed +08:00) so the wall-clock the user typed round-trips.
// A value already carrying a zone is honoured as-is; blank → null.
function optTimestamp(formData: FormData, key: string): string | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/);
  if (!m) return null;
  const t = new Date(`${m[1]}T${m[2]}${m[3] ?? ":00"}+08:00`).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Load a lead the actor is allowed to edit (leadership, or the owner), or null.
// RLS already restricts the select to the caller's org, so a null here means
// either not-in-org, not-found, or not-permitted — all treated the same (no-op).
async function loadEditableLead(
  db: DbShim,
  actor: ActorProfile,
  id: string
): Promise<{ id: string; owner_id: string | null } | null> {
  const res = await db.from("leads").select("id, owner_id").eq("id", id).maybeSingle();
  const lead = res.data as { id: string; owner_id: string | null } | null;
  if (!lead) return null;
  if (!canEditLead(actor, lead)) return null;
  return lead;
}

// ── Create / import ─────────────────────────────────────────────────────────

export async function createLead(formData: FormData) {
  const profile = (await requireRole([...OUTREACH_ROLES])) as unknown as ActorProfile;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("leads").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    owner_id: profile.id,
    name,
    company: optText(formData, "company"),
    email: optText(formData, "email"),
    phone: optText(formData, "phone"),
    source: optText(formData, "source"),
    department: optText(formData, "department"),
    value: optNum(formData, "value"),
    stage: "new",
    next_action: optText(formData, "next_action"),
    next_action_date: optDate(formData, "next_action_date"),
    notes: optText(formData, "notes"),
  });
  revalidatePath("/outreach");
}

// Bulk-import leads from a CSV, reusing the shared leads import format. Each
// valid row inserts a new lead owned by the importer. Shaped for useFormState.
export async function importLeads(
  _prev: ImportLeadsState,
  formData: FormData
): Promise<ImportLeadsState> {
  const profile = (await requireRole([...OUTREACH_ROLES])) as unknown as ActorProfile;

  const file = formData.get("file");
  let text = "";
  if (file && typeof file !== "string" && file.size > 0) {
    text = await file.text();
  } else {
    text = String(formData.get("csv") ?? "");
  }

  const { rows, skipped } = parseLeadsCsv(text);
  if (rows.length === 0) return { imported: 0, skipped };

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  for (const r of rows) {
    await db.from("leads").insert({
      org_id: profile.org_id,
      created_by: profile.id,
      owner_id: profile.id,
      ...r,
    });
  }
  revalidatePath("/outreach");
  return { imported: rows.length, skipped };
}

// ── Stage moves (board drag / dropdown) ─────────────────────────────────────

// Move a lead to a new pipeline stage. Called directly from the board client
// island with (id, stage). Validates the stage against the canonical set and
// enforces the leadership-or-owner edit rule before writing.
export async function moveLeadStage(
  id: string,
  stage: string
): Promise<{ ok: boolean; error?: string }> {
  const profile = (await requireRole([...OUTREACH_ROLES])) as unknown as ActorProfile;
  if (!id || !isStage(stage)) return { ok: false, error: "invalid stage" };
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  const lead = await loadEditableLead(db, profile, id);
  if (!lead) return { ok: false, error: "not permitted" };
  const { error } = await db
    .from("leads")
    .update({ stage, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: "update failed" };
  revalidatePath("/outreach");
  return { ok: true };
}

// ── Lead edit (detail page) ─────────────────────────────────────────────────

export async function updateLead(formData: FormData) {
  const profile = (await requireRole([...OUTREACH_ROLES])) as unknown as ActorProfile;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  const lead = await loadEditableLead(db, profile, id);
  if (!lead) return;

  const stageRaw = String(formData.get("stage") ?? "").trim();
  const patch: Record<string, unknown> = {
    name: String(formData.get("name") ?? "").trim() || undefined,
    company: optText(formData, "company"),
    email: optText(formData, "email"),
    phone: optText(formData, "phone"),
    source: optText(formData, "source"),
    department: optText(formData, "department"),
    value: optNum(formData, "value"),
    next_action: optText(formData, "next_action"),
    next_action_date: optDate(formData, "next_action_date"),
    last_contacted_at: optTimestamp(formData, "last_contacted_at"),
    notes: optText(formData, "notes"),
    updated_at: new Date().toISOString(),
  };
  // Only move stage if a valid one was submitted; a blank/unknown value leaves
  // the current stage untouched rather than resetting it.
  if (isStage(stageRaw)) patch.stage = stageRaw;
  // A missing name must never blank the required column.
  if (patch.name === undefined) delete patch.name;

  await db.from("leads").update(patch).eq("id", id);
  revalidatePath("/outreach");
  revalidatePath(`/outreach/${id}`);
}

// ── Activity log ────────────────────────────────────────────────────────────

// Log an outreach activity against a lead: insert an outreach_activities row
// AND advance the lead's last_contacted_at to the activity time. Both writes are
// org-scoped; the actor must be leadership or the lead owner.
export async function logActivity(formData: FormData) {
  const profile = (await requireRole([...OUTREACH_ROLES])) as unknown as ActorProfile;
  const leadId = String(formData.get("lead_id") ?? "");
  const activityType = String(formData.get("activity_type") ?? "").trim();
  if (!leadId || !isActivityType(activityType)) return;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  const lead = await loadEditableLead(db, profile, leadId);
  if (!lead) return;

  // occurred_at defaults to now when the user leaves the time blank — a real
  // event time, not an invented metric.
  const occurredAt = optTimestamp(formData, "occurred_at") ?? new Date().toISOString();

  await db.from("outreach_activities").insert({
    org_id: profile.org_id,
    lead_id: leadId,
    created_by: profile.id,
    activity_type: activityType,
    note: optText(formData, "note"),
    occurred_at: occurredAt,
  });
  // "Log activity" also stamps the lead as contacted at the activity time.
  await db
    .from("leads")
    .update({ last_contacted_at: occurredAt, updated_at: new Date().toISOString() })
    .eq("id", leadId);

  revalidatePath("/outreach");
  revalidatePath(`/outreach/${leadId}`);
}
