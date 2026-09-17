import Link from "next/link";

// Public, no-auth chrome for the legal pages (/privacy, /terms). These routes
// are excluded from the auth middleware matcher, so this layout must stand on
// its own — it deliberately does NOT render AppShell (which requires a session).
// Kept intentionally light: a brand mark that links home, a max-width prose
// column, and a footer that cross-links the two policies.
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-obsidian">
      <header className="border-b border-charcoal-700/60 bg-charcoal-900/60">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-4">
          <Link href="/" className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-teal-300 to-teal-500 text-base font-bold text-charcoal-950 shadow-glow"
            >
              M
            </span>
            <span className="flex flex-col leading-tight">
              <span className="font-display text-sm font-bold tracking-tight text-ink">
                MTHRYVE OS
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-dim">
                Digital HQ
              </span>
            </span>
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 md:py-16">
        <article className="legal-prose">{children}</article>
      </main>

      <footer className="border-t border-charcoal-700/60 bg-charcoal-900/60">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-6 text-xs text-ink-dim sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Mthryve Marketing Inc. All rights reserved.</p>
          <nav className="flex items-center gap-4">
            <Link href="/privacy" className="transition-colors hover:text-ink-muted">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-ink-muted">
              Terms of Service
            </Link>
            <Link href="/" className="transition-colors hover:text-ink-muted">
              Back to app
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
