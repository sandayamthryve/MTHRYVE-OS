"use client";

import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { usePathname } from "next/navigation";

// The Affiliate area's single sub-navigation — three sections under one module,
// reached from one nav entry point. A thin client island so the active tab
// highlights on the current route (the campaign detail page nests under
// Campaigns, so it keeps that tab lit).
const TABS: { href: string; label: string }[] = [
  { href: "/affiliate", label: "Campaigns" },
  { href: "/affiliate/engage", label: "Engage" },
  { href: "/affiliate/fulfillment", label: "Fulfillment" },
];

function active(pathname: string, href: string): boolean {
  if (href === "/affiliate") {
    // Campaigns owns the module root AND the campaign detail pages.
    return (
      pathname === "/affiliate" || pathname.startsWith("/affiliate/campaigns")
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AffiliateTabs() {
  const pathname = usePathname() ?? "/affiliate";
  return (
    <div className="mb-6 flex flex-wrap gap-1 border-b border-charcoal-700/60">
      {TABS.map((t) => {
        const on = active(pathname, t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              on
                ? "border-teal-400 text-teal-300"
                : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
