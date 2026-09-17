"use server";

// lib/outreach/bridge-actions.ts — the server actions for the Lean Outreach
// Bridge. ONE recipient-agnostic set of actions serves BOTH audiences (client
// leads + affiliate creators); every action takes a recipient_type and gates on
// the function that owns that audience (Business Development for leads,
// Partnerships/Affiliate for creators) — NOT all-org.
//
// The governing line, mirrored from the rest of the OS:
//   • Vesper DRAFTS (the only automatic step) → a human APPROVES → the OS EXPORTS
//     a merge-ready CSV → the TEAM runs their free Gmail merge by hand → results
//     re-IMPORT to close the loop. NOTHING is auto-sent; no ESP, no API send, no
//     monthly cost. The OS never fakes a send.
//   • Suppression is a HARD pre-export filter (do_not_contact / opted_out / no
//     email / client-domain), every skip logged.
//   • Every APPROVE / EXPORT / IMPORT writes public.audit_log (service-role,
//     unforgeable) via lib/audit/log.ts.
//   • Honest nulls: a blank field is null, never a fabricated 0 / "" / date.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit/log";
import {
  draftOutreachMessage,
  enrichMessageWithClaude,
  type VesperTarget,
  type VesperContext,
} from "@/lib/outreach/vesper";
import {
  BRIDGE_ROLES,
  canRunBridge,
  isOutreachLeadership,
  isRecipientType,
  makeBatchLabel,
  buildMergeCsv,
  parseResultsCsv,
  suppressionReason,
  clientDomainsFrom,
  composeStoredBody,
  splitStoredBody,
  SUPPRESS_REASON_LABEL,
  type RecipientType,
  type MergeRow,
  type SuppressReason,
} from "@/lib/outreach/bridge";

// The outreach/leads/creators tables aren't in the generated Database types, so
// we reach them through the same cast shim the rest of the OS uses.
type Db = { from: (t: string) => any };
type Actor = {
  id: string;
  org_id: string;
  role: string;
  team_assignment: string | null;
};

function db(): Db {
  return createServerSupabaseClient() as unknown as Db;
}
const nowIso = () => new Date().toISOString();

// Resolve the caller, verifying they may run the bridge for THIS audience.
// Returns null when they can't (the action then no-ops — the UI never surfaces a
// control they aren't gated for anyway).
async function bridgeActor(recipientType: RecipientType): Promise<Actor | null> {
  const p = (await requireRole([...BRIDGE_ROLES])) as unknown as Actor;
  return canRunBridge(p, recipientType) ? p : null;
}

// The revalidate targets for an audience (both pages that host the bridge).
function pathsFor(recipientType: RecipientType): string[] {
  return recipientType === "lead" ? ["/leads"] : ["/affiliate/engage"];
}
function revalidate(recipientType: RecipientType) {
  for (const p of pathsFor(recipientType)) revalidatePath(p);
}

// ── The real fields Vesper may draft from (nothing invented) ──────────────────
const LEAD_FIELDS = "id, name, company, email, owner_id";
const CREATOR_FIELDS = "id, name, handle, platform, category, email, owner_id";

async function loadTarget(
  d: Db,
  me: Actor,
  recipientType: RecipientType,
  id: string
): Promise<VesperTarget | null> {
  const table = recipientType === "lead" ? "leads" : "creators";
  const fields = recipientType === "lead" ? LEAD_FIELDS : CREATOR_FIELDS;
  const { data } = await d.from(table).select(fields).eq("id", id).eq("org_id", me.org_id).maybeSingle();
  if (!data) return null;
  const r = data as Record<string, any>;
  if (recipientType === "lead") {
    return {
      kind: "lead",
      id: r.id,
      name: r.name ?? "",
      email: r.email ?? null,
      company: r.company ?? null,
      owner_id: r.owner_id ?? null,
    };
  }
  return {
    kind: "creator",
    id: r.id,
    name: r.name ?? "",
    email: r.email ?? null,
    handle: r.handle ?? null,
    platform: r.platform ?? null,
    category: r.category ?? null,
    owner_id: r.owner_id ?? null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1) DRAFT — Vesper composes a personalized EMAIL for a lead OR creator.
// ════════════════════════════════════════════════════════════════════════════
export type DraftState = { error?: string; ok?: string } | null;

export async function draftBridgeOutreach(_prev: DraftState, formData: FormData): Promise<DraftState> {
  const recipientType = String(formData.get("recipient_type") ?? "");
  if (!isRecipientType(recipientType)) return { error: "Unknown recipient type." };

  const me = await bridgeActor(recipientType);
  if (!me) return { error: "You don't have access to draft outreach here." };

  const id = String(formData.get("recipient_id") ?? "").trim();
  if (!id) return { error: `Pick a ${recipientType} to draft for.` };

  const d = db();
  const target = await loadTarget(d, me, recipientType, id);
  if (!target) return { error: `That ${recipientType} is no longer available.` };

  // Optional human context (brand / campaign / a one-line playbook note). All
  // optional — a blank field is simply not woven in (never fabricated).
  const ctx: VesperContext = {
    brand: (String(formData.get("brand") ?? "").trim() || null) as string | null,
    campaign: (String(formData.get("campaign") ?? "").trim() || null) as string | null,
    playbookNote: (String(formData.get("note") ?? "").trim() || null) as string | null,
  };

  // The bridge sends by Gmail merge → always an EMAIL draft. Deterministic base,
  // then a best-effort Claude polish that degrades to the base on any failure
  // (missing key / error / timeout) — so drafting works at $0 with no key set.
  const base = draftOutreachMessage(target, "email", ctx);
  const enriched = await enrichMessageWithClaude(base, target, "email", ctx, "outreach").catch(() => null);
  const msg = enriched ?? base;

  const { error: insErr } = await d.from("outreach_messages").insert({
    org_id: me.org_id,
    created_by: me.id,
    recipient_type: recipientType,
    recipient_id: target.id,
    channel: "email",
    body: composeStoredBody(msg.subject, msg.body),
    status: "draft",
    delivery_status: "draft",
  });
  if (insErr) return { error: "The draft couldn't be saved — please try again." };

  // A drafted touch is worth a timeline entry (org-scoped; keyed to the right side).
  await d.from("outreach_activities").insert({
    org_id: me.org_id,
    created_by: me.id,
    [recipientType === "lead" ? "lead_id" : "creator_id"]: target.id,
    activity_type: "outreach_drafted",
    note: "Vesper drafted an email outreach (bridge)",
    occurred_at: nowIso(),
  });

  revalidate(recipientType);
  return { ok: `Drafted an email to ${target.name || "the contact"} — review and approve it below.` };
}

// ── EDIT a draft's body inline (only while still a draft) ─────────────────────
export async function editBridgeDraft(formData: FormData): Promise<void> {
  const recipientType = String(formData.get("recipient_type") ?? "");
  if (!isRecipientType(recipientType)) return;
  const me = await bridgeActor(recipientType);
  if (!me) return;

  const id = String(formData.get("id") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!id || !body) return;

  const d = db();
  const { data: msg } = await d
    .from("outreach_messages")
    .select("id, status")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .eq("recipient_type", recipientType)
    .maybeSingle();
  // Only a draft may be edited — once approved, editing would bypass the gate.
  if (!msg || (msg as { status: string }).status !== "draft") return;

  await d
    .from("outreach_messages")
    .update({ body, updated_at: nowIso() })
    .eq("id", id)
    .eq("org_id", me.org_id);
  revalidate(recipientType);
}

// ════════════════════════════════════════════════════════════════════════════
// 2) APPROVE — the human gate. draft → approved (+ delivery_status='approved').
//    Leadership only (ceo/coo/department_head). Writes audit_log.
// ════════════════════════════════════════════════════════════════════════════
export async function approveBridgeMessage(formData: FormData): Promise<void> {
  const recipientType = String(formData.get("recipient_type") ?? "");
  if (!isRecipientType(recipientType)) return;
  const me = await bridgeActor(recipientType);
  if (!me || !isOutreachLeadership(me.role)) return;

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;

  const d = db();
  const { data: msg } = await d
    .from("outreach_messages")
    .select("id, status, recipient_id")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .eq("recipient_type", recipientType)
    .maybeSingle();
  const row = msg as { id: string; status: string; recipient_id: string | null } | null;
  if (!row || row.status !== "draft") return;

  const now = nowIso();
  await d
    .from("outreach_messages")
    .update({
      status: "approved",
      delivery_status: "approved",
      approved_by: me.id,
      approved_at: now,
      updated_at: now,
    })
    .eq("id", id)
    .eq("org_id", me.org_id);

  await writeAudit({
    action: "outreach_approved",
    entityType: "outreach_message",
    entityId: id,
    detail: { recipient_type: recipientType, recipient_id: row.recipient_id },
    actorUserId: me.id,
    actorRole: me.role,
    orgId: me.org_id,
  });

  revalidate(recipientType);
}

// ════════════════════════════════════════════════════════════════════════════
// 3) EXPORT — take the APPROVED batch, apply the suppression hard-filter, stamp
//    batch_label + exported_at + delivery_status='exported', and return a
//    merge-ready CSV for the human to run through their free Gmail merge.
//    Writes audit_log. Returns the CSV to the client island to download.
// ════════════════════════════════════════════════════════════════════════════
export type ExportState =
  | {
      at: string; // changes every run so the client always re-triggers the download
      csv?: string;
      filename?: string;
      batchLabel?: string;
      exported?: number;
      suppressed?: { name: string; reason: string }[];
      error?: string;
    }
  | null;

export async function exportApprovedBatch(_prev: ExportState, formData: FormData): Promise<ExportState> {
  const recipientType = String(formData.get("recipient_type") ?? "");
  const at = nowIso();
  if (!isRecipientType(recipientType)) return { at, error: "Unknown recipient type." };

  const me = await bridgeActor(recipientType);
  if (!me) return { at, error: "You don't have access to export here." };

  const d = db();

  // 1. The approved, not-yet-exported batch for this audience.
  const { data: approvedRows } = await d
    .from("outreach_messages")
    .select("id, recipient_id, body")
    .eq("org_id", me.org_id)
    .eq("recipient_type", recipientType)
    .eq("delivery_status", "approved")
    .order("approved_at", { ascending: true });
  const approved = (approvedRows ?? []) as { id: string; recipient_id: string | null; body: string | null }[];
  if (approved.length === 0) {
    return { at, error: "No approved messages to export — approve some drafts first." };
  }

  const recipientIds = Array.from(new Set(approved.map((m) => m.recipient_id).filter(Boolean))) as string[];

  // 2. Resolve each recipient's real fields (name/email + leads' suppression flags).
  const table = recipientType === "lead" ? "leads" : "creators";
  const fields = recipientType === "lead" ? "id, name, email, do_not_contact, opted_out_at" : "id, name, email";
  const { data: contactRows } = await d
    .from(table)
    .select(fields)
    .eq("org_id", me.org_id)
    .in("id", recipientIds.length ? recipientIds : ["00000000-0000-0000-0000-000000000000"]);
  const contactById = new Map(
    ((contactRows ?? []) as Record<string, any>[]).map((c) => [c.id as string, c])
  );

  // 3. The recipient-agnostic hard-stop backstop: any recipient with a prior
  //    bounced/opted_out message is suppressed (covers creators, which have no
  //    do_not_contact column of their own).
  const { data: hardStopRows } = await d
    .from("outreach_messages")
    .select("recipient_id")
    .eq("org_id", me.org_id)
    .eq("recipient_type", recipientType)
    .in("delivery_status", ["bounced", "opted_out"]);
  const hardStopIds = new Set(
    ((hardStopRows ?? []) as { recipient_id: string | null }[]).map((r) => r.recipient_id).filter(Boolean) as string[]
  );

  // 4. Existing-client domains (never cold-pitch a live client).
  const { data: brandRows } = await d
    .from("brands")
    .select("primary_contact_email")
    .eq("org_id", me.org_id)
    .is("archived_at", null);
  const clientDomains = clientDomainsFrom(
    ((brandRows ?? []) as { primary_contact_email: string | null }[]).map((b) => b.primary_contact_email)
  );

  // 5. Split into the export list vs. the suppressed list (every skip logged).
  const batchLabel = makeBatchLabel(recipientType, new Date(at));
  const mergeRows: MergeRow[] = [];
  const exportIds: string[] = [];
  const suppressed: { name: string; reason: string }[] = [];

  for (const m of approved) {
    const c = m.recipient_id ? contactById.get(m.recipient_id) : null;
    const name = (c?.name as string) ?? "Unknown";
    const email = (c?.email as string | null) ?? null;
    const reason: SuppressReason | null = suppressionReason(
      {
        email,
        do_not_contact: c?.do_not_contact ?? null,
        opted_out_at: c?.opted_out_at ?? null,
        priorHardStop: m.recipient_id ? hardStopIds.has(m.recipient_id) : false,
      },
      clientDomains
    );
    if (reason) {
      suppressed.push({ name, reason: SUPPRESS_REASON_LABEL[reason] });
      continue;
    }
    const { subject, body } = splitStoredBody(m.body, "A note from the team");
    mergeRows.push({ name, email: email as string, subject, body });
    exportIds.push(m.id);
  }

  if (exportIds.length === 0) {
    return {
      at,
      error: "Every approved message was suppressed — nothing to export.",
      suppressed,
    };
  }

  // 6. Stamp the exported rows (batch_label + exported_at + delivery_status).
  await d
    .from("outreach_messages")
    .update({ batch_label: batchLabel, exported_at: at, delivery_status: "exported", updated_at: at })
    .eq("org_id", me.org_id)
    .in("id", exportIds);

  await writeAudit({
    action: "outreach_exported",
    entityType: "outreach_batch",
    entityId: batchLabel,
    detail: {
      recipient_type: recipientType,
      exported: exportIds.length,
      suppressed: suppressed.length,
    },
    actorUserId: me.id,
    actorRole: me.role,
    orgId: me.org_id,
  });

  revalidate(recipientType);
  return {
    at,
    csv: buildMergeCsv(mergeRows),
    filename: `${batchLabel}.csv`,
    batchLabel,
    exported: exportIds.length,
    suppressed,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 4) IMPORT RESULTS — the human uploads the Gmail-merge result CSV (email +
//    status). Match by email within the exported batch, update delivery_status,
//    stamp last_contacted_at; a REPLY advances the stage + logs an activity; a
//    BOUNCE / OPT-OUT durably suppresses (leads: do_not_contact/opted_out_at).
//    Writes audit_log.
// ════════════════════════════════════════════════════════════════════════════
export type ImportState = {
  matched: number;
  updated: number;
  replied: number;
  suppressed: number;
  skipped: string[];
  error?: string;
} | null;

// Creator outreach_stage ladder (mirror of lib/affiliate/domain OUTREACH_STAGES)
// — a reply advances to 'replied' but never regresses a creator already past it.
const CREATOR_STAGE_ORDER = ["prospect", "contacted", "replied", "negotiating", "closed"];
function creatorStageAfterReply(current: string | null | undefined): string | null {
  const cur = CREATOR_STAGE_ORDER.indexOf((current ?? "").trim());
  const replied = CREATOR_STAGE_ORDER.indexOf("replied");
  return cur >= replied ? null : "replied";
}

export async function importBridgeResults(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const recipientType = String(formData.get("recipient_type") ?? "");
  if (!isRecipientType(recipientType)) {
    return { matched: 0, updated: 0, replied: 0, suppressed: 0, skipped: [], error: "Unknown recipient type." };
  }
  const me = await bridgeActor(recipientType);
  if (!me) {
    return { matched: 0, updated: 0, replied: 0, suppressed: 0, skipped: [], error: "You don't have access to import here." };
  }

  // Prefer an uploaded file; fall back to a pasted CSV.
  const file = formData.get("file");
  let text = "";
  if (file && typeof file !== "string" && (file as File).size > 0) {
    text = await (file as File).text();
  } else {
    text = String(formData.get("csv") ?? "");
  }

  const { rows, skipped } = parseResultsCsv(text);
  if (rows.length === 0) {
    return { matched: 0, updated: 0, replied: 0, suppressed: 0, skipped, error: "No usable rows in the results file." };
  }

  const d = db();

  // Candidate messages: this audience's EXPORTED (or already progressed) messages.
  // We only close the loop on rows that were actually exported for a merge.
  const { data: sentRows } = await d
    .from("outreach_messages")
    .select("id, recipient_id, delivery_status, exported_at")
    .eq("org_id", me.org_id)
    .eq("recipient_type", recipientType)
    .not("exported_at", "is", null)
    .order("exported_at", { ascending: false });
  const candidates = (sentRows ?? []) as {
    id: string;
    recipient_id: string | null;
    delivery_status: string;
    exported_at: string | null;
  }[];

  const recipientIds = Array.from(new Set(candidates.map((c) => c.recipient_id).filter(Boolean))) as string[];
  const table = recipientType === "lead" ? "leads" : "creators";
  const contactFields =
    recipientType === "lead" ? "id, email, stage" : "id, email, outreach_stage";
  const { data: contactRows } = await d
    .from(table)
    .select(contactFields)
    .eq("org_id", me.org_id)
    .in("id", recipientIds.length ? recipientIds : ["00000000-0000-0000-0000-000000000000"]);
  const contactById = new Map(((contactRows ?? []) as Record<string, any>[]).map((c) => [c.id as string, c]));

  // email → the most-recent exported message for that recipient (candidates are
  // ordered exported_at desc, so the first hit per email wins).
  const byEmail = new Map<string, { msgId: string; recipientId: string }>();
  for (const c of candidates) {
    if (!c.recipient_id) continue;
    const contact = contactById.get(c.recipient_id);
    const email = String(contact?.email ?? "").trim().toLowerCase();
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, { msgId: c.id, recipientId: c.recipient_id });
  }

  let matched = 0;
  let updated = 0;
  let replied = 0;
  let suppressedCount = 0;
  const now = nowIso();

  for (const r of rows) {
    const hit = byEmail.get(r.email);
    if (!hit) {
      skipped.push(`${r.email}: no exported message matched`);
      continue;
    }
    matched += 1;
    const contact = contactById.get(hit.recipientId);

    // Update the message's delivery outcome.
    await d
      .from("outreach_messages")
      .update({ delivery_status: r.outcome, updated_at: now })
      .eq("id", hit.msgId)
      .eq("org_id", me.org_id);
    updated += 1;

    // Any real outcome means the contact was actually reached — stamp the touch.
    const contactPatch: Record<string, unknown> = { last_contacted_at: now, updated_at: now };

    if (r.outcome === "replied") {
      if (recipientType === "lead") {
        const stage = String(contact?.stage ?? "");
        if (stage === "new" || stage === "contacted") contactPatch.stage = "in_conversation";
      } else {
        const next = creatorStageAfterReply(contact?.outreach_stage);
        if (next) contactPatch.outreach_stage = next;
      }
      replied += 1;
    }

    if (r.outcome === "bounced" || r.outcome === "opted_out") {
      if (recipientType === "lead") {
        contactPatch.do_not_contact = true;
        if (r.outcome === "opted_out") contactPatch.opted_out_at = now;
      }
      // Creators carry no do_not_contact column; the message's bounced/opted_out
      // delivery_status is itself the hard-stop the suppression filter honors.
      suppressedCount += 1;
    }

    await d.from(table).update(contactPatch).eq("id", hit.recipientId).eq("org_id", me.org_id);

    // Log the outcome to the contact's timeline.
    await d.from("outreach_activities").insert({
      org_id: me.org_id,
      created_by: me.id,
      [recipientType === "lead" ? "lead_id" : "creator_id"]: hit.recipientId,
      activity_type: `outreach_${r.outcome}`,
      note: `Merge result imported: ${r.outcome}`,
      occurred_at: now,
    });
  }

  await writeAudit({
    action: "outreach_results_imported",
    entityType: "outreach_batch",
    entityId: recipientType,
    detail: { recipient_type: recipientType, matched, updated, replied, suppressed: suppressedCount, unmatched: skipped.length },
    actorUserId: me.id,
    actorRole: me.role,
    orgId: me.org_id,
  });

  revalidate(recipientType);
  return { matched, updated, replied, suppressed: suppressedCount, skipped };
}
