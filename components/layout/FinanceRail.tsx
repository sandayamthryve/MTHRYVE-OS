"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
// Shared with the reachability test: this href is not a module, so it needs a
// MODULE_CHILDREN rule to be openable — it shipped without one once.
import { FINANCE_DASHBOARD_HREF } from "@/lib/nav/rails";
import { RailIcon, type IconName } from "@/components/ui/icons";

type FinanceRailLink = readonly [href: string, label: string, iconName: IconName];

function activeHref(pathname: string, links: readonly FinanceRailLink[]): string {
  const matches = links
    .map(([href]) => href)
    .filter((href) => pathname === href || (href !== "/finance" && pathname.startsWith(`${href}/`)));

  return matches.sort((a, b) => b.length - a.length)[0] ?? links[0]?.[0] ?? "";
}

export function FinanceRail({ links }: { links: readonly FinanceRailLink[] }) {
  const pathname = usePathname() || "/finance";
  const railLinks: readonly FinanceRailLink[] = links.map((link, index) =>
    index === 0 ? [FINANCE_DASHBOARD_HREF, "Dashboard", link[2]] as const : link
  );
  const active = activeHref(pathname, railLinks);

  return (
    <>
      <aside className="pointer-events-auto absolute left-[18px] top-1/2 z-30 hidden -translate-y-1/2 flex-col items-center gap-[10px] rounded-full border border-[#1e2a35] bg-[#0d141b] px-[7px] py-3 shadow-[0_10px_30px_rgba(0,0,0,.45)] md:flex">
        {railLinks.map(([href, label, iconName]) => {
          const isActive = href === active;
          return (
            <Link key={href} href={href} aria-label={label} className={`group relative grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-sm transition hover:-translate-y-px hover:bg-[#111820] hover:text-[#e9f0f6] ${isActive ? "bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] text-[#04120c]" : "text-[#8b9aa8]"}`}>
              <RailIcon name={iconName} className={isActive ? "h-5 w-5 text-[#04120c]" : "h-5 w-5"} />
              <span aria-hidden className="pointer-events-none absolute left-full top-1/2 z-50 ml-[11px] -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-[10px] border border-[#1e2a35] bg-[#0d141b] px-[10px] py-[6px] text-[11.5px] font-bold leading-none text-[#e9f0f6] opacity-0 shadow-[0_10px_26px_rgba(0,0,0,.5)] transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">{label}</span>
            </Link>
          );
        })}
      </aside>

      <nav className="pointer-events-auto absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 overflow-x-auto rounded-full border border-[#1e2a35] bg-[#0d141b]/95 p-2 shadow-elevate backdrop-blur md:hidden">
        {railLinks.map(([href, label, iconName]) => {
          const isActive = href === active;
          return (
            <Link key={href} href={href} aria-label={label} title={label} className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${isActive ? "bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] text-[#04120c]" : "text-[#8b9aa8] hover:bg-[#111820] hover:text-[#2dd4bf]"}`}>
              <RailIcon name={iconName} />
            </Link>
          );
        })}
      </nav>
    </>
  );
}
