import type { Metadata } from "next";
import {
  resolveContributorByToken,
  fetchOpenAssignedTasks,
  portalModeForContributor,
} from "@/lib/contributors/tokens";
import { HostForms } from "./HostForms";
import { ExpiredLink } from "./ExpiredLink";

// PUBLIC contributor page — /host/<token>. No auth, no OS chrome (it renders
// OUTSIDE the (dashboard) AppShell and the middleware exempts /host). A host or
// intern opens their personal link on their phone and submits their day:
//   1. Selfie clock-in
//   2. Daily task note
//   3. Snap-to-Data — a photo of the live-results screen
//
// The page is WRITE-ONLY: it validates the token server-side to greet the right
// contributor, then hands off to the client forms, each of which POSTs to
// /api/host/<token> where the token is re-validated and the write is scoped to
// the contributor + brand DERIVED FROM THE TOKEN. It never reads back logs,
// metrics or anyone else's data.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live Host — Mthryve",
  robots: { index: false, follow: false },
};

export default async function HostTokenPage({
  params,
}: {
  params: { token: string };
}) {
  const contributor = await resolveContributorByToken(params.token);
  // Unknown / malformed / expired / revoked token → a clean 200 "expired link"
  // screen (never reveal which, and never notFound()/redirect to /login — a host
  // reloading a stale tab must not be bounced through the login rate limiter).
  if (!contributor) return <ExpiredLink />;

  // The capture the portal shows is chosen from the contributor's department
  // (kind is the fallback). Their OPEN assigned tasks are loaded read-only so they
  // can confirm them in today's log.
  const mode = portalModeForContributor(contributor);
  const tasks = await fetchOpenAssignedTasks(contributor);

  const kindLabel = contributor.kind === "intern" ? "Intern" : "Live Host";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-4 py-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-teal-300 to-teal-500 text-lg font-bold text-charcoal-950 shadow-glow"
          >
            M
          </span>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-dim">
              Mthryve · {kindLabel}
            </p>
            <h1 className="text-lg font-bold text-ink">Hi, {contributor.name}</h1>
          </div>
        </div>
        <p className="text-sm text-ink-muted">
          {contributor.department_name ? (
            <>Reporting to <span className="text-ink">{contributor.department_name}</span>. </>
          ) : contributor.brand_name ? (
            <>Submitting for <span className="text-ink">{contributor.brand_name}</span>. </>
          ) : null}
          Clock in with a selfie, confirm your tasks and log today's work
          {mode === "live" ? ", and snap your live results" : ""} — your team reviews
          everything before it counts.
        </p>
      </header>

      <HostForms token={params.token} mode={mode} tasks={tasks} />

      <footer className="mt-2 text-center">
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
          © {new Date().getFullYear()} Mthryve Marketing Inc.
        </p>
      </footer>
    </main>
  );
}
