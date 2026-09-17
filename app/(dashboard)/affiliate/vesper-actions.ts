"use server";

// Vesper Reach — the AI-drafted affiliate outreach server actions (outbound +
// inbound reply), all approval-gated. These sit alongside the manual compose flow
// in ../actions.ts and share the SAME outreach_messages table and the SAME
// governance line: drafting is the only automatic step; NOTHING leaves 'draft'
// without a human approval, and NOTHING is marked sent without a real send (email)
// or a human confirming a hand-paste (copy channels). Every Claude call is logged
// to ai_usage_log, and any billing/credit failure is surfaced as a calm message —
// the flow never crashes.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { recordAiUsage } from "@/lib/security/events";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";
import { sendEmail, isEmailNotConfigured } from "@/lib/outreach/email";
import {
  MANAGE_ROLES,
  canApprove,
  isChannel,
  hasAppSender,
  isCopyToSend,
  stageAfterSend,
  optText,
} from "@/lib/affiliate/domain";
import {
  runVesper,
  buildOutboundPrompt,
  buildReplyPrompt,
  splitEmailBody,
  aiErrorMessage,
  AiCreditError,
  AiConfigError,
  type CreatorContext,
  type TemplateFrame,
} from "@/lib/affiliate/vesper-reach";

type Db = { from: (t: string) => any };
type Actor = { id: string; org_id: string; role: string };

function db(): Db {
  return createServerSupabaseClient() as unknown as Db;
}
async function actor(): Promise<Actor> {
  return (await requireRole([...MANAGE_ROLES])) as unknown as Actor;
}
const nowIso = () => new Date().toISOString();

// Postgres check_violation — raised if outreach_messages.status doesn't yet allow
// 'ready_to_send' (the migration flagged to the CTO). We degrade gracefully.
function isCheckViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "23514" || /violates check constraint/i.test(e?.message ?? "");
}

// The real creator columns Vesper is allowed to draft from — nothing else.
const CREATOR_FIELDS =
  "id, name, handle, platform, category, follower_count, email, viber, status, outreach_stage, last_contacted_at, attributed_gmv, tier, notes";

export type VesperDraftState = { error?: string; ok?: string } | null;

const MAX_BATCH = 25;

// ── OUTBOUND: "Draft with Vesper" for one or many selected creators ────────────
export async function draftWithVesper(
  _prev: VesperDraftState,
  formData: FormData
): Promise<VesperDraftState> {
  const me = await actor();

  const channel = optText(formData, "channel");
  if (!channel || !isChannel(channel)) return { error: "Choose a channel first." };

  const ids = Array.from(new Set(formData.getAll("creator_id").map((v) => String(v)).filter(Boolean)));
  if (ids.length === 0) return { error: "Select at least one creator to draft for." };
  if (ids.length > MAX_BATCH) return { error: `Please select ${MAX_BATCH} creators or fewer per batch.` };

  const d = db();
  const templateId = optText(formData, "template_id");
  let template: TemplateFrame | null = null;
  if (templateId) {
    const { data: t } = await d
      .from("outreach_templates")
      .select("name, channel, subject, body")
      .eq("id", templateId)
      .maybeSingle();
    template = (t as TemplateFrame | null) ?? null;
  }

  const { data: rows } = await d.from("creators").select(CREATOR_FIELDS).eq("org_id", me.org_id).in("id", ids);
  const creators = (rows ?? []) as CreatorContext[];
  if (creators.length === 0) return { error: "Those creators are no longer available." };

  const model = TIER_MODEL[defaultTierFor(me.role)];
  let drafted = 0;
  let creditError: string | null = null;

  for (const creator of creators) {
    let result;
    try {
      result = await runVesper(buildOutboundPrompt(creator, template, channel), model);
    } catch (err) {
      // A credit/config failure will hit every creator identically — stop the
      // batch and report it once rather than hammering the API.
      if (err instanceof AiCreditError || err instanceof AiConfigError) {
        creditError = aiErrorMessage(err);
        break;
      }
      // A one-off transient failure: skip this creator, keep going.
      continue;
    }

    const { error: insErr } = await d.from("outreach_messages").insert({
      org_id: me.org_id,
      created_by: me.id,
      recipient_type: "creator",
      recipient_id: creator.id,
      channel,
      template_id: templateId,
      body: result.body,
      status: "draft",
    });
    if (insErr) continue;
    drafted += 1;

    void recordAiUsage(d, {
      orgId: me.org_id,
      userId: me.id,
      feature: "vesper_reach",
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    await d.from("outreach_activities").insert({
      org_id: me.org_id,
      created_by: me.id,
      creator_id: creator.id,
      activity_type: "outreach_drafted",
      note: `Vesper drafted a ${channel} outreach message`,
      occurred_at: nowIso(),
    });
  }

  revalidatePath("/affiliate/engage");

  if (creditError) {
    return {
      error: drafted > 0 ? `${creditError} (${drafted} drafted before it stopped.)` : creditError,
    };
  }
  if (drafted === 0) return { error: "Vesper couldn't draft any messages just now — please try again." };
  return { ok: `Vesper drafted ${drafted} ${channel} message${drafted === 1 ? "" : "s"} as drafts for review.` };
}

// ── INBOUND REPLY: draft a tone-matched reply to a pasted creator message ──────
export async function draftVesperReply(
  _prev: VesperDraftState,
  formData: FormData
): Promise<VesperDraftState> {
  const me = await actor();

  const creatorId = optText(formData, "creator_id");
  const channel = optText(formData, "channel");
  const incoming = optText(formData, "incoming_message");
  if (!creatorId) return { error: "Pick the creator who messaged you." };
  if (!channel || !isChannel(channel)) return { error: "Choose a channel for the reply." };
  if (!incoming) return { error: "Paste the incoming message to reply to." };

  const d = db();
  const { data: row } = await d
    .from("creators")
    .select(CREATOR_FIELDS)
    .eq("id", creatorId)
    .eq("org_id", me.org_id)
    .maybeSingle();
  const creator = row as CreatorContext | null;
  if (!creator) return { error: "That creator is no longer available." };

  const model = TIER_MODEL[defaultTierFor(me.role)];
  let result;
  try {
    result = await runVesper(buildReplyPrompt(creator, incoming, channel), model);
  } catch (err) {
    return { error: aiErrorMessage(err) };
  }

  const { error: insErr } = await d.from("outreach_messages").insert({
    org_id: me.org_id,
    created_by: me.id,
    recipient_type: "creator",
    recipient_id: creatorId,
    channel,
    template_id: null,
    body: result.body,
    status: "draft",
  });
  if (insErr) return { error: "Vesper drafted the reply but it couldn't be saved. Please try again." };

  void recordAiUsage(d, {
    orgId: me.org_id,
    userId: me.id,
    feature: "vesper_reach",
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });

  await d.from("outreach_activities").insert({
    org_id: me.org_id,
    created_by: me.id,
    creator_id: creatorId,
    activity_type: "reply_drafted",
    note: `Vesper drafted a ${channel} reply`,
    occurred_at: nowIso(),
  });

  revalidatePath("/affiliate/engage");
  return { ok: "Vesper drafted a reply — review, edit, and approve it below." };
}

// ── REVIEW: human edits a draft body inline (only while still a draft) ──────────
export async function editVesperDraft(formData: FormData): Promise<void> {
  const me = await actor();
  const id = optText(formData, "id");
  const body = optText(formData, "body");
  if (!id || !body) return;

  const d = db();
  const { data: msg } = await d
    .from("outreach_messages")
    .select("id, status")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .maybeSingle();
  const row = msg as { status: string } | null;
  // Only a draft may be edited — once approved, editing would bypass the gate.
  if (!row || row.status !== "draft") return;

  await d
    .from("outreach_messages")
    .update({ body, updated_at: nowIso() })
    .eq("id", id)
    .eq("org_id", me.org_id);

  revalidatePath("/affiliate/engage");
}

// ── APPROVE: the human gate. Email → 'approved'; copy channels → 'ready_to_send'.
// Both stamp approved_by/approved_at, so nothing is ever staged for send without a
// real approver. Leadership only.
export async function approveVesperMessage(formData: FormData): Promise<void> {
  const me = await actor();
  if (!canApprove(me.role)) return;
  const id = optText(formData, "id");
  if (!id) return;

  const d = db();
  const { data: msg } = await d
    .from("outreach_messages")
    .select("id, channel, status")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .maybeSingle();
  const row = msg as { channel: string; status: string } | null;
  if (!row || row.status !== "draft") return;

  const approval = { approved_by: me.id, approved_at: nowIso(), updated_at: nowIso() };
  const target = hasAppSender(row.channel) ? "approved" : "ready_to_send";

  const { error } = await d
    .from("outreach_messages")
    .update({ status: target, ...approval })
    .eq("id", id)
    .eq("org_id", me.org_id);

  // If 'ready_to_send' isn't in the DB CHECK yet (migration pending with the CTO),
  // fall back to 'approved' so the copy-to-send flow still works — the row is still
  // genuinely approved, just labelled 'Approved' until the migration lands. Never
  // a crash, never an un-approved staged message.
  if (error && target === "ready_to_send" && isCheckViolation(error)) {
    await d
      .from("outreach_messages")
      .update({ status: "approved", ...approval })
      .eq("id", id)
      .eq("org_id", me.org_id);
  }

  revalidatePath("/affiliate/engage");
}

// Shared send-completion: stamp the message sent, record the touch on the creator
// (last_contacted_at + advance outreach_stage, never regressing), and log the
// activity. Only ever called AFTER a real send or a confirmed hand-paste.
async function finalizeSent(d: Db, me: Actor, msg: { id: string; channel: string; recipient_id: string | null }) {
  const now = nowIso();
  await d
    .from("outreach_messages")
    .update({ status: "sent", sent_at: now, updated_at: now })
    .eq("id", msg.id)
    .eq("org_id", me.org_id);

  if (msg.recipient_id) {
    const { data: c } = await d
      .from("creators")
      .select("outreach_stage")
      .eq("id", msg.recipient_id)
      .eq("org_id", me.org_id)
      .maybeSingle();
    const nextStage = stageAfterSend((c as { outreach_stage: string | null } | null)?.outreach_stage);
    const patch: Record<string, unknown> = { last_contacted_at: now, updated_at: now };
    if (nextStage) patch.outreach_stage = nextStage;
    await d.from("creators").update(patch).eq("id", msg.recipient_id).eq("org_id", me.org_id);

    await d.from("outreach_activities").insert({
      org_id: me.org_id,
      created_by: me.id,
      creator_id: msg.recipient_id,
      activity_type: "outreach_sent",
      note: `Sent ${msg.channel} message (human-approved)`,
      occurred_at: now,
    });
  }
}

// ── SEND (email): deliver an APPROVED email through the app sender ─────────────
export async function sendVesperEmail(formData: FormData): Promise<void> {
  const me = await actor();
  const id = optText(formData, "id");
  if (!id) return;

  const d = db();
  const { data: msg } = await d
    .from("outreach_messages")
    .select("id, channel, status, recipient_id, template_id, body")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .maybeSingle();
  const row = msg as
    | { id: string; channel: string; status: string; recipient_id: string | null; template_id: string | null; body: string | null }
    | null;
  // Only an APPROVED email may send. Nothing un-approved ever reaches this path.
  if (!row || row.status !== "approved" || !hasAppSender(row.channel)) return;

  // Resolve the recipient email — no address, no send (never a faked send).
  let toEmail: string | null = null;
  if (row.recipient_id) {
    const { data: c } = await d
      .from("creators")
      .select("email")
      .eq("id", row.recipient_id)
      .eq("org_id", me.org_id)
      .maybeSingle();
    toEmail = (c as { email: string | null } | null)?.email ?? null;
  }
  if (!toEmail) return;

  // Subject: prefer the leading `Subject:` line in the body, else the template's
  // subject, else an honest generic default.
  let fallbackSubject = "A note from the team";
  if (row.template_id) {
    const { data: t } = await d
      .from("outreach_templates")
      .select("subject")
      .eq("id", row.template_id)
      .maybeSingle();
    const s = (t as { subject: string | null } | null)?.subject;
    if (s?.trim()) fallbackSubject = s.trim();
  }
  const { subject, text } = splitEmailBody(row.body ?? "", fallbackSubject);

  try {
    await sendEmail({ to: toEmail, subject, text });
  } catch (err) {
    // Not configured or a provider rejection: DO NOT mark sent, DO NOT fake it.
    // The message stays 'approved' so it can be retried once email is set up.
    if (!isEmailNotConfigured(err)) {
      console.error("[vesper-reach] email send failed", err);
    }
    return;
  }

  await finalizeSent(d, me, { id: row.id, channel: row.channel, recipient_id: row.recipient_id });
  revalidatePath("/affiliate/engage");
}

// ── SEND (copy channels): human confirms the hand-paste → mark it sent ─────────
export async function confirmCopySent(formData: FormData): Promise<void> {
  const me = await actor();
  const id = optText(formData, "id");
  if (!id) return;

  const d = db();
  const { data: msg } = await d
    .from("outreach_messages")
    .select("id, channel, status, recipient_id")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .maybeSingle();
  const row = msg as { id: string; channel: string; status: string; recipient_id: string | null } | null;
  // Copy channels only, and only once approved/staged (approved or ready_to_send).
  if (!row || !isCopyToSend(row.channel)) return;
  if (row.status !== "ready_to_send" && row.status !== "approved") return;

  await finalizeSent(d, me, { id: row.id, channel: row.channel, recipient_id: row.recipient_id });
  revalidatePath("/affiliate/engage");
}
