import Link from "next/link";
import { SignOutButton } from "@/components/layout/SignOutButton";
import { SidebarNav } from "@/components/layout/SidebarNav";
import { MobileNav } from "@/components/layout/MobileNav";
import { TapNudge } from "@/components/daily-tap/TapNudge";
import { Tooltip } from "@/components/ui/Tooltip";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { unreadNotificationCount } from "@/lib/notifications/read";
import type { SessionProfile } from "@/lib/auth/session";
import { isDevChannelAuthBypassEnabled } from "@/lib/auth/dev-channel";
import { DevBentoShell } from "@/components/layout/DevBentoShell";
// Present on every authenticated page per PROJECT.md UI principles.
// v3 "Executive": a fixed left sidebar + sticky top bar replace the old
// top-nav dropdowns, matching the approved executive-dashboard mockup. The
// optional workspace mode lets dense operational pages contain their own
// scrolling while preserving the existing global chrome.
const ROLE_LABELS: Record<SessionProfile["role"], string> = {
  ceo: "CEO",
  coo: "COO",
  department_head: "Department Head",
  team_member: "Team Member",
};
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

// Time-of-day greeting, evaluated in the company's timezone (Asia/Manila) so it
// reads correctly regardless of where the server renders.
function greetingFor(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function manilaDate(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

// Fetch the count of pending approvals for the nav badge — the total awaiting a
// human decision across BOTH queues: the Action & Approval Queue (action_requests,
// the AI/human safety spine) and the older AI-platform / task proposals
// (approval_requests). RLS scopes each to the caller's org; the explicit org
// filter keeps intent obvious. Either count failing degrades to 0, never throws.
async function pendingApprovalsCount(orgId: string): Promise<number> {
  // action_requests isn't in the generated Database types yet, so this reads
  // through the same cast shim the Live/Contracts modules use.
  const db = createServerSupabaseClient() as unknown as { from: (t: string) => any };
  const countPending = async (table: string): Promise<number> => {
    try {
      const { count } = await db
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", "pending");
      return count ?? 0;
    } catch {
      return 0;
    }
  };
  const [actions, legacy] = await Promise.all([
    countPending("action_requests"),
    countPending("approval_requests"),
  ]);
  return actions + legacy;
}

export async function AppShell({
  breadcrumb,
  profile,
  children,
  workspace = false,
}: {
  breadcrumb: string[];
  profile?: SessionProfile;
  children: React.ReactNode;
  workspace?: boolean;
}) {
  const devChannelBypass = isDevChannelAuthBypassEnabled();
  const [approvalsCount, unreadCount] = profile && !devChannelBypass
    ? await Promise.all([
        pendingApprovalsCount(profile.org_id),
        unreadNotificationCount(
          createServerSupabaseClient() as unknown as { from: (t: string) => any },
          profile.id
        ),
      ])
    : [0, 0];
  const firstName = profile ? profile.full_name.split(/\s+/)[0] : "";
  const context = breadcrumb.length ? breadcrumb[breadcrumb.length - 1] : null;

  if (devChannelBypass) {
    return (
      <DevBentoShell profile={profile} breadcrumb={breadcrumb}>
        {workspace ? (
          <div className="h-[calc(100dvh-120px)] min-h-0 overflow-hidden">
            <style>{`.metrics-workspace{height:100%!important;min-height:0!important}`}</style>
            {children}
          </div>
        ) : (
          children
        )}
      </DevBentoShell>
    );
  }

  return (
    <div className={workspace ? "h-screen overflow-hidden bg-obsidian" : "min-h-screen bg-obsidian"}>
      {/* Fixed left sidebar — full height, own scroll, ~240px. Shown at lg+;
          below that it collapses into the MobileNav off-canvas drawer. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col overflow-y-auto border-r border-charcoal-700/60 bg-charcoal-900 pl-[env(safe-area-inset-left)] lg:flex">
        <div className="flex items-center gap-3 border-b border-charcoal-700/60 px-4 py-4">
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
        </div>
        <SidebarNav
          approvalsCount={approvalsCount}
          role={profile?.role}
          department={profile?.department_name}
          userId={profile?.id}
        />
      </aside>

      {/* Main column, offset by the sidebar width on desktop. */}
      <div className={workspace ? "flex h-screen min-h-0 flex-col lg:pl-60" : "flex min-h-screen flex-col lg:pl-60"}>
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-charcoal-700/60 bg-charcoal-900 px-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 sm:gap-4 sm:px-4 md:px-6">
          {/* Hamburger + compact brand mark below lg, where the sidebar is
              hidden and the nav lives in the off-canvas drawer. */}
          <MobileNav
            approvalsCount={approvalsCount}
            role={profile?.role}
            department={profile?.department_name}
            userId={profile?.id}
          />
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-300 to-teal-500 text-sm font-bold text-charcoal-950 lg:hidden"
          >
            M
          </span>

          {/* Left: time-based greeting + date/company line + page context. */}
          <div className="min-w-0 shrink-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold text-ink sm:text-base">
                {profile ? `Good ${greetingFor()}, ${firstName}` : "Mthryve OS"}
              </h1>
              {context && (
                <span className="hidden shrink-0 rounded-md border border-charcoal-700/60 bg-charcoal-850 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted lg:inline">
                  {context}
                </span>
              )}
            </div>
            <p className="hidden truncate text-xs text-ink-dim sm:block">
              {manilaDate()} · Mthryve Marketing Inc.
            </p>
          </div>

          {/* Center: Deep Search. */}
          <Link
            href="/search"
            className="group ml-auto hidden min-w-0 flex-1 items-center gap-2 rounded-lg border border-charcoal-700/60 bg-charcoal-850 px-3 py-2 text-sm text-ink-dim transition-colors hover:border-charcoal-700 hover:text-ink-muted lg:ml-6 lg:flex lg:max-w-md"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="shrink-0"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <span className="truncate">Deep Search — brands, orders, creators, docs…</span>
            <kbd className="ml-auto hidden shrink-0 rounded border border-charcoal-700 bg-charcoal-900 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim lg:inline">
              ⌘K
            </kbd>
          </Link>

          {/* Right: assistant CTA, notifications, avatar, sign out. */}
          <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0 lg:gap-3">
            <Tooltip content="Search" position="bottom" delay={150}>
              <Link
                href="/search"
                aria-label="Search"
                className="rounded-md p-2 text-ink-muted transition-colors hover:bg-charcoal-800 hover:text-ink lg:hidden"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
              </Link>
            </Tooltip>

            <Link
              href="/assistant"
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-b from-green-400 to-green-500 px-3 py-2 text-sm font-medium text-charcoal-950 shadow-glow transition hover:brightness-110"
            >
              <span aria-hidden>✦</span>
              <span className="hidden sm:inline">Ask Mthryve AI</span>
            </Link>

            <Tooltip
              content={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
              position="bottom"
              delay={150}
            >
              <Link
                href="/notifications"
                aria-label={
                  unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"
                }
                className="relative rounded-md p-2 text-ink-muted transition-colors hover:bg-charcoal-800 hover:text-ink"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.5 21a1.7 1.7 0 0 1-3 0" />
                </svg>
                {/* Unread badge — a real count, not a decorative dot. Hidden at 0. */}
                {unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 font-mono text-[9px] font-semibold text-white ring-2 ring-charcoal-900">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </Link>
            </Tooltip>

            {profile && (
              <div className="flex shrink-0 items-center gap-3 border-l border-charcoal-700/60 pl-2 md:pl-3">
                <span
                  aria-hidden
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-500/15 text-xs font-medium text-teal-400 ring-1 ring-teal-500/40"
                >
                  {initials(profile.full_name)}
                </span>
                <div className="hidden text-left lg:block">
                  <p className="text-sm leading-tight text-ink">{profile.full_name}</p>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                    {ROLE_LABELS[profile.role]}
                  </p>
                </div>
                <SignOutButton devMode={devChannelBypass} />
              </div>
            )}
          </div>
        </header>

        <main
          className={
            workspace
              ? "min-h-0 flex-1 overflow-hidden px-4 py-3 pl-[max(env(safe-area-inset-left),1rem)] pr-[max(env(safe-area-inset-right),1rem)] md:px-6"
              : "flex-1 px-4 py-6 pl-[max(env(safe-area-inset-left),1rem)] pr-[max(env(safe-area-inset-right),1rem)] md:px-6"
          }
        >
          {workspace && <style>{`.metrics-workspace{height:100%!important;min-height:0!important}`}</style>}
          {children}
        </main>

        {/* App footer — present on every authenticated page. Links the public
            legal pages (rendered outside this shell) so they're reachable
            from anywhere in the app. */}
        <footer className="border-t border-charcoal-700/60 px-4 py-5 md:px-6">
          <div className="flex flex-col gap-2 text-xs text-ink-dim sm:flex-row sm:items-center sm:justify-between">
            <p>© {new Date().getFullYear()} Mthryve Marketing Inc.</p>
            <nav className="flex items-center gap-4">
              <Link href="/privacy" className="transition-colors hover:text-ink-muted">
                Privacy Policy
              </Link>
              <Link href="/terms" className="transition-colors hover:text-ink-muted">
                Terms of Service
              </Link>
            </nav>
          </div>
        </footer>
      </div>

      {/* In-app Daily Tap snooze nudge — polls after login, re-shows today's
          unacted tap up to 3× (server-governed cadence), never re-emails. Only
          for signed-in users. */}
      {profile && <TapNudge />}
    </div>
  );
}
