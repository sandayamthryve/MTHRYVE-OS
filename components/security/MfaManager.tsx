"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { reportMfaEvent } from "@/lib/security/report";

// Settings → Security · MFA. A self-contained client island: it talks straight to
// Supabase auth (supabase.auth.mfa.*) for enroll / list / unenroll, and reports
// each success to /api/auth/mfa/audit for the privileged audit trail.
//
// SAFETY the whole flow is built around (see docs/MFA.md):
//   • Enrolling here NEVER changes anyone's login until leadership turns on
//     MFA_ENFORCEMENT_ENABLED. Until then this is purely opt-in.
//   • A required-role user with no factor is nudged (banner), never blocked — the
//     login gate routes them here rather than to a wall.
//   • Removing a factor requires RE-AUTH: the user must enter a current code
//     (which steps the session up to aal2) before the unenroll is accepted.

type FactorRow = { id: string; friendlyName: string; status: string };

type EnrollDraft = { factorId: string; qr: string; secret: string; uri: string };

// factor_type / status live on the SDK's Factor rows; we read them structurally
// so we don't couple to the SDK's exported types.
type RawFactor = {
  id: string;
  factor_type?: string;
  friendly_name?: string | null;
  status?: string;
};

const FRIENDLY_NAME = "Authenticator";

export function MfaManager({
  enforcementEnabled,
  roleRequiresMfa,
}: {
  enforcementEnabled: boolean;
  roleRequiresMfa: boolean;
}) {
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [factors, setFactors] = useState<FactorRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Enrollment sub-flow: the pending (unverified) factor + its QR/secret, and the
  // code the user is typing to verify it.
  const [draft, setDraft] = useState<EnrollDraft | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [busy, setBusy] = useState(false);

  // Removal sub-flow: which factor we're removing + the re-auth code.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeCode, setRemoveCode] = useState("");

  const hasVerified = factors.length > 0;

  const refresh = useCallback(async () => {
    setError(null);
    const { data, error: listErr } = await supabase.auth.mfa.listFactors();
    if (listErr) {
      setError("Couldn't load your authenticators. Refresh and try again.");
      setLoading(false);
      return;
    }
    const all = ((data?.all ?? []) as RawFactor[]).filter((f) => f.factor_type === "totp");
    setFactors(
      all
        .filter((f) => f.status === "verified")
        .map((f) => ({
          id: f.id,
          friendlyName: f.friendly_name || "Authenticator",
          status: f.status || "verified",
        }))
    );
    setLoading(false);
    return all;
  }, [supabase]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Begin enrollment. Supabase rejects a second factor sharing a friendly name,
  // and an abandoned attempt leaves an UNVERIFIED factor behind — so we clear any
  // stale unverified totp factors first (safe: unverified factors protect
  // nothing and need no re-auth to remove), then enroll a fresh one.
  async function startEnroll() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { data: listed } = await supabase.auth.mfa.listFactors();
      const stale = ((listed?.all ?? []) as RawFactor[]).filter(
        (f) => f.factor_type === "totp" && f.status !== "verified"
      );
      for (const f of stale) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }

      const { data, error: enrollErr } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: FRIENDLY_NAME,
      });
      if (enrollErr || !data) {
        setError(enrollErr?.message || "Couldn't start enrollment. Try again.");
        return;
      }
      setDraft({
        factorId: data.id,
        qr: data.totp.qr_code,
        secret: data.totp.secret,
        uri: data.totp.uri,
      });
      setEnrollCode("");
    } catch {
      setError("Couldn't start enrollment. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Verify the 6-digit code against the pending factor. On success the factor
  // becomes verified AND the session steps up to aal2 — which matters when
  // enforcement is on: the user who just enrolled is immediately compliant and
  // won't be bounced to the challenge on their next click.
  async function confirmEnroll() {
    if (!draft) return;
    const code = enrollCode.trim();
    if (code.length < 6) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
        factorId: draft.factorId,
        code,
      });
      if (verifyErr) {
        setError("That code didn't match. Check the app and try again.");
        return;
      }
      void reportMfaEvent("mfa_enrolled", { factorId: draft.factorId, friendlyName: FRIENDLY_NAME });
      setDraft(null);
      setEnrollCode("");
      setNotice("Authenticator added ✓");
      await refresh();
    } catch {
      setError("That code didn't match. Check the app and try again.");
    } finally {
      setBusy(false);
    }
  }

  // Cancel an in-progress enrollment: drop the unverified factor so it doesn't
  // linger. Best-effort — if the cleanup fails the next startEnroll() clears it.
  async function cancelEnroll() {
    const pending = draft;
    setDraft(null);
    setEnrollCode("");
    setError(null);
    if (pending) {
      try {
        await supabase.auth.mfa.unenroll({ factorId: pending.factorId });
      } catch {
        /* ignore — cleared on next enroll */
      }
    }
  }

  // Remove a verified factor. RE-AUTH REQUIRED: the entered code is verified
  // (stepping the session to aal2) before we unenroll. This is why removing MFA
  // can't be done from a stale session or by someone who only has the password.
  async function confirmRemove(factorId: string) {
    const code = removeCode.trim();
    if (code.length < 6) {
      setError("Enter a current 6-digit code to confirm removal.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
      if (verifyErr) {
        setError("That code didn't match — the authenticator was not removed.");
        return;
      }
      const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId });
      if (unenrollErr) {
        setError(unenrollErr.message || "Couldn't remove the authenticator. Try again.");
        return;
      }
      void reportMfaEvent("mfa_unenrolled", { factorId });
      setRemovingId(null);
      setRemoveCode("");
      setNotice("Authenticator removed.");
      await refresh();
    } catch {
      setError("Couldn't remove the authenticator. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2 font-mono text-lg tracking-[0.3em] text-ink placeholder:tracking-normal placeholder:text-ink-muted focus:border-teal-500";

  return (
    <div className="flex flex-col gap-4">
      {/* Status line: enrolled vs not, and whether the org is enforcing. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink">
          {hasVerified ? "Two-factor authentication is on ✓" : "Two-factor authentication is off"}
        </span>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
            enforcementEnabled
              ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
              : "border-charcoal-700 bg-charcoal-800 text-ink-muted"
          }`}
        >
          {enforcementEnabled ? "Enforced at login" : "Enforcement off"}
        </span>
      </div>

      {/* Required-role nudge — never a wall. */}
      {roleRequiresMfa && !hasVerified && (
        <div className="rounded-lg border border-gold-500/40 bg-gold-500/10 px-4 py-3 text-sm text-gold-300">
          {enforcementEnabled
            ? "Your role requires two-factor authentication. Add an authenticator below to keep your access — you won't be locked out in the meantime."
            : "Your role will require two-factor authentication once it's enforced. Set it up now so the switch is a non-event for you."}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      {notice && !error && <p className="text-sm text-teal-300">{notice}</p>}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : draft ? (
        // ── Enrollment: show QR + secret, take the verification code ──────────
        <div className="flex flex-col gap-4 rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-4">
          <div>
            <p className="mb-1 text-sm font-medium text-ink">
              1. Scan this with your authenticator app
            </p>
            <p className="text-xs text-ink-muted">
              Google Authenticator, 1Password, Authy — any TOTP app works.
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-4">
            {/* qr_code is an SVG data-URI from Supabase — safe to render directly. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={draft.qr}
              alt="Authenticator QR code"
              width={176}
              height={176}
              className="h-44 w-44 rounded-md border border-charcoal-700 bg-white p-2"
            />
            <div className="min-w-[12rem] flex-1">
              <p className="mb-1 text-xs text-ink-muted">Can't scan? Enter this key manually:</p>
              <code className="block break-all rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 font-mono text-xs text-ink">
                {draft.secret}
              </code>
            </div>
          </div>
          <div>
            <label htmlFor="mfa-enroll-code" className="mb-1.5 block text-sm text-ink">
              2. Enter the 6-digit code it shows
            </label>
            <input
              id="mfa-enroll-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={enrollCode}
              onChange={(e) => setEnrollCode(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="000000"
              className={inputClass}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={confirmEnroll}
              disabled={busy}
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
            >
              {busy ? "Verifying…" : "Verify & turn on"}
            </button>
            <button
              onClick={cancelEnroll}
              disabled={busy}
              className="rounded-md border border-charcoal-700 px-4 py-2 text-sm text-ink-muted hover:bg-charcoal-800 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : hasVerified ? (
        // ── Manage existing factors ──────────────────────────────────────────
        <ul className="flex flex-col gap-2">
          {factors.map((f) => (
            <li
              key={f.id}
              className="flex flex-col gap-3 rounded-md border border-charcoal-700/60 bg-charcoal-950 px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink">{f.friendlyName}</span>
                <span className="inline-flex items-center rounded-full border border-teal-500/40 bg-teal-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-teal-300">
                  Verified
                </span>
                {removingId !== f.id && (
                  <button
                    onClick={() => {
                      setRemovingId(f.id);
                      setRemoveCode("");
                      setError(null);
                      setNotice(null);
                    }}
                    className="ml-auto rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
                  >
                    Remove
                  </button>
                )}
              </div>

              {removingId === f.id && (
                <div className="flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3">
                  <p className="text-xs text-ink-muted">
                    Enter a current code from this authenticator to confirm removal (re-auth
                    required).
                  </p>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    value={removeCode}
                    onChange={(e) => setRemoveCode(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="000000"
                    className={inputClass}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => confirmRemove(f.id)}
                      disabled={busy}
                      className="rounded-md bg-red-500/80 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-60"
                    >
                      {busy ? "Removing…" : "Confirm removal"}
                    </button>
                    <button
                      onClick={() => {
                        setRemovingId(null);
                        setRemoveCode("");
                        setError(null);
                      }}
                      disabled={busy}
                      className="rounded-md border border-charcoal-700 px-4 py-2 text-sm text-ink-muted hover:bg-charcoal-800 disabled:opacity-60"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        // ── No factor yet → offer enrollment ─────────────────────────────────
        <div>
          <button
            onClick={startEnroll}
            disabled={busy}
            className="rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
          >
            {busy ? "Starting…" : "Set up authenticator"}
          </button>
        </div>
      )}
    </div>
  );
}
