"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  MANAGE_ROLES,
  canApprove,
  isChannel,
  isGatedChannel,
  isContentType,
  statusForStage,
  PIPELINE_STAGES,
  canSampleTransition,
  canContentTransition,
  optText,
  optNum,
  optDate,
  optTimestamp,
  type PipelineStage,
} from "@/lib/affiliate/domain";
import { parseSourcingCsv } from "@/lib/affiliate/csv";

// Server actions for the Affiliate module (all three sections). Every write is
// org/RLS-scoped: the row's org_id is set from the caller's profile so it
// satisfies each table's with_check (org_id = current_org_id()) policy, and RLS
// isolates orgs on read. The honest-null contract holds on write — a blank field
// is stored as null (unknown), never a fabricated 0 / "" / invented timestamp.
//
// Two invariants the module is built around:
//   • Sourcing dedup: a creator whose normalized email already exists is LINKED,
//     never minted again — the creators_org_email_uniq index is the backstop and
//     a re-link collision surfaces inline, it never throws an opaque 500.
//   • Gated send: NOTHING auto-sends. Email/SMS leave draft only via a human
//     approval then a human "mark sent"; Viber/WhatsApp/TikTok DM can never be
//     marked sent here (copy-to-clipboard only), so we never fake a send.

// The affiliate/outreach/onboarding tables aren't in the generated Database
// types, so we reach them through the same cast shim the rest of the app uses.
type Db = { from: (t: string) => any };
type Actor = { id: string; org_id: string; role: string };

function db(): Db {
  return createServerSupabaseClient() as unknown as Db;
}

async function actor(): Promise<Actor> {
  return (await requireRole([...MANAGE_ROLES])) as unknown as Actor;
}

// Postgres unique_violation — used to turn a re-link race into a clean inline
// message rather than a thrown 500.
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "23505" || /duplicate key|unique constraint/i.test(e?.message ?? "");
}

const nowIso = () => new Date().toISOString();

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Campaigns / Sourcing / Pipeline
// ════════════════════════════════════════════════════════════════════════════

// A campaign is an op_records row with record_type='campaign'. Its fit criteria
// and KPI TARGETS live in details jsonb — targets, never actuals. The live
// tracker on the page derives actuals from linked creators; nothing here echoes
// a target back as a real number.
export async function createCampaign(formData: FormData): Promise<void> {
  const me = await actor();
  const title = optText(formData, "title");
  if (!title) return;

  const details = {
    fit: {
      min_followers: optNum(formData, "fit_min_followers", true),
      category: optText(formData, "fit_category"),
      platform: optText(formData, "fit_platform"),
      region: optText(formData, "fit_region"),
      notes: optText(formData, "fit_notes"),
    },
    kpi_target: {
      sourced: optNum(formData, "kpi_sourced", true),
      qualified: optNum(formData, "kpi_qualified", true),
      active: optNum(formData, "kpi_active", true),
      reach: optNum(formData, "kpi_reach", true),
      gmv: optNum(formData, "kpi_gmv"),
    },
  };

  await db()
    .from("op_records")
    .insert({
      org_id: me.org_id,
      created_by: me.id,
      record_type: "campaign",
      title,
      brand_id: optText(formData, "brand_id"),
      assigned_team: "Affiliate",
      start_date: optDate(formData, "start_date"),
      end_date: optDate(formData, "end_date"),
      details,
      status: "draft",
    });

  revalidatePath("/affiliate");
}

// ── Sourcing: add one creator (manual) ────────────────────────────────────────
export type AddSourcedState = { error?: string; ok?: string } | null;

// Resolve a creator to link: an existing org creator with the same normalized
// email is REUSED (dedup — a duplicate email must link, never mint); otherwise a
// new 'prospect' creator is minted. Returns its id, or an error string.
async function resolveCreator(
  d: Db,
  me: Actor,
  fields: {
    name: string | null;
    email: string | null;
    phone: string | null;
    platform: string | null;
    handle: string | null;
    category: string | null;
    follower_count: number | null;
  }
): Promise<{ id: string } | { error: string }> {
  const email = fields.email?.trim() || null;

  if (email) {
    const normalized = email.toLowerCase();
    const { data: existing } = await d
      .from("creators")
      .select("id, email")
      .eq("org_id", me.org_id);
    const dup = ((existing ?? []) as { id: string; email: string | null }[]).find(
      (r) => (r.email ?? "").trim().toLowerCase() === normalized
    );
    if (dup) return { id: dup.id };
  }

  const name = fields.name?.trim() || email;
  if (!name) return { error: "A creator needs at least a name or an email." };

  const { data: inserted, error } = await d
    .from("creators")
    .insert({
      org_id: me.org_id,
      created_by: me.id,
      owner_id: me.id,
      name,
      handle: fields.handle,
      platform: fields.platform || "tiktok",
      category: fields.category,
      follower_count: fields.follower_count,
      email,
      phone: fields.phone,
      status: "prospect",
    })
    .select("id")
    .single();

  if (error || !inserted) {
    // A racing insert that hit the unique-email index means the creator now
    // exists — re-read and link it rather than failing.
    if (email && isUniqueViolation(error)) {
      const { data: again } = await d
        .from("creators")
        .select("id, email")
        .eq("org_id", me.org_id);
      const dup = ((again ?? []) as { id: string; email: string | null }[]).find(
        (r) => (r.email ?? "").trim().toLowerCase() === email.toLowerCase()
      );
      if (dup) return { id: dup.id };
    }
    return { error: "Could not save the creator. Please try again." };
  }
  return { id: (inserted as { id: string }).id };
}

// Link a resolved creator to a campaign. UNIQUE(org_id, campaign_id, creator_id)
// makes a re-link a clean inline "already on this campaign", never a 500.
async function linkToCampaign(
  d: Db,
  me: Actor,
  campaignId: string,
  creatorId: string
): Promise<{ ok: true } | { error: string; already?: boolean }> {
  const { error } = await d.from("affiliate_campaign_creators").insert({
    org_id: me.org_id,
    campaign_id: campaignId,
    creator_id: creatorId,
    sourcer_id: me.id,
    recruited_at: nowIso(),
  });
  if (error) {
    if (isUniqueViolation(error)) {
      return { error: "This creator is already on this campaign.", already: true };
    }
    return { error: "Could not link the creator to the campaign." };
  }
  return { ok: true };
}

export async function addSourcedCreator(
  _prev: AddSourcedState,
  formData: FormData
): Promise<AddSourcedState> {
  const me = await actor();
  const campaignId = optText(formData, "campaign_id");
  if (!campaignId) return { error: "Missing campaign." };
  const d = db();

  const email = optText(formData, "email");
  const resolved = await resolveCreator(d, me, {
    name: optText(formData, "name"),
    email,
    phone: optText(formData, "phone"),
    platform: optText(formData, "platform"),
    handle: optText(formData, "handle"),
    category: optText(formData, "category"),
    follower_count: optNum(formData, "follower_count", true),
  });
  if ("error" in resolved) return { error: resolved.error };

  const linked = await linkToCampaign(d, me, campaignId, resolved.id);
  if ("error" in linked) return { error: linked.error };

  revalidatePath(`/affiliate/campaigns/${campaignId}`);
  const how = email ? "linked" : "added";
  return { ok: `Creator ${how} to the campaign.` };
}

// ── Sourcing: CSV bulk import ─────────────────────────────────────────────────
export type ImportSourcingState = {
  error?: string;
  summary?: { added: number; linkedExisting: number; alreadyOnCampaign: number; skipped: number };
  notes?: string[];
} | null;

export async function importSourcing(
  _prev: ImportSourcingState,
  formData: FormData
): Promise<ImportSourcingState> {
  const me = await actor();
  const campaignId = optText(formData, "campaign_id");
  if (!campaignId) return { error: "Missing campaign." };

  const text = String(formData.get("csv_text") ?? "");
  const file = formData.get("csv_file");
  let content = text;
  if (!content && file && typeof (file as File).text === "function") {
    content = await (file as File).text();
  }
  if (!content.trim()) return { error: "Paste CSV rows or choose a file first." };

  const { rows, errors } = parseSourcingCsv(content);
  if (rows.length === 0) {
    return { error: errors[0] ?? "No importable rows were found." };
  }

  const d = db();
  const notes = [...errors];
  let added = 0;
  let linkedExisting = 0;
  let alreadyOnCampaign = 0;
  let skipped = 0;

  // Pre-load the org's creators once so we can dedup by email without a query
  // per row. New inserts are appended so a duplicate email inside the same file
  // links to the first occurrence rather than minting twice.
  const { data: existingRows } = await d
    .from("creators")
    .select("id, email")
    .eq("org_id", me.org_id);
  const byEmail = new Map<string, string>();
  for (const r of (existingRows ?? []) as { id: string; email: string | null }[]) {
    const e = (r.email ?? "").trim().toLowerCase();
    if (e) byEmail.set(e, r.id);
  }

  for (const row of rows) {
    const email = row.email?.trim().toLowerCase() || null;
    let creatorId: string | null = null;
    let wasExisting = false;

    if (email && byEmail.has(email)) {
      creatorId = byEmail.get(email)!;
      wasExisting = true;
    } else {
      const { data: inserted, error } = await d
        .from("creators")
        .insert({
          org_id: me.org_id,
          created_by: me.id,
          owner_id: me.id,
          name: row.name ?? row.email,
          handle: row.handle,
          platform: row.platform || "tiktok",
          category: row.category,
          follower_count: row.follower_count,
          email: row.email,
          phone: row.phone,
          status: "prospect",
        })
        .select("id")
        .single();
      if (error || !inserted) {
        skipped += 1;
        notes.push(`"${row.name ?? row.email}": could not be saved — skipped.`);
        continue;
      }
      creatorId = (inserted as { id: string }).id;
      if (email) byEmail.set(email, creatorId);
    }

    const linked = await linkToCampaign(d, me, campaignId, creatorId);
    if ("error" in linked) {
      if (linked.already) alreadyOnCampaign += 1;
      else {
        skipped += 1;
        notes.push(`"${row.name ?? row.email}": ${linked.error}`);
      }
      continue;
    }
    if (wasExisting) linkedExisting += 1;
    else added += 1;
  }

  revalidatePath(`/affiliate/campaigns/${campaignId}`);
  return { summary: { added, linkedExisting, alreadyOnCampaign, skipped }, notes };
}

// ── Qualification pipeline: move a linked creator between stages ───────────────
// Reuses creators.status (no new columns). Guarded: the creator must actually be
// linked to the campaign, and the target must be a real stage.
export async function moveCreatorStage(formData: FormData): Promise<void> {
  const me = await actor();
  const campaignId = optText(formData, "campaign_id");
  const creatorId = optText(formData, "creator_id");
  const target = optText(formData, "stage");
  if (!campaignId || !creatorId || !target) return;
  if (!PIPELINE_STAGES.includes(target as PipelineStage)) return;

  const d = db();
  const { data: link } = await d
    .from("affiliate_campaign_creators")
    .select("id")
    .eq("org_id", me.org_id)
    .eq("campaign_id", campaignId)
    .eq("creator_id", creatorId)
    .maybeSingle();
  if (!link) return; // not on this campaign — refuse to touch the creator

  await d
    .from("creators")
    .update({ status: statusForStage(target as PipelineStage), updated_at: nowIso() })
    .eq("id", creatorId)
    .eq("org_id", me.org_id);

  revalidatePath(`/affiliate/campaigns/${campaignId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Engage: Outreach + Onboarding
// ════════════════════════════════════════════════════════════════════════════

// Compose one outreach message from a template into status='draft'. NOTHING is
// sent here — drafting is the only automatic step. The touch is logged to
// outreach_activities so the creator's timeline shows it.
export async function createOutreachMessage(formData: FormData): Promise<void> {
  const me = await actor();
  const creatorId = optText(formData, "creator_id");
  const channel = optText(formData, "channel");
  const body = optText(formData, "body");
  if (!creatorId || !channel || !isChannel(channel) || !body) return;

  const d = db();
  // outreach_messages carries no subject column (only outreach_templates does),
  // so a chosen subject is kept for the activity note / display, not stored on
  // the message row.
  const subject = optText(formData, "subject");

  // Naming a campaign is what turns outreach into a campaign invite. Verified
  // against op_records rather than trusted from the form: the column's foreign
  // key cannot require record_type = 'campaign' (op_records also holds
  // promotions, missions and rewards), so a forged id would otherwise store a
  // promotion as the campaign a creator was invited to. Unverifiable means null
  // — a general message — never a guess.
  const requestedCampaign = optText(formData, "campaign_id");
  let campaignId: string | null = null;
  if (requestedCampaign) {
    const { data: campaign } = await d
      .from("op_records")
      .select("id")
      .eq("id", requestedCampaign)
      .eq("org_id", me.org_id)
      .eq("record_type", "campaign")
      .maybeSingle();
    campaignId = (campaign as { id: string } | null)?.id ?? null;
  }

  const row = {
    org_id: me.org_id,
    created_by: me.id,
    recipient_type: "creator",
    recipient_id: creatorId,
    channel,
    template_id: optText(formData, "template_id"),
    body,
    status: "draft",
  };

  // campaign_id ships ahead of its migration (20260917050000). PostgREST
  // rejects an insert naming a column the table does not have — and it rejects
  // it whatever the VALUE is, so sending campaign_id: null would break every
  // compose on an un-migrated database, not just the ones naming a campaign.
  // Insert with it, and on failure fall back to the row without: composing keeps
  // working and only the campaign link is lost until the migration runs.
  const { error } = (await d
    .from("outreach_messages")
    .insert({ ...row, campaign_id: campaignId })) as { error: unknown };
  if (error) await d.from("outreach_messages").insert(row);

  // Best-effort activity log — a failed log never blocks the draft.
  await d.from("outreach_activities").insert({
    org_id: me.org_id,
    created_by: me.id,
    creator_id: creatorId,
    activity_type: "outreach_drafted",
    note: `Drafted ${campaignId ? "campaign invite" : "message"} on ${channel}${subject ? ` — ${subject}` : ""}`,
    occurred_at: nowIso(),
  });

  revalidatePath("/affiliate/engage");
}

// Human approval — the ONLY way a gated (email/sms) message may leave draft.
// Leadership only. Copy-only channels can never be approved for send here.
export async function approveOutreachMessage(formData: FormData): Promise<void> {
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
  if (!row || row.status !== "draft" || !isGatedChannel(row.channel)) return;

  await d
    .from("outreach_messages")
    .update({ status: "approved", approved_by: me.id, approved_at: nowIso(), updated_at: nowIso() })
    .eq("id", id)
    .eq("org_id", me.org_id);

  revalidatePath("/affiliate/engage");
}

// Human "mark sent" — records that an APPROVED gated message was sent. This is a
// deliberate manual step (no provider auto-fires): it stamps sent_at only after
// approval, and never applies to copy-only channels.
export async function markOutreachSent(formData: FormData): Promise<void> {
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
  const row = msg as { channel: string; status: string; recipient_id: string | null } | null;
  if (!row || row.status !== "approved" || !isGatedChannel(row.channel)) return;

  await d
    .from("outreach_messages")
    .update({ status: "sent", sent_at: nowIso(), updated_at: nowIso() })
    .eq("id", id)
    .eq("org_id", me.org_id);

  if (row.recipient_id) {
    await d.from("outreach_activities").insert({
      org_id: me.org_id,
      created_by: me.id,
      creator_id: row.recipient_id,
      activity_type: "outreach_sent",
      note: `Sent ${row.channel} message (human-approved)`,
      occurred_at: nowIso(),
    });
  }

  revalidatePath("/affiliate/engage");
}

// ── Onboarding intake — upsert on (org_id, creator_id) ────────────────────────
export type OnboardingState = { error?: string; ok?: string } | null;

// platform_links jsonb is built from the labelled link inputs; blank ones are
// dropped so we never store empty strings.
function buildPlatformLinks(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["tiktok", "instagram", "facebook", "youtube", "other"]) {
    const v = optText(formData, `link_${k}`);
    if (v) out[k] = v;
  }
  return out;
}

export async function saveOnboarding(
  _prev: OnboardingState,
  formData: FormData
): Promise<OnboardingState> {
  const me = await actor();
  const creatorId = optText(formData, "creator_id");
  if (!creatorId) return { error: "Choose a creator to onboard." };

  const email = optText(formData, "email");
  const phone = optText(formData, "phone");
  const address = optText(formData, "address");
  const shipping = optText(formData, "shipping_details");
  const platformLinks = buildPlatformLinks(formData);
  const wantComplete = String(formData.get("mark_complete") ?? "") === "on";

  // complete=true ONLY when the required fields are actually present — a checked
  // box can never mark an incomplete profile complete.
  const missing: string[] = [];
  if (!email) missing.push("email");
  if (!phone) missing.push("phone");
  if (!address) missing.push("address");
  if (!shipping) missing.push("shipping details");
  if (Object.keys(platformLinks).length === 0) missing.push("at least one platform link");
  const complete = wantComplete && missing.length === 0;

  const d = db();
  const patch = {
    email,
    phone,
    address,
    platform_links: platformLinks,
    preferred_schedule: optText(formData, "preferred_schedule"),
    shipping_details: shipping,
    complete,
    updated_at: nowIso(),
  };

  // Upsert keyed on (org_id, creator_id): update the existing row, else insert.
  const { data: existing } = await d
    .from("creator_onboarding")
    .select("id")
    .eq("org_id", me.org_id)
    .eq("creator_id", creatorId)
    .maybeSingle();

  if (existing) {
    await d
      .from("creator_onboarding")
      .update(patch)
      .eq("id", (existing as { id: string }).id)
      .eq("org_id", me.org_id);
  } else {
    const { error } = await d.from("creator_onboarding").insert({
      org_id: me.org_id,
      creator_id: creatorId,
      ...patch,
    });
    if (error && !isUniqueViolation(error)) {
      return { error: "Could not save the onboarding intake. Please try again." };
    }
    if (error && isUniqueViolation(error)) {
      // Raced with another insert — fall back to update.
      await d
        .from("creator_onboarding")
        .update(patch)
        .eq("org_id", me.org_id)
        .eq("creator_id", creatorId);
    }
  }

  // On complete, allow advancing the creator to 'onboarded' (the 'qualified'
  // pipeline stage) when the operator asked for it.
  const advance = String(formData.get("advance_onboarded") ?? "") === "on";
  if (complete && advance) {
    await d
      .from("creators")
      .update({ status: "onboarded", updated_at: nowIso() })
      .eq("id", creatorId)
      .eq("org_id", me.org_id);
  }

  revalidatePath("/affiliate/engage");
  if (wantComplete && !complete) {
    return {
      error: `Saved as in-progress — still need: ${missing.join(", ")}.`,
    };
  }
  return { ok: complete ? "Onboarding saved and marked complete." : "Onboarding progress saved." };
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Fulfillment: Samples + Content
// ════════════════════════════════════════════════════════════════════════════

export async function requestSample(formData: FormData): Promise<void> {
  const me = await actor();
  const creatorId = optText(formData, "creator_id");
  const productId = optText(formData, "product_id");
  if (!creatorId || !productId) return;

  await db()
    .from("affiliate_samples")
    .insert({
      org_id: me.org_id,
      campaign_id: optText(formData, "campaign_id"),
      creator_id: creatorId,
      product_id: productId,
      quantity: optNum(formData, "quantity", true) ?? 1,
      status: "requested",
      requested_by: me.id,
      requested_at: nowIso(),
      notes: optText(formData, "notes"),
    });

  revalidatePath("/affiliate/fulfillment");
}

// Move a sample forward (or to the reject off-ramp). Each transition stamps the
// timestamp + acting user the schema carries for that step, and is guarded on
// the current status so a stale button can't skip a stage.
export async function transitionSample(formData: FormData): Promise<void> {
  const me = await actor();
  const id = optText(formData, "id");
  const to = optText(formData, "to");
  if (!id || !to) return;

  const d = db();
  const { data: sample } = await d
    .from("affiliate_samples")
    .select("id, status")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .maybeSingle();
  const row = sample as { status: string } | null;
  if (!row || !canSampleTransition(row.status, to)) return;

  const patch: Record<string, unknown> = { status: to, updated_at: nowIso() };
  switch (to) {
    case "approved":
      patch.approved_by = me.id;
      patch.approved_at = nowIso();
      break;
    case "shipped":
      patch.courier = optText(formData, "courier");
      patch.tracking_number = optText(formData, "tracking_number");
      patch.shipped_at = nowIso();
      break;
    case "delivered":
      patch.delivered_at = nowIso();
      break;
    case "received":
      // Starts the content turnaround SLA (72h to Video 1, then 48h to Video
      // 2). Without this the status could reach 'received' and nothing recorded
      // when, leaving the countdown with nothing to count from.
      patch.received_at = nowIso();
      break;
    // 'rejected' carries no dedicated timestamp column — status only.
  }

  await d.from("affiliate_samples").update(patch).eq("id", id).eq("org_id", me.org_id);
  revalidatePath("/affiliate/fulfillment");
}

// ── Content pipeline ──────────────────────────────────────────────────────────
export async function createContent(formData: FormData): Promise<void> {
  const me = await actor();
  const creatorId = optText(formData, "creator_id");
  const contentType = optText(formData, "content_type");
  if (!creatorId || !contentType || !isContentType(contentType)) return;

  await db()
    .from("affiliate_content")
    .insert({
      org_id: me.org_id,
      campaign_id: optText(formData, "campaign_id"),
      creator_id: creatorId,
      sample_id: optText(formData, "sample_id"),
      product_id: optText(formData, "product_id"),
      content_type: contentType,
      platform: optText(formData, "platform"),
      content_url: optText(formData, "content_url"),
      status: "assigned",
      due_at: optTimestamp(formData, "due_at"),
      notes: optText(formData, "notes"),
    });

  revalidatePath("/affiliate/fulfillment");
}

export async function transitionContent(formData: FormData): Promise<void> {
  const me = await actor();
  const id = optText(formData, "id");
  const to = optText(formData, "to");
  if (!id || !to) return;

  const d = db();
  const { data: content } = await d
    .from("affiliate_content")
    .select("id, status")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .maybeSingle();
  const row = content as { status: string } | null;
  if (!row || !canContentTransition(row.status, to)) return;

  const patch: Record<string, unknown> = { status: to, updated_at: nowIso() };
  switch (to) {
    case "submitted": {
      patch.submitted_at = nowIso();
      // Capture / refresh the content URL at submission if provided.
      const url = optText(formData, "content_url");
      if (url) patch.content_url = url;
      break;
    }
    case "approved":
      patch.approved_at = nowIso();
      patch.reviewer_id = me.id;
      break;
    case "rejected":
      patch.reviewer_id = me.id;
      break;
    case "posted":
    case "live":
      patch.posted_at = nowIso();
      break;
  }

  await d.from("affiliate_content").update(patch).eq("id", id).eq("org_id", me.org_id);
  revalidatePath("/affiliate/fulfillment");
}

// Manual performance numbers — views / likes / gmv are hand-entered and stay
// honest nulls when blank (never a fabricated 0). Only the fields the operator
// actually filled are written, so a blank input never wipes an existing value.
export async function updateContentMetrics(formData: FormData): Promise<void> {
  const me = await actor();
  const id = optText(formData, "id");
  if (!id) return;

  const patch: Record<string, unknown> = { updated_at: nowIso() };
  const views = optNum(formData, "views", true);
  const likes = optNum(formData, "likes", true);
  const gmv = optNum(formData, "gmv");
  if (formData.get("views") != null && String(formData.get("views")).trim() !== "") patch.views = views;
  if (formData.get("likes") != null && String(formData.get("likes")).trim() !== "") patch.likes = likes;
  if (formData.get("gmv") != null && String(formData.get("gmv")).trim() !== "") patch.gmv = gmv;

  await db().from("affiliate_content").update(patch).eq("id", id).eq("org_id", me.org_id);
  revalidatePath("/affiliate/fulfillment");
}
