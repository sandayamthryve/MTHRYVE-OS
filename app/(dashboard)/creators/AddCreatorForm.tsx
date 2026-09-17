"use client";

// "Add creator" is the ONLY path that INSERTs a new `creators` row. The roster
// editor (updateCreatorRoster) always UPDATEs by id and can never insert, so a
// duplicate can only ever be born here. The server action guards against that by
// blocking a second creator that shares a normalized email in the org; that block
// is surfaced inline via useFormState rather than thrown, so the operator gets a
// clear "already exists — open it to edit" instead of a silent failure or a
// duplicate row. A unique index on (org_id, lower(email)) is the DB-level backstop.
//
// SnapFill: the form mounts <SnapFill> (BOTH modes) with the Affiliate-Leads field
// whitelist. Paste a row / "Label: value" lines, or snap a photo of a creator's
// profile, and it pre-fills the 8 whitelisted inputs (handle, name, email,
// follower_count, GMV, post_rate, viber, facebook_account) as editable suggestions.
// It only fills — the same createCreator server action still does the write (same
// role-gate, honest nulls), so nothing is saved until the operator reviews + submits.

import { useFormState, useFormStatus } from "react-dom";
import { useState } from "react";
import { SnapFill } from "@/components/snapfill/SnapFill";
import { CREATOR_SNAP_FIELDS } from "@/lib/snapfill/schema";

// The action reports an inline error OR a success note. The success note carries
// the best-effort campaign-link outcome (linked / already-linked / not linked)
// without ever failing the creator insert itself.
export type AddCreatorState = { error?: string; ok?: string } | null;

type Option = { value: string; label: string };

const fieldCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add creator"}
    </button>
  );
}

// The snap-fillable inputs are controlled so SnapFill can populate them; the rest
// (platform / category / tier / posts / phone) stay plain and manual.
const CONTROLLED_KEYS = [
  "handle",
  "name",
  "email",
  "follower_count",
  "attributed_gmv",
  "post_rate",
  "viber",
  "facebook_account",
] as const;
type ControlledKey = (typeof CONTROLLED_KEYS)[number];
type Values = Record<ControlledKey, string>;
const EMPTY: Values = {
  handle: "",
  name: "",
  email: "",
  follower_count: "",
  attributed_gmv: "",
  post_rate: "",
  viber: "",
  facebook_account: "",
};

export function AddCreatorForm({
  action,
  platforms,
  tiers,
  campaigns,
}: {
  action: (prev: AddCreatorState, formData: FormData) => Promise<AddCreatorState>;
  platforms: readonly Option[];
  tiers: readonly string[];
  // Active campaigns (public.campaigns) offered as an optional link target. The
  // label already carries the type, so the operator sees which kind they pick.
  campaigns: readonly Option[];
}) {
  const [state, formAction] = useFormState(action, null);
  const [values, setValues] = useState<Values>(EMPTY);
  const [filled, setFilled] = useState<Set<string>>(new Set());

  function set(key: ControlledKey, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  // Merge a SnapFill result into the controlled inputs. Only whitelisted keys land
  // (SnapFill already clamps); each becomes an editable, highlighted suggestion.
  function applyFill(result: { values: Record<string, string>; source: "paste" | "photo" }) {
    setValues((prev) => {
      const next = { ...prev };
      for (const k of CONTROLLED_KEYS) {
        if (result.values[k] !== undefined) next[k] = result.values[k];
      }
      return next;
    });
    setFilled(new Set(Object.keys(result.values)));
  }

  const cls = (key: ControlledKey) =>
    `${fieldCls} ${filled.has(key) ? "border-amber-500/60 bg-amber-500/5" : ""}`;

  return (
    <form
      action={formAction}
      className="mb-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate"
    >
      <h2 className="mb-3 text-sm font-semibold text-ink">Add creator</h2>

      <div className="mb-4">
        <SnapFill
          target="Affiliate creator / lead"
          schema={CREATOR_SNAP_FIELDS}
          onFill={applyFill}
          modes={["paste", "photo"]}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <input name="name" required placeholder="Creator name" className={cls("name")} value={values.name} onChange={(e) => set("name", e.target.value)} />
        <input name="handle" placeholder="TikTok username / handle" className={cls("handle")} value={values.handle} onChange={(e) => set("handle", e.target.value)} />
        <select name="platform" defaultValue="tiktok" className={fieldCls}>
          {platforms.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <input name="category" placeholder="Category (e.g. Beauty)" className={fieldCls} />
        <input name="follower_count" type="number" min="0" placeholder="Follower count" className={cls("follower_count")} value={values.follower_count} onChange={(e) => set("follower_count", e.target.value)} />
        <select name="tier" defaultValue="" aria-label="Tier" className={fieldCls}>
          <option value="">Tier — auto by reach</option>
          {tiers.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input name="posts_committed" type="number" min="0" placeholder="Weekly posts committed" className={fieldCls} />
        <input name="post_rate" placeholder="Post rate" className={cls("post_rate")} value={values.post_rate} onChange={(e) => set("post_rate", e.target.value)} />
        <input name="attributed_gmv" type="number" min="0" step="0.01" placeholder="Attributed GMV (PHP)" className={cls("attributed_gmv")} value={values.attributed_gmv} onChange={(e) => set("attributed_gmv", e.target.value)} />
        <input name="email" type="email" placeholder="Email" className={cls("email")} value={values.email} onChange={(e) => set("email", e.target.value)} />
        <input name="phone" placeholder="Phone" className={fieldCls} />
        <input name="viber" placeholder="Viber number" className={cls("viber")} value={values.viber} onChange={(e) => set("viber", e.target.value)} />
        <input name="facebook_account" placeholder="Facebook account" className={cls("facebook_account")} value={values.facebook_account} onChange={(e) => set("facebook_account", e.target.value)} />
      </div>

      {/* Optional campaign link — on submit, the new creator is linked to the
          chosen campaign (one affiliate_campaign_creators row). Best-effort: a
          link failure never fails the creator itself. */}
      <div className="mt-3">
        <label className="text-xs text-ink-muted">
          Campaign (optional) — link this creator to a campaign
          <select
            name="campaign_id"
            defaultValue=""
            aria-label="Campaign"
            className={`mt-1 w-full ${fieldCls}`}
          >
            <option value="">No campaign</option>
            {campaigns.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
      </div>

      {state?.error && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="mt-3 rounded-md border border-teal-500/30 bg-teal-500/5 p-2.5 text-xs text-teal-200">
          {state.ok}
        </p>
      )}
      <SubmitButton />
    </form>
  );
}
