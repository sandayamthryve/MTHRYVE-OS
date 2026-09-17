import Link from "next/link";
import { SignOutButton } from "@/components/layout/SignOutButton";

// The honest dead-end /home renders when it has a VALID authenticated user but
// cannot resolve a profile to route them by role. It exists because /home must
// NEVER redirect to /login (that is the 307 loop that took production down): if
// dispatch can't complete, we show this instead of bouncing. A signed-in user
// with no reachable profile row is a real, if rare, state (provisioning lag, a
// deleted profile) — this tells the truth and gives a way forward rather than
// silently looping.
export function HomeUnavailable({ email }: { email?: string | null }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-charcoal-950 px-6">
      <div className="w-full max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-amber-400">
          Mthryve OS
        </p>
        <h1 className="mt-3 text-2xl font-bold text-ink">We couldn&rsquo;t open your home</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          You&rsquo;re signed in, but we couldn&rsquo;t load the profile that
          decides which cockpit to send you to. This is usually temporary. Try
          again in a moment — if it keeps happening, your account may still be
          finishing setup.
        </p>
        {email ? (
          <p className="mt-2 text-sm text-ink-muted">
            Signed in as <span className="text-ink">{email}</span>.
          </p>
        ) : null}
        <div className="mt-6 flex items-center justify-center gap-3">
          <Link
            href="/home"
            className="rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-charcoal-950 transition-colors hover:bg-teal-400"
          >
            Try again
          </Link>
          <SignOutButton />
        </div>
        <p className="mt-6 text-xs text-ink-muted">
          Still stuck? Reach out to your Department Head.
        </p>
      </div>
    </main>
  );
}
