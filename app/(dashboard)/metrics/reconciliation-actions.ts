"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Reconciliation override (Phase 2, Part B). Leadership resolves a mismatch one
// of three ways; all three set validation_status='overridden' and stamp who /
// when (approved_by / approved_at). The Phase-1 trigger treats 'overridden' as
// terminal — it never recomputes the status back to match/mismatch.
//
// HOW EACH CHOICE RESOLVES THE HEADLINE (Part C says overridden → api_value, so
// we settle the trusted number INTO api_value and leave the manual floor
// untouched — the human floor is never overwritten):
//   • keep_manual — the manual figure is right → api_value := manual_value
//   • accept_api  — the API figure is right    → api_value unchanged
//   • override    — neither → api_value := the entered correct number
//
// This is a HUMAN action through the RLS user client (leadership-gated by policy
// AND by requireRole). It is NOT the sync — the "sync writes api_value only /
// never manual_value" rule is about the automated path; a human reconciling is
// exactly the sanctioned way a mismatch gets settled.

type EntryRow = { manual_value: number | null; api_value: number | null };
type Db = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (col: string, v: string) => { maybeSingle: () => Promise<{ data: unknown }> };
    };
    update: (v: Record<string, unknown>) => { eq: (col: string, v: string) => Promise<unknown> };
  };
};

export async function resolveMismatch(formData: FormData): Promise<void> {
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as {
    id: string;
  };

  const id = String(formData.get("id") ?? "");
  const choice = String(formData.get("choice") ?? "");
  if (!id || !["keep_manual", "accept_api", "override"].includes(choice)) return;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  const { data } = await db.from("metric_entries").select("manual_value, api_value").eq("id", id).maybeSingle();
  const entry = data as EntryRow | null;
  if (!entry) return;

  // Decide the settled api_value per choice. manual_value is NEVER written here.
  let nextApi: number | null = entry.api_value;
  if (choice === "keep_manual") {
    nextApi = entry.manual_value;
  } else if (choice === "override") {
    const raw = String(formData.get("override_value") ?? "").trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) return; // an override needs a real number
    nextApi = n;
  }
  // accept_api → leave nextApi as the existing api_value.

  await db
    .from("metric_entries")
    .update({
      api_value: nextApi,
      validation_status: "overridden",
      override_choice: choice,
      origin: "reconciled",
      approved_by: profile.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id);

  revalidatePath("/metrics");
  revalidatePath("/");
}
