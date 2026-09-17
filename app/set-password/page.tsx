"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { reportAuthEvent } from "@/lib/security/report";
import { Card, PageHeader } from "@/components/ui";

// Shown after /auth/confirm verifies an invite or recovery link, when the user
// is already authenticated but needs to choose a password. Uses the shared UI
// primitives so it reads as the same design language as the rest of the app.
export default function SetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match. Try again.");
      return;
    }

    setIsSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setIsSubmitting(false);

    if (updateError) {
      setError("Couldn't set your password. The link may have expired — try again.");
      return;
    }

    // Record the password change on the audit trail (best-effort; the user is
    // authenticated here, so the server stamps their identity from the session).
    await reportAuthEvent("password_change");

    router.push("/home");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-charcoal-950 px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-400">
            Mthryve OS
          </p>
        </div>

        <Card>
          <PageHeader
            title="Set your password"
            subtitle="Choose a password to finish setting up your account."
          />

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm text-ink-muted"
              >
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-ink focus:border-teal-500"
              />
            </div>

            <div>
              <label
                htmlFor="confirm"
                className="mb-1.5 block text-sm text-ink-muted"
              >
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-ink focus:border-teal-500"
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-gold-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-teal-500 py-2 font-medium text-charcoal-950 transition-colors hover:bg-teal-400 disabled:opacity-60"
            >
              {isSubmitting ? "Saving…" : "Set password & continue"}
            </button>
          </form>
        </Card>
      </div>
    </main>
  );
}
