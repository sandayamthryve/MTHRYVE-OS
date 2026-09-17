"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { RailIcon } from "@/components/ui/icons";
import { HR_RAIL } from "@/lib/nav/rails";

// HR's hand-ordered rail, as ITEMS two different shells can render.
//
// DevBentoShell draws it inside the docked rail; Tony draws it floating over
// its full-screen canvas. Before this, only DevBentoShell knew how — so /tony
// fell back to a hardcoded operator list, and HR opening Tony lost its own
// navigation and got one where half the destinations (tasks, metrics, daily
// tap, updates, warehouse, creative) refuse HR outright.
//
// One implementation, because the dimming rules are the interesting part: an
// entry HR cannot open keeps its place in the order and explains itself rather
// than linking anywhere. Two copies of that would drift.

/**
 * The entry a path belongs to, longest match first.
 *
 * /people/review-gate must highlight the Review Gate, not Team Workspace —
 * which is also a prefix of it.
 */
export function hrActiveHref(pathname: string): string | null {
  return (
    HR_RAIL.map(([href]) => href)
      .filter((href): href is string => !!href && (pathname === href || pathname.startsWith(`${href}/`)))
      .sort((left, right) => right.length - left.length)[0] ?? null
  );
}

const TIP_CLS =
  "pointer-events-none absolute left-full top-1/2 z-50 ml-[11px] -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-[10px] border border-[#1e2a35] bg-[#0d141b] px-[10px] py-[6px] text-[11.5px] font-bold leading-none text-[#e9f0f6] opacity-0 shadow-[0_10px_26px_rgba(0,0,0,.5)] transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100";

export function HrRailItems({
  pathname,
  onNavigate,
  size = 30,
}: {
  pathname: string;
  /** The shell's buffered navigation, where it has one. */
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
  /** 30 in the docked rail, 34 floating over Tony. */
  size?: 30 | 34;
}) {
  const active = hrActiveHref(pathname);
  const box = size === 34 ? "h-[34px] w-[34px]" : "h-[30px] w-[30px]";

  return (
    <>
      {HR_RAIL.map(([href, label, iconName, reason]) => {
        // Not reachable: show it, but do not pretend it goes anywhere.
        if (!href) {
          return (
            <span
              key={label}
              aria-label={`${label} (${reason ?? "unavailable"})`}
              aria-disabled="true"
              className={`group relative grid ${box} shrink-0 cursor-not-allowed place-items-center rounded-full text-sm text-[#8b9aa8] opacity-30`}
            >
              <RailIcon name={iconName} className="h-5 w-5" />
              <span aria-hidden className={TIP_CLS}>
                {label} — {reason ?? "unavailable"}
              </span>
            </span>
          );
        }

        const isActive = href === active;
        return (
          <Link
            key={`${href}-${label}`}
            href={href}
            onClick={onNavigate ? (event) => onNavigate(event, href) : undefined}
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            className={`group relative grid ${box} shrink-0 place-items-center rounded-full text-sm transition hover:-translate-y-px hover:bg-[#111820] hover:text-[#e9f0f6] ${
              isActive
                ? "bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] text-[#04120c]"
                : "text-[#8b9aa8]"
            }`}
          >
            <RailIcon name={iconName} className={isActive ? "h-5 w-5 text-[#04120c]" : "h-5 w-5"} />
            <span aria-hidden className={TIP_CLS}>
              {label}
            </span>
          </Link>
        );
      })}
    </>
  );
}
