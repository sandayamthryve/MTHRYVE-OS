"use client";

// Vesper Reach → OUTBOUND. Select one or many creators, pick a channel (a chosen
// template sets it) and Vesper composes a personalized draft PER creator from that
// creator's real fields — saved as status='draft' for review. Nothing sends here.
// The credit/no-key case comes back as a calm inline note, never a crash.

import { useMemo, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  CHANNEL_LABEL,
  OUTREACH_CHANNELS,
  hasAppSender,
  type OutreachChannel,
} from "@/lib/affiliate/domain";
import type { VesperDraftState } from "@/app/(dashboard)/affiliate/vesper-actions";
import type { TemplateLite } from "@/components/affiliate/ComposeOutreachForm";

const fieldCls = "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

type CreatorOption = { value: string; label: string };

function SubmitButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="rounded-md bg-violet-500/90 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
    >
      {pending ? "Vesper is drafting…" : count === 0 ? "Select creators to draft" : `Draft with Vesper (${count})`}
    </button>
  );
}

export function DraftWithVesperPanel({
  action,
  creators,
  templates,
}: {
  action: (prev: VesperDraftState, formData: FormData) => Promise<VesperDraftState>;
  creators: readonly CreatorOption[];
  templates: readonly TemplateLite[];
}) {
  const [state, formAction] = useFormState(action, null);
  const formRef = useRef<HTMLFormElement>(null);

  const [channel, setChannel] = useState<OutreachChannel>("email");
  const [templateId, setTemplateId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const templateById = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templateById.get(id);
    if (t?.channel && (OUTREACH_CHANNELS as string[]).includes(t.channel)) {
      setChannel(t.channel as OutreachChannel);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return creators;
    return creators.filter((c) => c.label.toLowerCase().includes(q));
  }, [creators, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of filtered) next.add(c.value);
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }

  return (
    <form ref={formRef} action={formAction} className="grid gap-3">
      {/* Selected creator ids ride along as repeated hidden inputs. */}
      {Array.from(selected).map((id) => (
        <input key={id} type="hidden" name="creator_id" value={id} />
      ))}
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="template_id" value={templateId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          Channel
          <select
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
          Template frame (optional)
          <select value={templateId} onChange={(e) => applyTemplate(e.target.value)} className={`mt-1 ${fieldCls}`}>
            <option value="">— None (Vesper writes from scratch) —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({CHANNEL_LABEL[t.channel as OutreachChannel] ?? t.channel})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter creators…"
            className={`${fieldCls} flex-1`}
          />
          <button type="button" onClick={selectAllFiltered} className="whitespace-nowrap rounded-md border border-charcoal-700 bg-charcoal-850 px-2.5 py-2 text-xs text-ink hover:bg-charcoal-800">
            Select shown
          </button>
          <button type="button" onClick={clearSelection} className="whitespace-nowrap rounded-md border border-charcoal-700 bg-charcoal-850 px-2.5 py-2 text-xs text-ink hover:bg-charcoal-800">
            Clear
          </button>
        </div>
        <div className="max-h-56 overflow-y-auto rounded-md border border-charcoal-700 bg-charcoal-950 p-1">
          {filtered.length === 0 ? (
            <p className="p-3 text-xs text-ink-dim">No creators match.</p>
          ) : (
            filtered.map((c) => (
              <label
                key={c.value}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-ink hover:bg-charcoal-800/60"
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.value)}
                  onChange={() => toggle(c.value)}
                  className="h-4 w-4 accent-violet-500"
                />
                {c.label}
              </label>
            ))
          )}
        </div>
      </div>

      <p className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2.5 text-[11px] text-violet-200">
        Vesper writes one personalized draft per selected creator from their real profile fields — it never invents a
        follower count, GMV, or promise. Each saves as a <strong>draft</strong>;{" "}
        {hasAppSender(channel)
          ? "email drafts need leadership approval, then the app sends them."
          : `${CHANNEL_LABEL[channel]} drafts are copy-to-send after approval.`}{" "}
        Nothing sends automatically.
      </p>

      {state?.error && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">{state.error}</p>
      )}
      {state?.ok && (
        <p className="rounded-md border border-teal-500/30 bg-teal-500/5 p-2.5 text-xs text-teal-200">{state.ok}</p>
      )}

      <div>
        <SubmitButton count={selected.size} />
      </div>
    </form>
  );
}
