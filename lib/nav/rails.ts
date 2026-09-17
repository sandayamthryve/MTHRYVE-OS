import type { IconName } from "@/components/ui/icons";

// The navigation rails, as DATA.
//
// These used to live inside DevBentoShell, which is a "use client" component —
// so nothing could import them without pulling React and the router in, and the
// only way to check them was to copy the hrefs into a test by hand. That copy
// is what let two dead icons ship on 2026-09-17: a destination was rendered
// that nothing granted, and the list the test checked did not know about it.
//
// Keeping them here, free of React, means the reachability test imports the
// same array the shell renders. A new entry is covered the moment it is added,
// not when someone remembers to mirror it.
//
// The type import above is erased at build time, so this module stays plain
// data at runtime.

/** An operator rail entry: href, label, icon. */
export type RailEntry = readonly [string, string, IconName];

/**
 * A hand-ordered rail entry, which may name a destination that cannot be
 * opened. A null href renders dimmed with `reason` rather than as a link —
 * an icon that explains itself beats one that bounces you to /access-denied.
 *
 * The icon is an IconName, not an emoji. HR used emoji glyphs while every
 * other rail drew the same stroked SVG set, so one role rendered in the
 * system emoji font — full-colour, differently sized per platform, and
 * unable to take the active pill's dark ink. Typing this as IconName is what
 * stops an emoji going back in: a string literal that is not in ICONS fails
 * the build.
 */
export type OrderedRailEntry = readonly [
  href: string | null,
  label: string,
  icon: IconName,
  reason?: string,
];

// ── Operator ────────────────────────────────────────────────────────────────
// Grouped, and the groups are the dividers drawn between them.
export const RAIL_GROUPS: readonly (readonly RailEntry[])[] = [
  [
    ["/", "Dashboard (Command Center)", "command"],
    ["/home/dept", "Dept Cockpit", "departments"],
    ["/reports", "Reports", "reports"],
    ["/home/operations", "Operations", "commerce"],
  ],
  [
    // "My Workspace" (/employee) is every signed-in person's own page and was
    // reachable from nothing — AppShell swaps SidebarNav for the shell on the
    // devchannel, so linking it in the sidebar alone never surfaced it here.
    ["/employee", "My Workspace", "people"],
    ["/tasks", "Tasks", "tasks"],
    ["/approvals", "Approvals", "approvals"],
    ["/metrics", "Metrics", "metrics"],
    // Same omission as /employee above: the page was built and linked from
    // nowhere. Operator only — it guards on requireRole(ceo/coo/department_head)
    // and the operator preview carries ceo, so this rail can open it. It is NOT
    // added to any department rail: those scopes are team_member and would be
    // refused, which is the /ceo mistake the HR rail already records.
    ["/performance", "Performance", "leaderboard"],
  ],
  [
    ["/tony", "Tony", "ai"],
    ["/copilots", "Copilot", "ai"],
    ["/council", "Council", "people"],
    ["/csi", "CSI", "metrics"],
    ["/automation-radar", "Automation", "dailytap"],
  ],
  [
    ["/reports", "Report", "reports"],
    ["/settings", "Settings", "settings"],
  ],
];

export const RAIL_LINKS: readonly RailEntry[] = RAIL_GROUPS.flat();

// ── Human Resources ─────────────────────────────────────────────────────────
// Hand-ordered rather than derived from its module list, because the order is
// the point: the Review Gate is what the role opens on (see workspaceHome) and
// the rest hangs off it. modulesForRole would give module order instead.
//
// A null href is a destination HR cannot open, for one of two reasons, and only
// one of them is fixable from the nav:
//   - no route: Architecture and Evolution Path have no page yet.
//   - not permitted: /ceo calls requireRole(["ceo","coo"]). HR carries
//     department_head (PREVIEW_ACCOUNT_ROLES), which that page does not accept,
//     so it redirects HR away whatever the module table grants. Opening it means
//     changing that page's own guard. /home/dept accepts department_head, so it
//     is a link.
//
// Icons are chosen for the SHAPE they draw, not the name they carry — several
// names in ICONS share one path (clients/people/partners/recruitment are the
// same group-of-people glyph, leads and approvals the same ringed check). Two
// entries a rail apart that draw identically are worse than a name that reads
// oddly in source, so Team Workspace takes the checkbox (it is a task and
// report queue) and leaves the people glyph to Client Portal, and Architecture
// takes the cube from `warehouse` because nothing else in the set draws
// structure.
export const HR_RAIL: readonly OrderedRailEntry[] = [
  ["/reviewgate", "Review Gate", "approvals"],
  ["/team-workspace", "Team Workspace", "tasks"],
  ["/tony", "Tony · Copilot", "ai"],
  ["/home/dept", "Department Cockpits", "departments"],
  [null, "Executive Review", "metrics", "CEO/COO only"],
  ["/clients", "Client Portal", "clients"],
  ["/knowledge", "Records & Knowledge", "knowledge"],
  [null, "Architecture", "warehouse", "coming soon"],
  [null, "Evolution Path", "leaderboard", "coming soon"],
];

// ── Every other role ────────────────────────────────────────────────────────
// A per-module icon, for every module in the matrix.
//
// This used to be a Finance-only map, and the shell fell back to "tasks" for
// everyone else — so Warehouse, E-Commerce, Creative, Customer Service, Live
// and Affiliate each rendered a rail of IDENTICAL checkboxes. Six roles where
// the icons carried no information and the only way to tell one destination
// from another was to hover for the tooltip.
//
// Icons are chosen for the SHAPE they draw, not the name they carry — several
// names in ICONS share one path (clients/people/partners/recruitment are one
// group-of-people glyph; leads and approvals one ringed check; live/experience/
// updates one camera). What matters is that no two entries in the SAME rail
// draw the same thing, which is what the test below enforces.
export const MODULE_RAIL_ICONS: Record<string, IconName> = {
  // E-Commerce
  "/campaigns": "campaigns",
  "/tiktok-orders": "commerce",
  "/ad-ops": "metrics",
  "/commerce-ops": "reports",
  "/brands": "clients",
  "/analytics/ecommerce": "intel",
  // Creative
  "/creative-studio": "creative",
  "/studio/vesper": "live",
  "/content-calendar": "attendance",
  "/analytics/creatives": "intel",
  // Warehouse & Fulfilment
  "/warehouse/overview": "warehouse",
  "/warehouse/intelligence": "intel",
  "/warehouse/products": "quickentry",
  "/warehouse/stock": "metrics",
  "/warehouse/rts": "commerce",
  "/warehouse/cases": "approvals",
  "/analytics/warehouse": "leaderboard",
  // Live
  "/live-wall": "departments",
  "/live": "live",
  "/live-ops": "settings",
  "/analytics/live_ops": "intel",
  "/live-ops/attendance": "attendance",
  // Affiliate
  "/affiliate": "campaigns",
  "/creators": "creative",
  "/leads": "leads",
  "/outreach": "clients",
  "/contracts": "quickentry",
  "/analytics/affiliate": "intel",
  // Finance. Audit takes the magnifier and Categories the book so that neither
  // collides with Expense Records (document) or Expense Approvals (ringed
  // check) — before the per-rail uniqueness test, this rail drew the document
  // twice and the ringed check twice.
  "/finance": "finance",
  "/finance/expenses": "commerce",
  "/finance/expenses/records": "reports",
  "/finance/expenses/budgets": "metrics",
  "/finance/expenses/audit": "intel",
  "/finance/expenses/vendors": "people",
  "/finance/expenses/categories": "knowledge",
  "/finance/expenses/approvals": "approvals",
  "/payroll": "payroll",
  // HR's own modules. HR renders HR_RAIL above rather than this map, but the
  // modules exist and the coverage test walks every one of them.
  "/leaderboard": "leaderboard",
  "/people": "people",
  "/reviewgate": "approvals",
  "/people/probation": "attendance",
  "/attendance": "attendance",
  "/recruitment": "recruitment",
  "/live-ops/moderation": "approvals",
  "/knowledge": "knowledge",
  "/tony": "ai",
  "/home/dept": "departments",
  "/leave": "attendance",
  "/clients": "clients",
  // Granted to every scope, so it must never collide inside any rail.
  "/team-workspace": "tasks",
};

/** The icon a rail draws for a module, with a readable fallback. */
export function moduleRailIcon(href: string): IconName {
  return MODULE_RAIL_ICONS[href] ?? "tasks";
}

/**
 * Where the Finance rail's first icon goes.
 *
 * This is NOT a module href, so the module matrix does not cover it. It needs a
 * MODULE_CHILDREN rule to be reachable, and it shipped without one — the Finance
 * view's own Dashboard button answered /access-denied. The reachability test
 * imports this constant so the same mistake fails a test rather than a person.
 */
export const FINANCE_DASHBOARD_HREF = "/finance/dashboard";

/**
 * Every href a rail can render, for the roles that see it.
 *
 * The reachability test walks this — so a rail entry added anywhere above is
 * checked automatically. Null hrefs are excluded: they render dimmed on purpose
 * and are not claims that anywhere is reachable.
 */
export const RAIL_DESTINATIONS: readonly { href: string; role: string; source: string }[] = [
  ...RAIL_LINKS.map((entry) => ({ href: entry[0], role: "operator", source: "operator rail" })),
  ...HR_RAIL.filter((entry): entry is readonly [string, string, IconName, string?] => entry[0] !== null)
    .map((entry) => ({ href: entry[0], role: "hr", source: "HR rail" })),
  { href: FINANCE_DASHBOARD_HREF, role: "finance", source: "Finance rail" },
];
