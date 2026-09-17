// lib/outreach/vesper.ts — VESPER, the outreach drafting brain (V2). Given a
// client lead OR an affiliate/KOL creator plus context (brand, campaign, playbook
// tone) and a channel, Vesper writes a personalized message and packages it as a
// DRAFT action_request (proposed_action.type = 'send_outreach'). It NEVER sends —
// drafting is automatic, SENDING is approval-gated and lives in the executor.
//
// GOVERNING RULE (DECISIONS.md D-005): Vesper DRAFTS, a human APPROVES, then the
// OS acts. And, like every producer in this repo, Vesper never fabricates: each
// message is built only from fields that actually exist (name / company for
// leads; name / @handle / platform / category for creators) plus the context the
// user explicitly supplied (brand, campaign, tone). Nothing invents a price, a
// metric, or a promise.
//
// This module is PURE (no DB, no network) so it can be unit-reasoned and shared
// by the server producer and the UI — exactly like lib/actions/follow-ups.ts. The
// one network touch (optional Claude enrichment) is an explicit, fully-guarded
// helper at the bottom that always degrades to the deterministic draft.

import type { TonePreset } from "@/lib/assistant/tone";
import {
  type OutreachChannel,
  CHANNEL_LABEL,
  isAutoSendChannel,
} from "./channels";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "@/lib/actions/types";

// ── The target Vesper writes to (a lead XOR a creator) ────────────────────────

export interface VesperTarget {
  kind: "lead" | "creator";
  id: string;
  name: string;
  email: string | null;
  // Leads carry a company; creators carry a handle/platform/category.
  company?: string | null;
  handle?: string | null;
  platform?: string | null;
  category?: string | null;
  owner_id?: string | null;
}

// The context the human supplies to steer the draft. All optional — a blank field
// is simply not woven in (never fabricated).
export interface VesperContext {
  brand?: string | null;
  campaign?: string | null;
  tonePreset?: TonePreset | null;
  // Freeform playbook guidance (a line the user pastes, e.g. "lead with the
  // 15% commission, keep it short"). Shown in the draft's reasoning, never faked.
  playbookNote?: string | null;
}

// "New outreach" writes a first/next touch; "reply" answers a buyer's query
// (comment/DM) in PH/Taglish.
export type VesperKind = "outreach" | "reply";

// ── Tone → deterministic style (no LLM needed) ────────────────────────────────

interface Style {
  warm: boolean; // warmer greeting/sign-off
  terse: boolean; // trim the middle to essentials
  emoji: boolean; // a light emoji is welcome
}

const STYLE_BY_PRESET: Record<TonePreset, Style> = {
  operator: { warm: true, terse: true, emoji: false },
  coach: { warm: true, terse: false, emoji: true },
  concise: { warm: false, terse: true, emoji: false },
  detailed: { warm: true, terse: false, emoji: false },
  custom: { warm: true, terse: false, emoji: false },
};

function styleFor(tone: TonePreset | null | undefined): Style {
  return STYLE_BY_PRESET[tone ?? "operator"] ?? STYLE_BY_PRESET.operator;
}

function firstName(name: string): string {
  return (name ?? "").trim().split(/\s+/)[0] || name;
}

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  shopee: "Shopee",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  other: "your channel",
};

function platformLabel(platform: string | null | undefined): string {
  const p = (platform ?? "").trim().toLowerCase();
  return PLATFORM_LABEL[p] ?? (platform || "your channel");
}

// A "for {brand}" / "on the {campaign} campaign" fragment, only when supplied.
function brandFragment(ctx: VesperContext): string {
  return ctx.brand ? ` for ${ctx.brand}` : "";
}
function campaignFragment(ctx: VesperContext): string {
  return ctx.campaign ? ` on our ${ctx.campaign} campaign` : "";
}

function signOff(ctx: VesperContext, style: Style): string {
  const from = ctx.brand ? `The ${ctx.brand} team` : "The Mthryve team";
  return style.warm ? `Thanks so much,\n${from}` : `Best,\n${from}`;
}

// ── Message generation ────────────────────────────────────────────────────────

export interface DraftedMessage {
  // Only email carries a subject; viber/dm leave it null.
  subject: string | null;
  body: string;
}

// A first/next outreach touch, shaped by channel + tone + context.
export function draftOutreachMessage(
  target: VesperTarget,
  channel: OutreachChannel,
  ctx: VesperContext
): DraftedMessage {
  const style = styleFor(ctx.tonePreset);
  const who = firstName(target.name);

  if (target.kind === "creator") {
    const cat = target.category ? ` your ${target.category} content` : " your content";
    const plat = platformLabel(target.platform);
    const brandBit = ctx.brand ? ` with ${ctx.brand}` : " with our brands";
    const campBit = campaignFragment(ctx);

    if (channel === "email") {
      const subject = ctx.campaign
        ? `Collab${brandBit} — ${ctx.campaign}`
        : `Partnership${brandBit}`;
      const body = [
        `Hi ${who},`,
        "",
        `We've been following${cat} on ${plat} and think there's a great fit for a collab${brandBit}${campBit}.` +
          (style.terse ? "" : ` Your audience is exactly who we're trying to reach, and your style lines up with how we like to show up.`),
        "",
        `Would you be open to a quick chat about working together? Happy to share the details, deliverables, and commission on a short call or over chat — whatever's easiest.`,
        "",
        signOff(ctx, style),
      ].join("\n");
      return { subject, body };
    }

    // Viber / DM — casual, short, first-person.
    const hi = style.emoji ? `Hey ${who}! 👋` : `Hey ${who}!`;
    const body = [
      hi,
      "",
      `We love${cat} on ${plat} and would love to collab${brandBit}${campBit}. ` +
        `Would you be open to a quick chat about a partnership? No pressure at all${style.emoji ? " 🙌" : ""} — just let us know!`,
      "",
      ctx.brand ? `– The ${ctx.brand} team` : "– The Mthryve team",
    ].join("\n");
    return { subject: null, body };
  }

  // Client lead.
  const co = target.company ? ` at ${target.company}` : "";
  const brandBit = brandFragment(ctx);
  const campBit = campaignFragment(ctx);

  if (channel === "email") {
    const subject = target.company
      ? `${ctx.brand ? `${ctx.brand} × ` : ""}${target.company}`
      : ctx.brand
        ? `An idea from ${ctx.brand}`
        : `Reaching out`;
    const body = [
      `Hi ${who},`,
      "",
      `I'm reaching out${brandBit} to see if there's a fit worth exploring together${co ? `, given the work you're doing${co}` : ""}${campBit}.` +
        (style.terse ? "" : ` We help brands like yours grow through creator-led commerce, and I think there's real overlap here.`),
      "",
      `Would you be open to a short call to compare notes? I'll work around your schedule — just let me know a couple of times that suit you.`,
      "",
      signOff(ctx, style),
    ].join("\n");
    return { subject, body };
  }

  // Viber / DM to a lead.
  const hi = style.emoji ? `Hi ${who}! 👋` : `Hi ${who},`;
  const body = [
    hi,
    "",
    `Reaching out${brandBit}${campBit} — I think there's a great fit worth a quick chat${co ? ` with the team${co}` : ""}. ` +
      `Would you be open to connecting? Happy to work around your schedule.`,
    "",
    ctx.brand ? `– The ${ctx.brand} team` : "– The Mthryve team",
  ].join("\n");
  return { subject: null, body };
}

// A PH/Taglish reply suggestion for a buyer's comment/DM query. Warm, helpful,
// and honest — it answers the shape of the question but never invents a price,
// stock count, or promise the user didn't supply. The human edits specifics
// before sending.
export function draftReplyMessage(
  target: VesperTarget,
  ctx: VesperContext,
  query: string
): DraftedMessage {
  const who = firstName(target.name || "");
  const style = styleFor(ctx.tonePreset);
  const greetName = who ? ` ${who}` : "";
  const brandBit = ctx.brand ? ` sa ${ctx.brand}` : "";

  // A light, honest Taglish reply. The bracketed cues remind the human to drop in
  // the real specifics (price/stock/link) — Vesper never fabricates them.
  const opener = style.warm
    ? `Hi${greetName}! Salamat sa message mo${style.emoji ? " 💛" : ""}`
    : `Hi${greetName}! Salamat sa message.`;

  const body = [
    opener,
    "",
    `Re sa tanong mo: "${query.trim()}" — heto ang sagot ko:`,
    "",
    `[I-fill in ang exact details dito — price, stock, o link. Wag mag-quote ng hindi confirmed.]`,
    "",
    `Available po kami${brandBit} to help — just let us know if may follow-up question ka pa. Sagutin namin agad!${style.emoji ? " 🙌" : ""}`,
    "",
    ctx.brand ? `– ${ctx.brand}` : "– Mthryve",
  ].join("\n");

  return { subject: null, body };
}

// ── The drafted action_request (org_id stamped by the caller/producer) ─────────

export interface VesperDraft {
  source_module: "outreach"; // Vesper's own source lane on the queue
  source_ref: Record<string, unknown>;
  title: string;
  problem: string;
  root_cause: string;
  evidence: EvidenceFact[];
  options: ActionOption[];
  recommendation: string;
  estimated_impact: EstimatedImpact;
  confidence: number;
  risk_tier: number;
  required_role: RequiredRole;
  proposed_action: ProposedAction;
}

function targetLabel(target: VesperTarget): string {
  if (target.kind === "creator") {
    return target.handle ? `${target.name} (${target.handle})` : target.name;
  }
  return target.company ? `${target.name} (${target.company})` : target.name;
}

// The options a reviewer weighs, tailored to whether the channel auto-sends.
function outreachOptions(channel: OutreachChannel): ActionOption[] {
  const label = CHANNEL_LABEL[channel];
  if (isAutoSendChannel(channel)) {
    return [
      {
        label: `Approve & send the ${label}`,
        tradeoff:
          "Sends it now (only if an email provider is configured) and logs the touch — fastest path, but it does leave your inbox.",
      },
      {
        label: "Edit the draft first",
        tradeoff: "Tweak Vesper's wording before it goes — costs a moment, keeps you fully in control of the message.",
      },
      {
        label: "Reject",
        tradeoff: "Nothing is sent — right if the timing or angle is off.",
      },
    ];
  }
  return [
    {
      label: `Copy & send the ${label} by hand`,
      tradeoff: `Approving logs the touch; you paste the message into ${label} yourself. Respects the platform's no-automation rule.`,
    },
    {
      label: "Edit the draft first",
      tradeoff: "Adjust Vesper's wording before you copy it out — keeps the message yours.",
    },
    {
      label: "Reject",
      tradeoff: "Discards the draft — nothing is logged or sent.",
    },
  ];
}

export interface BuildDraftInput {
  target: VesperTarget;
  channel: OutreachChannel;
  ctx: VesperContext;
  kind: VesperKind;
  // Present only for kind='reply' — the buyer's query being answered.
  query?: string | null;
  // If a caller (e.g. the AI enrichment path) already produced the message, pass
  // it here to skip the deterministic generator. Otherwise Vesper writes it.
  message?: DraftedMessage | null;
}

// Assemble the full send_outreach draft. Pure — the producer stamps org_id and
// inserts it as status='pending'.
export function buildVesperDraft(input: BuildDraftInput): VesperDraft {
  const { target, channel, ctx, kind } = input;
  const who = targetLabel(target);
  const channelLabel = CHANNEL_LABEL[channel];
  const auto = isAutoSendChannel(channel);

  const message =
    input.message ??
    (kind === "reply"
      ? draftReplyMessage(target, ctx, input.query ?? "")
      : draftOutreachMessage(target, channel, ctx));

  const evidence: EvidenceFact[] = [
    { label: "Channel", value: channelLabel },
    { label: "Contact", value: who },
  ];
  if (target.kind === "creator" && target.platform) {
    evidence.push({ label: "Platform", value: platformLabel(target.platform) });
  }
  if (channel === "email") {
    evidence.push({ label: "Email on file", value: target.email ? target.email : "None — add one" });
  }
  if (ctx.brand) evidence.push({ label: "Brand", value: ctx.brand });
  if (ctx.campaign) evidence.push({ label: "Campaign", value: ctx.campaign });
  if (ctx.playbookNote) evidence.push({ label: "Playbook", value: ctx.playbookNote });

  const deliveredHow = auto
    ? "the OS sends it on approval (only if an email provider is configured — otherwise it's blocked with an honest error, never a faked send)"
    : `you copy it and send it in ${channelLabel} by hand (it is never auto-sent)`;

  const problem =
    kind === "reply"
      ? `${who} sent a buyer query and it needs a fast, on-brand reply. Vesper drafted a PH/Taglish suggestion; ${deliveredHow}.`
      : `${who} is worth a ${channelLabel} touch${ctx.campaign ? ` for the ${ctx.campaign} campaign` : ""}. Vesper drafted a personalized message; ${deliveredHow}.`;

  const recommendation = auto
    ? `Review Vesper's ${channelLabel} draft and, if it reads right, approve to send. Only a configured email provider will actually send — otherwise you'll get a clear "not configured" note and nothing goes out.`
    : `Review Vesper's ${channelLabel} draft, tweak if needed, copy it, and send it by hand. Approving logs the touch to the timeline — no automated sending happens.`;

  return {
    source_module: "outreach",
    source_ref: {
      [target.kind === "creator" ? "creator_id" : "lead_id"]: target.id,
      owner_id: target.owner_id ?? null,
      channel,
      kind,
    },
    title:
      kind === "reply"
        ? `Reply to ${who} · ${channelLabel}`
        : `Outreach: ${who} · ${channelLabel}`,
    problem,
    root_cause:
      kind === "reply"
        ? "An unanswered buyer query goes cold fast and reads as poor service; a prompt, warm reply protects the sale."
        : "A timely, personalized, on-brand touch converts far better than a generic or late one — and Vesper can draft it in seconds.",
    evidence,
    options: outreachOptions(channel),
    recommendation,
    estimated_impact: {
      summary:
        kind === "reply"
          ? `A fast, on-brand reply keeps ${who} engaged and protects the sale.`
          : `A personalized ${channelLabel} touch keeps ${who} moving through the pipeline.`,
      gap_value: null,
      gap_unit: null,
      is_money: false,
    },
    // Modest, honest confidence: Vesper is sure it's a reasonable draft, not that
    // it's the perfect message — the human edits and decides.
    confidence: 0.7,
    // L2: a message that (for email) leaves the building. Department head or
    // leadership approves — same tier as the follow-up loop.
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "send_outreach",
      payload: {
        [target.kind === "creator" ? "creator_id" : "lead_id"]: target.id,
        channel,
        kind,
        subject: message.subject,
        recipient: channel === "email" ? target.email : null,
        drafted_message: message.body,
        brand: ctx.brand ?? null,
        campaign: ctx.campaign ?? null,
        // Fidelity to the spec's "status='draft'": a send_outreach payload is born
        // a draft; the real lifecycle is the action_request status (pending →
        // executed/failed). Viber/DM never leave 'draft' semantics (copy-paste).
        status: "draft",
      },
    },
  };
}

// ── Optional Claude enrichment (fully guarded) ────────────────────────────────

// When ANTHROPIC_API_KEY is set, Vesper can ask Claude to polish the deterministic
// draft into a more natural message. This is BEST-EFFORT: any missing key, error,
// or timeout returns null and the caller keeps the deterministic draft. It never
// throws and never blocks the gated pipeline. Server-only.
export async function enrichMessageWithClaude(
  base: DraftedMessage,
  target: VesperTarget,
  channel: OutreachChannel,
  ctx: VesperContext,
  kind: VesperKind,
  query?: string | null
): Promise<DraftedMessage | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  const guidance: string[] = [
    `Channel: ${CHANNEL_LABEL[channel]}.`,
    `Recipient: ${targetLabel(target)}${target.kind === "creator" ? " (a content creator)" : " (a business lead)"}.`,
    ctx.brand ? `Brand: ${ctx.brand}.` : "",
    ctx.campaign ? `Campaign: ${ctx.campaign}.` : "",
    ctx.playbookNote ? `Playbook tone: ${ctx.playbookNote}.` : "",
    kind === "reply"
      ? `This is a reply to a buyer's query: "${(query ?? "").slice(0, 400)}". Write it in warm PH/Taglish. Do NOT invent prices, stock, or promises — leave a clearly-bracketed placeholder where a real specific is needed.`
      : `This is a first/next outreach touch. Keep it personalized and honest — invent no numbers or promises.`,
  ].filter(Boolean);

  const system =
    "You are Vesper, a warm, concise outreach copywriter for a Philippine creator-commerce company. " +
    "Rewrite the DRAFT into a natural, on-tone message. NEVER fabricate a price, metric, discount, or promise " +
    "that isn't in the draft — if a specific is needed, keep a clearly bracketed placeholder. Return ONLY the message text.";

  const user =
    `${guidance.join("\n")}\n\n` +
    (base.subject ? `Current subject: ${base.subject}\n` : "") +
    `DRAFT to improve:\n${base.body}\n\n` +
    (channel === "email"
      ? `Return the email as: first line "Subject: ...", then a blank line, then the body.`
      : `Return just the message body (no subject).`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 700,
        system,
        messages: [{ role: "user", content: user }],
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!text) return null;

    if (channel === "email") {
      const m = text.match(/^\s*subject:\s*(.+?)\r?\n\r?\n?([\s\S]*)$/i);
      if (m) return { subject: m[1].trim() || base.subject, body: m[2].trim() || base.body };
      return { subject: base.subject, body: text };
    }
    return { subject: null, body: text };
  } catch {
    return null; // any failure → keep the deterministic draft
  }
}
