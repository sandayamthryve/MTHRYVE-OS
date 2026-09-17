"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { UserRole } from "@/types/database";
import { NavIcon, type IconName } from "@/components/ui/icons";
import { sidebarGroupsFor, type SidebarItem } from "@/lib/nav/sidebar";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SidebarNav({
  approvalsCount,
  role,
  department,
}: {
  approvalsCount: number;
  role?: UserRole;
  department?: string | null;
  userId?: string;
}) {
  const pathname = usePathname() ?? "/";

  // role and department were both accepted and then dropped on the floor. Who
  // sees what now lives in lib/nav/sidebar.ts, where a test can reach it.
  const groups = sidebarGroupsFor({ role, department });

  return (
    <nav aria-label="Operator navigation" className="flex h-full flex-col px-2 py-3">
      {groups.map((group, groupIndex) => (
        <div
          key={groupIndex}
          className={groupIndex === 0 ? "space-y-1" : "mt-3 space-y-1 border-t border-white/10 pt-3"}
        >
          {group.map((item) => {
            const childActive = item.children?.some((child) => isActive(pathname, child.href)) ?? false;
            const active = isActive(pathname, item.href) || childActive;
            const badge = item.badgeKey === "approvals" ? approvalsCount : 0;

            return (
              <div key={`${item.href}-${item.label}`}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors ${
                    active
                      ? "bg-emerald-400/15 text-emerald-300"
                      : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                  }`}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    <NavIcon name={item.icon} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {badge > 0 ? (
                    <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-xs text-emerald-300">
                      {badge}
                    </span>
                  ) : null}
                </Link>

                {item.children ? (
                  <div className="ml-8 mt-1 space-y-1 border-l border-white/10 pl-3">
                    {item.children.map((child) => {
                      const activeChild = isActive(pathname, child.href);
                      return (
                        <Link
                          key={`${child.href}-${child.label}`}
                          href={child.href}
                          aria-current={activeChild ? "page" : undefined}
                          className={`block rounded-md px-2 py-1.5 text-xs transition-colors ${
                            activeChild
                              ? "text-emerald-300"
                              : "text-slate-500 hover:bg-white/5 hover:text-slate-200"
                          }`}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
