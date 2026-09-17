"use client";

import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { usePathname } from "next/navigation";

// The Live Operations sub-navigation. A thin client island so the active tab
// highlights on the current route. Order mirrors the module's parts:
// Dashboard (B) · Daily Reports (C) · Bottlenecks (D) · Campaigns (E) ·
// Schedule (F).
const TABS: { href: string; label: string }[] = [
  { href: "/live-ops", label: "Live Performance" },
  { href: "/live-ops/reports", label: "Daily Reports" },
  { href: "/live-ops/bottlenecks", label: "Bottlenecks" },
  { href: "/live-ops/campaigns", label: "Campaigns" },
  { href: "/live-ops/schedule", label: "Schedule & HR" },
];

function active(pathname: string, href: string): boolean {
  if (href === "/live-ops") return pathname === "/live-ops";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function LiveOpsTabs() {
  const pathname = usePathname() ?? "/live-ops";
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
