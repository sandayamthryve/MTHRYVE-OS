import { WORKSPACE_ROLES, canAccessModulePath, type WorkspaceRole } from "@/lib/auth/module-access";

// The Team Workspace: one screen per department scope, holding the tools that
// scope reaches for, the work it owes today, and where it logs what it did.
//
// Tools are declared per scope rather than derived from modulesForRole, because
// the module list is an access table in access order -- it answers "may I?", not
// "what do I open first?". A tool whose route does not exist yet, or which the
// viewing scope cannot open, is shown disabled with the reason instead of being
// dropped: a department's toolset is a statement about the work, and a missing
// piece is information, not noise.
export type WorkspaceTool = {
  label: string;
  // null means no route exists yet — rendered disabled, never linked.
  href: string | null;
};

export type DepartmentWorkspace = {
  role: Exclude<WorkspaceRole, "operator">;
  label: string;
  icon: string;
  // Who staffs it and which agents co-pilot — the "Divine + team" line.
  staff: string;
  copilot: string;
  tools: readonly WorkspaceTool[];
};

export const DEPARTMENT_WORKSPACES: readonly DepartmentWorkspace[] = [
  {
    role: "ecom", label: "E-Commerce Specialist", icon: "🛒",
    staff: "Commerce pod", copilot: "Merchant + Tony",
    tools: [
      { label: "Campaigns", href: "/campaigns" },
      { label: "TikTok Orders", href: "/tiktok-orders" },
      { label: "Ad Ops", href: "/ad-ops" },
      { label: "Clients", href: "/clients" },
      { label: "Analytics", href: "/analytics/ecommerce" },
    ],
  },
  {
    role: "creative", label: "Creative", icon: "🎬",
    staff: "Creative pod", copilot: "Vesper + Tony",
    tools: [
      { label: "Creative Studio", href: "/creative-studio" },
      { label: "Vesper Studio", href: "/studio/vesper" },
      { label: "Content Calendar", href: "/content-calendar" },
      { label: "Analytics", href: "/analytics/creatives" },
    ],
  },
  {
    role: "warehouse", label: "Warehouse", icon: "📦",
    staff: "Fulfilment pod", copilot: "Logi + Tony",
    tools: [
      { label: "Overview", href: "/warehouse/overview" },
      { label: "Stock", href: "/warehouse/stock" },
      { label: "RTS", href: "/warehouse/rts" },
      { label: "Cases", href: "/warehouse/cases" },
      { label: "Products", href: "/warehouse/products" },
    ],
  },
  {
    role: "cs", label: "Customer Service", icon: "💬",
    staff: "Care pod", copilot: "Care + Tony",
    tools: [
      { label: "Case Monitoring", href: "/warehouse/cases" },
      { label: "RTS", href: "/warehouse/rts" },
      { label: "Analytics", href: "/analytics/live_ops" },
    ],
  },
  {
    role: "live", label: "Live Host", icon: "📺",
    staff: "Live pod", copilot: "Anchor + Tony",
    tools: [
      { label: "Live Selling", href: "/live" },
      { label: "Live Operations", href: "/live-ops" },
      { label: "Video Wall", href: "/live-wall" },
      { label: "Host Attendance", href: "/live-ops/attendance" },
    ],
  },
  {
    role: "affiliate", label: "Affiliate Manager", icon: "🌟",
    staff: "Affiliate pod", copilot: "Scout + Tony",
    tools: [
      { label: "Campaigns", href: "/affiliate" },
      { label: "Creators", href: "/creators" },
      { label: "Leads", href: "/leads" },
      { label: "Outreach", href: "/outreach" },
      { label: "Delivery", href: "/contracts" },
    ],
  },
  {
    role: "finance", label: "Finance", icon: "💰",
    staff: "Finance pod", copilot: "Ledger + Tony",
    tools: [
      { label: "Finance", href: "/finance" },
      { label: "Expenses", href: "/finance/expenses" },
      { label: "Budgets", href: "/finance/expenses/budgets" },
      { label: "Payroll", href: "/payroll" },
      { label: "Audit", href: "/finance/expenses/audit" },
    ],
  },
  {
    role: "hr", label: "Human Resources", icon: "👥",
    staff: "Divine + team", copilot: "Talent + Tony",
    tools: [
      { label: "Roster", href: "/people" },
      { label: "Attendance", href: "/attendance" },
      // No /onboarding route exists yet; recruitment is the nearest real
      // surface, so onboarding stays disabled rather than pointing somewhere
      // it does not mean.
      { label: "Onboarding", href: null },
      { label: "Leave Tracker", href: "/leave" },
      // Payroll Prep is Finance's module. HR files INTO it; it does not open it.
      { label: "Payroll Prep", href: null },
    ],
  },
];

export function workspaceForRole(role: WorkspaceRole): DepartmentWorkspace | null {
  return DEPARTMENT_WORKSPACES.find((entry) => entry.role === role) ?? null;
}

// Which departments a viewer may switch between. Operator previews every scope,
// the way it does everywhere else in the OS; a department scope sees only its
// own, because seeing another department's queue and logs is cross-department
// read access that no module grant gives.
export function visibleWorkspaces(role: WorkspaceRole): readonly DepartmentWorkspace[] {
  if (role === "operator") return DEPARTMENT_WORKSPACES;
  const own = workspaceForRole(role);
  return own ? [own] : [];
}

// A tool is openable only if it has a route AND the viewing scope passes the
// module check for it. Operator passes everything. This mirrors what the
// destination would decide, so we never render a link that bounces.
export function toolState(
  role: WorkspaceRole,
  tool: WorkspaceTool
): { href: string; disabled: false } | { href: null; disabled: true; reason: string } {
  if (!tool.href) return { href: null, disabled: true, reason: "coming soon" };
  if (!canAccessModulePath(role, tool.href)) {
    return { href: null, disabled: true, reason: "not in your access" };
  }
  return { href: tool.href, disabled: false };
}

export const WORKSPACE_ROLE_LABEL = new Map(
  WORKSPACE_ROLES.map((entry) => [entry.id, entry.label] as const)
);
