import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/layout/SignOutButton";
import {
  getSessionProfile,
  homeRouteFor,
  isProbationLapsed,
} from "@/lib/auth/session";

export const metadata = { title: "Access pending · Mthryve OS" };

// Where the session guard sends a probationary hire whose probation window has
// closed (see requireProfile). It never calls requireProfile itself — that
// would bounce right back here — so this is the one authenticated screen a
// suspended user can reach. Honest, no-jargon message + a way to sign out.
// Anyone who lands here without a lapsed probation (a stale link, an
// already-promoted user) is sent on to their normal home.
export default async function AccessPendingPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (!isProbationLapsed(profile)) redirect(homeRouteFor(profile));

  return (
    <main className="flex min-h-screen items-center justify-center bg-charcoal-950 px-6">
      <div className="w-full max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-amber-400">
          Mthryve OS
        </p>
        <h1 className="mt-3 text-2xl font-bold text-ink">Access pending confirmation</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          Your probation period has ended and your access is paused while
          leadership confirms your permanent status. This is expected — nothing
          has gone wrong. You&rsquo;ll be back in as soon as a department head or
          leadership makes it official.
        </p>
        <p className="mt-2 text-sm text-ink-muted">
          Signed in as <span className="text-ink">{profile.full_name}</span>.
        </p>
        <div className="mt-6 flex justify-center">
          <SignOutButton />
        </div>
        <p className="mt-6 text-xs text-ink-muted">
          Think this is a mistake? Reach out to your Department Head.
        </p>
      </div>
    </main>
  );
}
