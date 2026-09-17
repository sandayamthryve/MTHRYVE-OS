"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { RailIcon } from "@/components/ui/icons";
import { HrRailItems } from "@/components/layout/HrRailItems";
import type { WorkspaceRole } from "@/lib/auth/module-access";

const RAIL_LINKS = [
  ["/", "Command center", "command"] as const,
  ["/tasks", "Tasks", "tasks"] as const,
  ["/people", "People", "people"] as const,
  ["/tony", "Tony", "ai"] as const,
  ["/metrics", "Metrics", "metrics"] as const,
  ["/daily-tap", "Daily Tap", "dailytap"] as const,
  ["/updates", "Updates", "updates"] as const,
  ["/warehouse/overview", "Warehouse", "warehouse"] as const,
  ["/creative-studio", "Creative", "creative"] as const,
  ["/reports", "Reports", "reports"] as const,
] as const;

/**
 * Tony keeps its immersive full-screen cognition view, but exposes a compact
 * navigation rail floating above the canvas rather than shrinking Tony.
 *
 * HR gets ITS rail here, not this one. RAIL_LINKS below is a hardcoded
 * operator list, and more than half of it — tasks, metrics, daily tap, updates,
 * warehouse, creative — is refused outright for HR, so opening Tony used to
 * swap a working navigation for one that mostly leads to /access-denied. Only
 * HR is special-cased: every other role keeps the list it had.
 */
export function TonySideRail({ role }: { role?: WorkspaceRole }) {
  const pathname = usePathname();

  if (role === "hr") {
    return (
      <aside
        aria-label="MThryve navigation"
        className="fixed left-[24px] top-1/2 z-[120] hidden -translate-y-1/2 flex-col items-center gap-[10px] rounded-full border border-[#1e2a35] bg-[#0d141b]/95 px-[8px] py-[14px] shadow-[0_14px_38px_rgba(0,0,0,.55)] backdrop-blur-[16px] md:flex"
      >
        <HrRailItems pathname={pathname ?? "/tony"} size={34} />
      </aside>
    );
  }

  return (
    <aside
      aria-label="MThryve navigation"
      className="fixed left-[24px] top-1/2 z-[120] hidden -translate-y-1/2 flex-col items-center gap-[10px] rounded-full border border-[#1e2a35] bg-[#0d141b]/95 px-[8px] py-[14px] shadow-[0_14px_38px_rgba(0,0,0,.55)] backdrop-blur-[16px] md:flex"
    >
      {RAIL_LINKS.map(([href, label, iconName]) => {
        const isActive = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

        return (
          <Link
            key={href}
            href={href}
            title={label}
            aria-label={label}
            className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full text-sm transition duration-150 hover:-translate-y-px hover:bg-[#111820] hover:text-[#e9f0f6] ${
              isActive
                ? "bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] text-[#04120c] shadow-[0_0_18px_rgba(45,212,191,.22)]"
                : "text-[#8b9aa8]"
            }`}
          >
            <RailIcon
              name={iconName}
              className={isActive ? "h-5 w-5 text-[#04120c]" : "h-5 w-5"}
            />
          </Link>
        );
      })}
    </aside>
  );
}
