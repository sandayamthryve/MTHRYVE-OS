"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { SidebarNav } from "@/components/layout/SidebarNav";
import type { UserRole } from "@/types/database";

// Mobile / tablet navigation: below the `lg` breakpoint the fixed desktop
// sidebar is hidden and this renders in its place — a hamburger button in the
// top bar that slides the same SidebarNav in from the left as an off-canvas
// drawer over a dimmed overlay. The drawer closes on overlay tap, on Escape,
// and automatically whenever the route changes (i.e. a nav item was chosen).
// At `lg+` the whole component is hidden (`lg:hidden`) and the real sidebar
// takes over, so the nav content stays a single source of truth (SidebarNav).
export function MobileNav({
  approvalsCount,
  role,
  department,
  userId,
}: {
  approvalsCount: number;
  role?: UserRole;
  department?: string | null;
  userId?: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close whenever the route changes — covers tapping any nav link (including
  // nested children). On first mount pathname is stable, so this is a no-op.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll + wire Escape while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      {/* Hamburger trigger — 44px touch target. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="mobile-nav-drawer"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-charcoal-800 hover:text-ink"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Dimmed overlay — tap to close. */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Off-canvas drawer — slides in from the left. */}
      <aside
        id="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-[17rem] max-w-[85vw] flex-col overflow-y-auto border-r border-charcoal-700/60 bg-charcoal-900 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-elevate transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-charcoal-700/60 px-4 py-4 pt-[max(env(safe-area-inset-top),1rem)]">
          <div className="flex items-center gap-3">
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
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation menu"
            className="flex h-10 w-10 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-charcoal-800 hover:text-ink"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <SidebarNav
          approvalsCount={approvalsCount}
          role={role}
          department={department}
          userId={userId}
        />
      </aside>
    </div>
  );
}
