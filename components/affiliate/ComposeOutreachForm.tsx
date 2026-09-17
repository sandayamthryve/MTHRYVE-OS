"use client";

// Outreach → compose. Picking a template prefills the channel, subject and body
// (all still editable); submitting only ever creates a status='draft' message —
// nothing sends here. A small live note reminds the operator whether the chosen
// channel is human-gated (email/SMS: approve → mark sent) or copy-only
// (Viber/WhatsApp/TikTok DM: copy & send by hand).

import { useMemo, useState } from "react";
import {
  CHANNEL_LABEL,
  OUTREACH_CHANNELS,
  isGatedChannel,
  type OutreachChannel,
} from "@/lib/affiliate/domain";

const fieldCls =
  "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

export type TemplateLite = {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string | null;
};
type Option = { value: string; label: string };

export function ComposeOutreachForm({
  action,
  creators,
  templates,
  campaigns = [],
}: {
  action: (formData: FormData) => void | Promise<void>;
  creators: readonly Option[];
  templates: readonly TemplateLite[];
  /** Campaigns this message can invite the creator to. Optional: outreach that
   *  names none is general outreach, which is most of it. */
  campaigns?: readonly Option[];
}) {
  const [templateId, setTemplateId] = useState("");
  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const templateById = useMemo(
    () => new Map(templates.map((t) => [t.id, t])),
    [templates]
  );

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templateById.get(id);
    if (!t) return;
    if (t.channel && (OUTREACH_CHANNELS as string[]).includes(t.channel)) {
      setChannel(t.channel as OutreachChannel);
    }
    setSubject(t.subject ?? "");
    setBody(t.body ?? "");
  }

  const gated = isGatedChannel(channel);
  // Naming a campaign is what makes this a campaign invite rather than general
  // outreach — the deck's Activation stage, and the term the team uses.
  const [campaignId, setCampaignId] = useState("");

  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="template_id" value={templateId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          Creator
          <select name="creator_id" required className={`mt-1 ${fieldCls}`} defaultValue="">
            <option value="" disabled>
              Choose a creator…
            </option>
            {creators.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Campaign invite
          <select
            name="campaign_id"
            value={campaignId}
            onChange={(event) => setCampaignId(event.target.value)}
            className={`mt-1 ${fieldCls}`}
            disabled={campaigns.length === 0}
          >
            <option value="">
              {campaigns.length === 0 ? "No campaigns yet" : "General outreach — no campaign"}
            </option>
            {campaigns.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Template
          <select
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className={`mt-1 ${fieldCls}`}
          >
            <option value="">— None (write from scratch) —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({CHANNEL_LABEL[t.channel as OutreachChannel] ?? t.channel})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          Channel
          <select
            name="channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as OutreachChannel)}
            className={`mt-1 ${fieldCls}`}
          >
            {OUTREACH_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Subject (optional)
          <input
            name="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject line"
            className={`mt-1 ${fieldCls}`}
          />
        </label>
      </div>

      <label className="text-xs text-ink-muted">
        Message body
        <textarea
          name="body"
          required
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write the outreach message…"
          className={`mt-1 ${fieldCls}`}
        />
      </label>

      <p
        className={`rounded-md border p-2.5 text-[11px] ${
          gated
            ? "border-violet-500/30 bg-violet-500/5 text-violet-200"
            : "border-charcoal-700 bg-charcoal-850 text-ink-muted"
        }`}
      >
        {gated
          ? `${CHANNEL_LABEL[channel]} is human-gated: this saves as a draft, then needs a leadership approval before it can be marked sent. Nothing auto-sends.`
          : `${CHANNEL_LABEL[channel]} is copy-only: this saves as a draft you copy and send by hand in ${CHANNEL_LABEL[channel]}. It is never marked sent here.`}
      </p>

      <div>
        <button
          type="submit"
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
        >
          Save draft
        </button>
      </div>
    </form>
  );
}
