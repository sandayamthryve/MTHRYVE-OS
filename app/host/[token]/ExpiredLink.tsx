// The clean "this link no longer works" screen for the PUBLIC contributor portal
// (/host/<token>). It renders for ANY token that doesn't resolve to an active
// contributor — unknown, malformed, expired or revoked — and deliberately never
// says which (see resolveContributorByToken, which collapses them all to null).
//
// This is a plain server component with NO auth call and NO client JS. It is the
// deliberate replacement for notFound()/redirect: a host who reloads a stale tab
// must land on a calm 200 page that tells them what to do next, never a 404 and
// never a bounce to /login (which shares the login rate limiter and would trap a
// reloading host behind the "Too many requests" wall).

export function ExpiredLink() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 px-4 py-12 text-center">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-teal-300 to-teal-500 text-lg font-bold text-charcoal-950 shadow-glow"
        >
          M
        </span>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-dim">
          Mthryve · Live Host
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <span
          aria-hidden
          className="flex h-14 w-14 items-center justify-center rounded-full border border-charcoal-700 bg-charcoal-900 text-2xl"
        >
          ⏳
        </span>
        <h1 className="text-xl font-bold text-ink">This link has expired</h1>
        <p className="max-w-xs text-sm text-ink-muted">
          Ask your team lead to reissue it. Your new link will open this page again —
          no login needed.
        </p>
      </div>

      <footer className="mt-2">
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
          © {new Date().getFullYear()} Mthryve Marketing Inc.
        </p>
      </footer>
    </main>
  );
}
