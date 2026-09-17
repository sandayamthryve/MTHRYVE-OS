import type { UserRole } from "@/types/database";
import type { IconName } from "@/components/ui/icons";
import { canAccessModulePath, workspaceRoleForProfile } from "@/lib/auth/module-access";

// The production sidebar, as DATA — same reasoning as lib/nav/rails.ts.
//
// SidebarNav is a "use client" component, so while these groups lived inside it
// nothing could import them and the only way to check a gate was to read the
// JSX. That is how /performance and /employee both came to be built and linked
// from nowhere, and how the role prop sat unused for as long as it did.
//
// Keeping them here, free of React, lets a test walk the same array the
// component renders.

export type SidebarChild = {
  href: string;
  label: string;
};

export type SidebarItem = {
  href: string;
  label: string;
  icon: IconName;
  badgeKey?: "approvals";
  children?: SidebarChild[];
  /**
   * Account roles that may open this destination, when the page guards on one.
   *
   * Omitted means everyone signed in — which is most of the rail. Where it IS
   * set it must match the page's own requireRole call: the nav does not enforce
   * anything, it only avoids rendering a link that would bounce the viewer to
   * /access-denied. A destination shown and then refused reads as a broken page
   * rather than a permission.
   */
  roles?: readonly UserRole[];
  /**
   * Set when the page guards on requireModule rather than requireRole.
   *
   * Those pages admit whoever holds the module — a Finance department head
   * opens the expense ledger, an E-Commerce one does not — which `roles` cannot
   * express, because it only knows the four account roles. The check reuses
   * canAccessModulePath so the nav and the page consult the same authority
   * rather than two lists that drift.
   */
  moduleGated?: true;
};

export const SIDEBAR_GROUPS: SidebarItem[][] = [
  [
    { href: "/", label: "Dashboard (Command Center)", icon: "command" },
    {
      href: "/home/dept",
      label: "Dept Cockpit",
      icon: "departments",
      children: [{ href: "/reports", label: "Reports" }],
    },
    { href: "/home/operations", label: "Operations", icon: "commerce" },
    // /employee was built and then linked from nowhere: only redirect targets
    // and the assistant's route list pointed at it, so the one page every
    // signed-in person has was unreachable from the nav.
    //
    // Labelled "My Workspace", not "Employee Management". The page is a personal
    // dashboard -- welcome line, daily report, quick entry -- gated on
    // requireProfile() alone. The employee-records admin list is a different
    // page that does not exist yet, and naming this one after it would hide that.
    { href: "/employee", label: "My Workspace", icon: "people" },
  ],
  [
    { href: "/tasks", label: "Tasks", icon: "tasks" },
    { href: "/approvals", label: "Approvals", icon: "approvals", badgeKey: "approvals" },
    { href: "/metrics", label: "Metrics", icon: "metrics" },
  ],
  // ── People ────────────────────────────────────────────────────────────────
  // The people-class pages existed and this nav pointed at none of them.
  //
  // /employee is deliberately NOT repeated here: it already sits in the first
  // group as "My Workspace", which is what it is — a personal dashboard every
  // signed-in person gets. Listing it again under "Employee Management" would
  // name it after the admin roster, which does not exist as a page.
  [
    { href: "/people", label: "People", icon: "people", moduleGated: true },
    // The OS already calls /attendance "Daily Logs" in the module matrix. Same
    // name here, so one page does not answer to two.
    { href: "/attendance", label: "Daily Logs", icon: "attendance" },
    { href: "/leave", label: "Leave Management", icon: "quickentry" },
    {
      href: "/performance",
      label: "Performance",
      icon: "leaderboard",
      roles: ["ceo", "coo", "department_head"],
    },
    { href: "/payroll", label: "Payroll", icon: "payroll", roles: ["ceo", "coo"] },
  ],
  // ── Money ─────────────────────────────────────────────────────────────────
  // Every one of these guards on requireModule, so they are module-gated, not
  // role-gated: Finance opens them, another department does not, and leadership
  // does either way. The requireRole(["ceo","coo"]) calls in these files are in
  // the WRITE actions — reading the ledger and changing it are different
  // permissions, and the nav follows the read.
  [
    { href: "/finance/expenses/vendors", label: "Vendors", icon: "partners", moduleGated: true },
    { href: "/finance/expenses/categories", label: "Expense Categories", icon: "knowledge", moduleGated: true },
    { href: "/finance/expenses/approvals", label: "Expense Approvals", icon: "approvals", moduleGated: true },
    { href: "/finance/expenses/records", label: "Expense Records", icon: "reports", moduleGated: true },
    { href: "/finance/expenses/budgets", label: "Budgets", icon: "metrics", moduleGated: true },
    { href: "/finance/expenses/audit", label: "Expense Audit", icon: "intel", moduleGated: true },
  ],
  [
    {
      href: "/tony",
      label: "Tony",
      icon: "ai",
      children: [
        { href: "/copilots", label: "Copilot" },
        { href: "/council", label: "Council" },
        { href: "/csi", label: "CSI" },
      ],
    },
    { href: "/automation-radar", label: "Automation", icon: "quickentry" },
  ],
  [
    { href: "/reports", label: "Report", icon: "reports" },
    { href: "/settings", label: "Settings", icon: "settings" },
  ],
];


/**
 * Whether a viewer should be SHOWN this item.
 *
 * Not a permission — every page keeps its own guard. This only decides whether
 * rendering the link would hand someone a destination that refuses them.
 */
export function sidebarItemVisible(
  item: SidebarItem,
  viewer: { role?: UserRole; department?: string | null }
): boolean {
  if (item.roles) return !!viewer.role && item.roles.includes(viewer.role);
  if (item.moduleGated) {
    const workspaceRole = viewer.role
      ? workspaceRoleForProfile({ role: viewer.role, department_name: viewer.department ?? null })
      : null;
    return canAccessModulePath(workspaceRole, item.href);
  }
  return true;
}

/** The groups a viewer sees, with empty groups dropped. */
export function sidebarGroupsFor(viewer: {
  role?: UserRole;
  department?: string | null;
}): SidebarItem[][] {
  return SIDEBAR_GROUPS.map((group) => group.filter((item) => sidebarItemVisible(item, viewer))).filter(
    (group) => group.length > 0
  );
}
