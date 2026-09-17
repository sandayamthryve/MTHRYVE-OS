"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  draftOutreach,
  getEmailConfigStatus,
  type DraftOutreachInput,
  type DraftOutreachResult,
} from "@/app/(dashboard)/outreach/vesper-actions";
import {
  OUTREACH_CHANNELS,
  CHANNEL_LABEL,
  CHANNEL_DELIVERY_NOTE,
  isAutoSendChannel,
  type OutreachChannel,
} from "@/lib/outreach/channels";
import { CopyButton } from "./CopyButton";

// VESPER REACH — the drafting panel on a lead/creator. The human picks a channel,
// tone, and context; Vesper writes a personalized message and DRAFTS a gated
// 'send_outreach' request into the approval queue. NOTHING is sent here — email
// only sends after approval (and only if configured); Viber/DM are copy-paste
// only. A live preview + copy button appear right after drafting.

const TONE_OPTIONS: { value: string; label: string }[] = [
  { value: "operator", label: "Operator — blunt, brief, a little warmth" },
  { value: "coach", label: "Coach — warm, encouraging" },
  { value: "concise", label: "Concise — fewest words" },
  { value: "detailed", label: "Detailed — thorough context" },
];

const inputCls =
  "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500";

export function VesperReachPanel({
  targetType,
  targetId,
  hasEmail,
}: {
  targetType: "lead" | "creator";
  targetId: string;
  // Whether the contact has an email on file — drives an honest warning for the
  // email channel.
  hasEmail: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"outreach" | "reply">("outreach");
  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [tone, setTone] = useState<string>("operator");
  const [brand, setBrand] = useState("");
  const [campaign, setCampaign] = useState("");
  const [playbook, setPlaybook] = useState("");
  const [query, setQuery] = useState("");
  const [useAI, setUseAI] = useState(false);
  const [result, setResult] = useState<DraftOutreachResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<{ configured: boolean; detail: string | null } | null>(
    null
  );

  const emailSelected = channel === "email";
  const isReply = mode === "reply";

  // When the email channel is selected, probe whether a provider is configured so
  // we can warn honestly BEFORE drafting (never imply a send will happen when it
  // can't). Fetched once, lazily, on first email selection.
  useEffect(() => {
    if (!emailSelected || emailStatus) return;
    let alive = true;
    getEmailConfigStatus()
      .then((s) => {
        if (alive) setEmailStatus(s);
      })
      .catch(() => {
        /* leave unknown — the post-draft result still reports config honestly */
      });
    return () => {
      alive = false;
    };
  }, [emailSelected, emailStatus]);

  function run() {
    setError(null);
    setResult(null);
    const input: DraftOutreachInput = {
      targetType,
      targetId,
      channel,
      kind: mode,
      tonePreset: tone,
      brand: brand || null,
      campaign: campaign || null,
      playbookNote: playbook || null,
      query: isReply ? query : null,
      useAI,
    };
    startTransition(async () => {
      try {
        const res = await draftOutreach(input);
        setResult(res);
        if (res.ok) router.refresh();
        else setError(res.error ?? "Could not draft.");
      } catch {
        setError("Drafting failed. Please try again.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted">
        Vesper drafts a personalized message and sends it to the{" "}
        <a href="/approvals" className="underline hover:text-ink">
          approval queue
        </a>
        . Nothing is sent from here — email sends only after approval (and only if configured); Viber
        and DM replies are copy-paste only.
      </p>

      {/* Mode */}
      <div className="flex flex-wrap gap-2">
        {(["outreach", "reply"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              mode === m
                ? "border-teal-500 bg-teal-500/10 text-teal-300"
                : "border-charcoal-700 text-ink-muted hover:text-ink"
            }`}
          >
            {m === "outreach" ? "New outreach" : "Reply to buyer query"}
          </button>
        ))}
      </div>

      {/* Channel + tone */}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            Channel
          </span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as OutreachChannel)}
            className={inputCls}
          >
            {OUTREACH_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
                {isAutoSendChannel(c) ? " (auto-send on approval)" : " (copy-paste)"}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            Playbook tone
          </span>
          <select value={tone} onChange={(e) => setTone(e.target.value)} className={inputCls}>
            {TONE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-[11px] text-ink-dim">{CHANNEL_DELIVERY_NOTE[channel]}</p>

      {emailSelected && !hasEmail && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300">
          No email on file for this contact — add one, or approving the send will fail cleanly.
        </p>
      )}
      {emailSelected && emailStatus && (
        <p
          className={`rounded-md border p-2 text-[11px] ${
            emailStatus.configured
              ? "border-teal-500/30 bg-teal-500/5 text-teal-300"
              : "border-amber-500/30 bg-amber-500/5 text-amber-300"
          }`}
        >
          {emailStatus.configured
            ? `Email provider configured (${emailStatus.detail}) — approving the draft will send.`
            : "Email is not configured — you can still draft, but approving will surface a clear error and send nothing until SMTP_/EMAIL_ vars are set."}
        </p>
      )}

      {/* Context */}
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="Brand (optional)"
          className={inputCls}
        />
        <input
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
          placeholder="Campaign (optional)"
          className={inputCls}
        />
      </div>
      <input
        value={playbook}
        onChange={(e) => setPlaybook(e.target.value)}
        placeholder="Playbook note (optional) — e.g. lead with the 15% commission, keep it short"
        className={inputCls}
      />

      {isReply && (
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            Buyer's query (PH/Taglish reply)
          </span>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            placeholder="Paste the buyer's comment or DM here…"
            className={inputCls + " resize-y"}
          />
        </label>
      )}

      <label className="flex items-center gap-2 text-xs text-ink-muted">
        <input type="checkbox" checked={useAI} onChange={(e) => setUseAI(e.target.checked)} />
        Polish with Claude if configured (falls back to Vesper's template otherwise)
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={pending || (isReply && !query.trim())}
          className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {pending ? "Drafting…" : "Draft with Vesper"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {/* Success — preview + link + copy for copy-paste channels */}
      {result?.ok && (
        <div className="rounded-md border border-teal-500/30 bg-teal-500/5 p-3">
          <p className="text-xs text-teal-300">
            Drafted to the{" "}
            <a href="/approvals" className="underline hover:text-ink">
              approval queue
            </a>
            .{" "}
            {result.channel && isAutoSendChannel(result.channel)
              ? result.emailConfigured
                ? `Email is configured (${result.emailDetail}) — approve to send.`
                : "Email is NOT configured — approving will surface a clear error and send nothing until SMTP_/EMAIL_ vars are set."
              : "Copy-paste only — approve to log the touch after you send it by hand."}
          </p>
          {result.subject && (
            <p className="mt-2 text-xs text-ink-muted">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">Subject</span>{" "}
              {result.subject}
            </p>
          )}
          {result.message && (
            <>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-xs text-ink-muted">
                {result.message}
              </pre>
              {result.channel && !isAutoSendChannel(result.channel) && (
                <div className="mt-2">
                  <CopyButton text={result.message} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
