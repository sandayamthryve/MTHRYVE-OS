"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { emailConfig } from "@/lib/outreach/email";
import { isOutreachChannel, type OutreachChannel } from "@/lib/outreach/channels";
import { isTonePreset, type TonePreset } from "@/lib/assistant/tone";
import {
  buildVesperDraft,
  draftOutreachMessage,
  draftReplyMessage,
  enrichMessageWithClaude,
  type VesperTarget,
  type VesperContext,
  type VesperKind,
  type DraftedMessage,
} from "@/lib/outreach/vesper";

// VESPER's producer (V2). A human clicks "Draft with Vesper" on a lead or creator;
// this generates a personalized message and DRAFTS one 'send_outreach'
// action_request (status='pending') into the Action & Approval Queue. It NEVER
// sends — sending is the approval-gated executor step. RLS on action_requests
// requires ceo/coo/department_head to INSERT, so the action is gated to exactly
// that set (a team_member would be rejected by the policy anyway). Every write
// stamps org_id from the caller's profile to satisfy the with_check.
//
// The outreach tables aren't in the generated Database types, so they're reached
// through the same cast shim used across the app.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface DraftOutreachInput {
  targetType: "lead" | "creator";
  targetId: string;
  channel: OutreachChannel;
  kind: VesperKind;
  tonePreset?: string | null;
  brand?: string | null;
  campaign?: string | null;
  playbookNote?: string | null;
  query?: string | null; // reply mode
  useAI?: boolean; // opt-in Claude polish (falls back silently if unavailable)
}

export interface DraftOutreachResult {
  ok: boolean;
  requestId?: string;
  error?: string;
  // Surfaced so the UI can warn honestly BEFORE approval for an email draft.
  emailConfigured?: boolean;
  emailDetail?: string | null;
  // A live preview of what Vesper drafted, so the panel can show it (and offer a
  // copy button for the copy-paste channels) right after drafting.
  channel?: OutreachChannel;
  subject?: string | null;
  message?: string;
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

// Load the target (lead or creator) the caller can see (RLS-scoped to their org).
async function loadTarget(
  db: Shim,
  targetType: "lead" | "creator",
  id: string
): Promise<VesperTarget | null> {
  if (targetType === "lead") {
    const { data } = await db
      .from("leads")
      .select("id, name, company, email, owner_id")
      .eq("id", id)
      .maybeSingle();
    const l = data as
      | { id: string; name: string; company: string | null; email: string | null; owner_id: string | null }
      | null;
    if (!l) return null;
    return {
      kind: "lead",
      id: l.id,
      name: l.name,
      email: l.email,
      company: l.company,
      owner_id: l.owner_id,
    };
  }
  const { data } = await db
    .from("creators")
    .select("id, name, handle, platform, category, email, owner_id")
    .eq("id", id)
    .maybeSingle();
  const c = data as
    | {
        id: string;
        name: string;
        handle: string | null;
        platform: string | null;
        category: string | null;
        email: string | null;
        owner_id: string | null;
      }
    | null;
  if (!c) return null;
  return {
    kind: "creator",
    id: c.id,
    name: c.name,
    email: c.email,
    handle: c.handle,
    platform: c.platform,
    category: c.category,
    owner_id: c.owner_id,
  };
}

export async function draftOutreach(input: DraftOutreachInput): Promise<DraftOutreachResult> {
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  if (input.targetType !== "lead" && input.targetType !== "creator") {
    return { ok: false, error: "Unknown target." };
  }
  if (!input.targetId) return { ok: false, error: "Missing target." };
  if (!isOutreachChannel(input.channel)) return { ok: false, error: "Unknown channel." };
  const kind: VesperKind = input.kind === "reply" ? "reply" : "outreach";
  const query = clean(input.query);
  if (kind === "reply" && !query) {
    return { ok: false, error: "Paste the buyer's query to draft a reply." };
  }

  const target = await loadTarget(db, input.targetType, input.targetId);
  if (!target) return { ok: false, error: "Target not found (or not in your org)." };

  const tonePreset: TonePreset | null = isTonePreset(input.tonePreset) ? input.tonePreset : null;
  const ctx: VesperContext = {
    brand: clean(input.brand),
    campaign: clean(input.campaign),
    tonePreset,
    playbookNote: clean(input.playbookNote),
  };

  // Vesper writes the message deterministically, then (opt-in) lets Claude polish
  // it. Any AI failure silently keeps the deterministic draft.
  const base: DraftedMessage =
    kind === "reply"
      ? draftReplyMessage(target, ctx, query ?? "")
      : draftOutreachMessage(target, input.channel, ctx);
  let message = base;
  if (input.useAI) {
    const enriched = await enrichMessageWithClaude(
      base,
      target,
      input.channel,
      ctx,
      kind,
      query
    );
    if (enriched) message = enriched;
  }

  const draft = buildVesperDraft({
    target,
    channel: input.channel,
    ctx,
    kind,
    query,
    message,
  });

  const { data: inserted, error } = await db
    .from("action_requests")
    .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
    .select("id")
    .single();
  if (error || !inserted?.id) {
    return { ok: false, error: error?.message || "Could not create the draft." };
  }

  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: inserted.id,
    event: "created",
    actor_id: null,
    actor_role: "system",
    detail: {
      source: "vesper_draft",
      channel: input.channel,
      kind,
      [target.kind === "creator" ? "creator_id" : "lead_id"]: target.id,
    },
  });

  revalidatePath("/approvals");
  revalidatePath("/outreach");
  revalidatePath("/creators");

  const cfg = emailConfig();
  return {
    ok: true,
    requestId: inserted.id,
    emailConfigured: cfg.configured,
    emailDetail: cfg.detail,
    channel: input.channel,
    subject: message.subject,
    message: message.body,
  };
}

// Lightweight config probe for the UI, so an email draft can warn BEFORE approval
// that sends will be blocked until the provider is set up.
export async function getEmailConfigStatus(): Promise<{ configured: boolean; detail: string | null }> {
  await requireRole(["ceo", "coo", "department_head"]);
  const cfg = emailConfig();
  return { configured: cfg.configured, detail: cfg.detail };
}
