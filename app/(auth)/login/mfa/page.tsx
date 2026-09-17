"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { reportMfaEvent } from "@/lib/security/report";

type RawFactor = { id: string; factor_type?: string; status?: string };

// The login step-up challenge. A user who has signed in with their password
// (session is aal1) but who carries a verified TOTP factor lands here — the
// middleware routes them in when MFA_ENFORCEMENT_ENABLED is on. They enter a
// current code to reach aal2, then continue to the app.
//
// It lives under /login (outside the dashboard shell) on purpose: an aal1 user
// hasn't fully "arrived" yet. Two escape hatches keep it from ever being a wall:
//   • Already aal2 (or no factor) → we send them straight on, no dead-end.
//   • A "Sign out" link, since a user who can't produce a code must still be able
//     to leave cleanly.
export default function MfaChallengePage() {
  const router = useRouter();
  const supabase = createClient();

  const [ready, setReady] = useState(false);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const goHome = useCallback(() => {
    router.replace("/home");
    router.refresh();
  }, [router]);

  // On mount: if the session is already stepped up, or there's no verified factor
  // to challenge, don't strand the user here — hand them back to the router.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (cancelled) return;
      if (aal?.currentLevel === "aal2") {
        goHome();
        return;
      }
      const { data } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      const verified = ((data?.all ?? []) as RawFactor[]).find(
        (f) => f.factor_type === "totp" && f.status === "verified"
      );
      if (!verified) {
        // No factor to challenge (e.g. it was removed elsewhere). Let the router
        // re-evaluate — a required user will be sent to enrollment, others home.
        goHome();
        return;
      }
      setFactorId(verified.id);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, goHome]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    const entered = code.trim();
    if (entered.length < 6) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setError(null);
    setBusy(true);
    const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: entered,
    });
    if (verifyErr) {
      setBusy(false);
      setError("That code didn't match. Check your authenticator app and try again.");
      return;
    }
    // Session is now aal2. Record it, then continue into the app.
    void reportMfaEvent("mfa_challenge_passed", { factorId });
    goHome();
  }

  async function handleSignOut() {
    setBusy(true);
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-charcoal-950 px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-400">Mthryve OS</p>
          <h1 className="mt-2 text-2xl font-bold text-ink">Two-factor verification</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Enter the 6-digit code from your authenticator app to finish signing in.
          </p>
        </div>

        {!ready ? (
          <p className="text-center text-sm text-ink-muted">Checking your account…</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="mfa-code" className="mb-1.5 block text-sm text-ink-muted">
                Authentication code
              </label>
              <input
                id="mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="000000"
                className="w-full rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-ink placeholder:tracking-normal placeholder:text-ink-muted focus:border-teal-500"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-gold-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-teal-500 py-2 font-medium text-charcoal-950 transition-colors hover:bg-teal-400 disabled:opacity-60"
            >
              {busy ? "Verifying…" : "Verify"}
            </button>
          </form>
        )}

        <div className="mt-6 text-center">
          <button
            onClick={handleSignOut}
            disabled={busy}
            className="text-xs text-ink-muted underline underline-offset-4 hover:text-ink disabled:opacity-60"
          >
            Sign out instead
          </button>
        </div>
      </div>
    </main>
  );
}
