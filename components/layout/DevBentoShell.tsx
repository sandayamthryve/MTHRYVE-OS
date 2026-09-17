"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { modulesForRole, workspaceHome } from "@/lib/auth/module-access";
import { ModuleAccessProvider } from "./ModuleAccessProvider";
import type { SessionProfile } from "@/lib/auth/session";
import { DevRoleSwitcher } from "@/components/layout/DevRoleSwitcher";
import { DevGlobalSearch } from "@/components/layout/DevGlobalSearch";
import { DevZoomDock } from "@/components/layout/DevZoomDock";
import { DevProfileMenu } from "@/components/layout/DevProfileMenu";
import { DevDashboardMetricSwitcher } from "@/components/home/DevDashboardMetricSwitcher";
import { DevRangePickerInteractionFix } from "@/components/home/DevRangePickerInteractionFix";
import { DevCustomDateCalendar } from "@/components/home/DevCustomDateCalendar";
import { RailIcon } from "@/components/ui/icons";
import {
  moduleRailIcon,
  RAIL_GROUPS,
  RAIL_LINKS,
  type OrderedRailEntry,
} from "@/lib/nav/rails";
import { FinanceRail } from "./FinanceRail";
import { HrRailItems } from "./HrRailItems";

const SYSTEM_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
const NAV_BUFFER_MS = 550;

export function DevBentoShell({ profile, breadcrumb, children }: { profile?: SessionProfile; breadcrumb: string[]; children: React.ReactNode; }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loadingTarget, setLoadingTarget] = useState<string | null>(null);
  const role = profile?.preview_role ?? "operator";
  const home = workspaceHome(role);
  const seen = new Set<string>();
  const links = role === "operator" ? RAIL_LINKS : [[home, "Workspace", "command"] as const, ...modulesForRole(role).filter((module) => { if (seen.has(module.href)) return false; seen.add(module.href); return true; }).map((module) => [module.href, module.label, moduleRailIcon(module.href)] as const)];
  const context = breadcrumb.at(-1) ?? "Home";
  const operatorActive = (href: string) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  useEffect(() => {
    setLoadingTarget(null);
  }, [pathname]);

  const bufferedNavigate = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || href === pathname || loadingTarget) return;
    event.preventDefault();
    setLoadingTarget(href);
    window.setTimeout(() => router.push(href), NAV_BUFFER_MS);
  };

  const railLink = (href: string, label: string, iconName: Parameters<typeof RailIcon>[0]["name"], active = false) => (
    <Link key={`${href}-${label}`} href={href} onClick={(event) => bufferedNavigate(event, href)} aria-label={label} className={`group relative grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-sm transition hover:-translate-y-px hover:bg-[#111820] hover:text-[#e9f0f6] ${active ? "bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] text-[#04120c]" : "text-[#8b9aa8]"}`}>
      <RailIcon name={iconName} className={active ? "h-5 w-5 text-[#04120c]" : "h-5 w-5"} />
      <span aria-hidden className="pointer-events-none absolute left-full top-1/2 z-50 ml-[11px] -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-[10px] border border-[#1e2a35] bg-[#0d141b] px-[10px] py-[6px] text-[11.5px] font-bold leading-none text-[#e9f0f6] opacity-0 shadow-[0_10px_26px_rgba(0,0,0,.5)] transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">{label}</span>
    </Link>
  );

  return (
    <ModuleAccessProvider role={role}>
      <div className="min-h-screen bg-[#080c11] text-[#e9f0f6]" style={{ fontFamily: SYSTEM_FONT }}>
        {loadingTarget && <div className="fixed inset-0 z-[99999] grid place-items-center bg-[#080b11]/95 backdrop-blur-sm" role="status" aria-live="polite"><div className="flex flex-col items-center gap-5"><div className="relative h-14 w-14"><div className="absolute inset-0 rounded-full border-2 border-white/10" /><div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-r-[#2dd4bf]/40 border-t-[#2dd4bf]" /><div className="absolute inset-[7px] animate-pulse rounded-full bg-white/[0.04]" /></div><div className="text-center"><p className="text-xs font-bold uppercase tracking-[.28em] text-white/80">M-THRYVE OS</p><p className="mt-2 text-[11px] tracking-[.14em] text-white/40">Loading {loadingTarget === "/" ? "dashboard" : loadingTarget.replaceAll("/", " ").trim()}...</p></div><div className="h-px w-28 overflow-hidden bg-white/10"><div className="h-full w-1/2 animate-[dev-loading-bar_.7s_ease-in-out_infinite] bg-[#2dd4bf]" /></div></div><style>{`@keyframes dev-loading-bar{0%{transform:translateX(-110%)}50%{transform:translateX(55%)}100%{transform:translateX(220%)}}`}</style></div>}
        <div id="dev-os-viewport" className="relative"><div id="dev-os-stage" className="relative w-[1440px] origin-top-left bg-[#080c11]"><main className="h-full pb-8 pl-[84px] pr-5 pt-[88px]">{children}</main>{role === "operator" && <><DevDashboardMetricSwitcher /><DevRangePickerInteractionFix /><DevCustomDateCalendar /></>}</div></div>
        <div id="dev-os-chrome" className="pointer-events-none fixed left-0 top-0 z-50 w-[1440px] origin-top-left">
          <header className="pointer-events-auto absolute inset-x-[18px] top-[10px] z-40 flex h-[58px] items-center rounded-[28px] border border-[#1e2a35] bg-[#0d141b]/[.94] py-2 pl-4 pr-3 shadow-[0_10px_30px_rgba(0,0,0,.28),inset_0_1px_0_rgba(255,255,255,.035)] backdrop-blur-[16px]">
            <div className="flex min-w-0 shrink-0 items-center gap-[10px]"><Link href={home} onClick={(event) => bufferedNavigate(event, home)} aria-label="M-THRYVE OS home" className="grid h-[42px] w-[48px] shrink-0 place-items-center rounded-full text-[16px] font-black text-[#2dd4bf] transition hover:scale-[1.045] hover:brightness-110">M</Link><div className="hidden min-w-0 items-center whitespace-nowrap text-[14px] font-extrabold tracking-[.2px] sm:flex"><Link href={home} onClick={(event) => bufferedNavigate(event, home)} className="text-[#e9f0f6] transition hover:text-[#2dd4bf]">M-THRYVE OS</Link><span className="mx-[7px] font-semibold text-[#8b9aa8]">›</span><span className="font-bold text-[#8b9aa8]">{context}</span></div></div>
            <DevGlobalSearch role={role} /><div className="ml-auto flex items-center gap-3"><DevRoleSwitcher activeRoleId={role} /><DevProfileMenu profile={profile} /></div>
          </header>
          {role === "hr" ? <><aside className="pointer-events-auto absolute left-[18px] top-1/2 z-30 hidden -translate-y-1/2 flex-col items-center gap-[10px] rounded-full border border-[#1e2a35] bg-[#0d141b] px-[7px] py-3 shadow-[0_10px_30px_rgba(0,0,0,.45)] md:flex"><HrRailItems pathname={pathname ?? "/"} onNavigate={bufferedNavigate} /></aside><nav className="pointer-events-auto absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 overflow-x-auto rounded-full border border-[#1e2a35] bg-[#0d141b]/95 p-2 shadow-elevate backdrop-blur md:hidden"><HrRailItems pathname={pathname ?? "/"} onNavigate={bufferedNavigate} /></nav></> : role === "finance" ? <FinanceRail links={links} /> : role === "operator" ? <><aside className="pointer-events-auto absolute left-[18px] top-1/2 z-30 hidden -translate-y-1/2 flex-col items-center rounded-full border border-[#1e2a35] bg-[#0d141b] px-[7px] py-3 shadow-[0_10px_30px_rgba(0,0,0,.45)] md:flex">{RAIL_GROUPS.map((group, groupIndex) => <div key={groupIndex} className="flex flex-col items-center">{groupIndex > 0 && <div className="my-[7px] h-px w-[20px] bg-[#263441]" />}<div className="flex flex-col items-center gap-[7px]">{group.map(([href,label,iconName]) => railLink(href,label,iconName,operatorActive(href)))}</div></div>)}</aside><nav className="pointer-events-auto absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 overflow-x-auto rounded-full border border-[#1e2a35] bg-[#0d141b]/95 p-2 shadow-elevate backdrop-blur md:hidden">{RAIL_LINKS.map(([href,label,iconName]) => railLink(href,label,iconName,operatorActive(href)))}</nav></> : <><aside className="pointer-events-auto absolute left-[18px] top-1/2 z-30 hidden -translate-y-1/2 flex-col items-center gap-[10px] rounded-full border border-[#1e2a35] bg-[#0d141b] px-[7px] py-3 shadow-[0_10px_30px_rgba(0,0,0,.45)] md:flex">{links.map(([href,label,iconName],index) => railLink(href,label,iconName,index===0))}</aside><nav className="pointer-events-auto absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 overflow-x-auto rounded-full border border-[#1e2a35] bg-[#0d141b]/95 p-2 shadow-elevate backdrop-blur md:hidden">{links.map(([href,label,iconName]) => railLink(href,label,iconName))}</nav></>}
        </div><DevZoomDock />
      </div>
    </ModuleAccessProvider>
  );
}
