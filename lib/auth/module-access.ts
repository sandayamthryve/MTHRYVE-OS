// RBAC(1).pdf, supplied 2026-09-09. This is a module-access matrix, not a
// grant of approval, deletion, payment, or user-management privileges.
// Pure data shared by navigation, page guards, and the operator preview gate.
export const WORKSPACE_ROLES = [
  { id: "operator", label: "Operator", description: "Admin · full OS access", icon: "👑", department: null },
  { id: "ecom", label: "E-Commerce", description: "Commerce operations workspace", icon: "🛒", department: "E-Commerce Ops" },
  { id: "creative", label: "Creatives", description: "Creative / Editor workspace", icon: "🎬", department: "Creative" },
  { id: "warehouse", label: "Warehouse & Fulfilment", description: "Warehouse operations workspace", icon: "📦", department: "Warehouse & Fulfillment" },
  { id: "cs", label: "Customer Service", description: "Customer support workspace", icon: "💬", department: "Customer Service" },
  { id: "live", label: "Live Host", description: "Live Host / Ops workspace", icon: "📺", department: "Live Operations" },
  { id: "affiliate", label: "Affiliate Manager", description: "Affiliate workspace", icon: "🌟", department: "Affiliate Marketing" },
  { id: "finance", label: "Finance", description: "Finance workspace", icon: "💰", department: "Finance" },
  { id: "hr", label: "Human Resources", description: "People & HR workspace", icon: "🧑‍💼", department: "Human Resources" },
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]["id"];
type DepartmentRole = Exclude<WorkspaceRole, "operator">;

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return WORKSPACE_ROLES.some((role) => role.id === value);
}

export const WORKSPACE_MODULES = [
  { id: "campaigns", label: "Campaigns", href: "/campaigns", roles: ["ecom"] },
  { id: "orders", label: "TikTok Orders", href: "/tiktok-orders", roles: ["ecom"] },
  { id: "ads", label: "Ad Ops", href: "/ad-ops", roles: ["ecom"] },
  { id: "records", label: "Operational Records", href: "/commerce-ops", roles: ["ecom", "cs"] },
  { id: "clients", label: "Clients", href: "/brands", roles: ["ecom"] },
  { id: "ecommerce-analytics", label: "E-Commerce Analytics", href: "/analytics/ecommerce", roles: ["ecom"] },
  { id: "creative", label: "Creative Studio", href: "/creative-studio", roles: ["creative"] },
  { id: "vesper-studio", label: "Vesper Studio", href: "/studio/vesper", roles: ["creative"] },
  { id: "calendar", label: "Content Calendar", href: "/content-calendar", roles: ["creative"] },
  { id: "creative-analytics", label: "Creatives Analysis", href: "/analytics/creatives", roles: ["creative"] },
  { id: "warehouse", label: "Warehouse Overview", href: "/warehouse/overview", roles: ["warehouse"] },
  { id: "products-intelligence", label: "Product Intelligence", href: "/warehouse/intelligence", roles: ["warehouse"] },
  { id: "products", label: "Product Master", href: "/warehouse/products", roles: ["warehouse"] },
  { id: "stock", label: "Stock", href: "/warehouse/stock", roles: ["warehouse"] },
  { id: "rts", label: "RTS", href: "/warehouse/rts", roles: ["warehouse", "cs"] },
  { id: "cases", label: "Case Monitoring", href: "/warehouse/cases", roles: ["warehouse", "cs"] },
  { id: "warehouse-analytics", label: "Warehouse Analytics", href: "/analytics/warehouse", roles: ["warehouse"] },
  { id: "live-wall", label: "Live & Video Wall", href: "/live-wall", roles: ["live"] },
  { id: "live-selling", label: "Live Selling", href: "/live", roles: ["live"] },
  { id: "live-operations", label: "Live Operations", href: "/live-ops", roles: ["live"] },
  { id: "live-analytics", label: "Live Ops Analytics", href: "/analytics/live_ops", roles: ["live", "cs"] },
  { id: "host-attendance", label: "Host Attendance", href: "/live-ops/attendance", roles: ["live"] },
  { id: "affiliate-campaigns", label: "Affiliate Campaigns", href: "/affiliate", roles: ["affiliate"] },
  { id: "creators", label: "Creators", href: "/creators", roles: ["affiliate"] },
  { id: "leads", label: "Leads", href: "/leads", roles: ["affiliate"] },
  { id: "outreach", label: "BizDev Outreach", href: "/outreach", roles: ["affiliate"] },
  { id: "delivery", label: "Client Delivery", href: "/contracts", roles: ["affiliate"] },
  { id: "affiliate-reach", label: "Affiliate Reach", href: "/affiliate", roles: ["affiliate"] },
  { id: "affiliate-analytics", label: "Affiliate Analytics", href: "/analytics/affiliate", roles: ["affiliate"] },
  { id: "finance", label: "Finance", href: "/finance", roles: ["finance"] },
  { id: "expenses", label: "Expenses", href: "/finance/expenses", roles: ["finance"] },
  { id: "expense-records", label: "Expense Records", href: "/finance/expenses/records", roles: ["finance"] },
  { id: "budgets", label: "Budgets", href: "/finance/expenses/budgets", roles: ["finance"] },
  { id: "expense-audit", label: "Expense Audit", href: "/finance/expenses/audit", roles: ["finance"] },
  // The two master lists the ledger selects from, and the finance-specific
  // approval queue. All three pages existed and were reachable from nothing —
  // not a module, not linked — so Finance could not open the lists its own
  // encode form depends on. Writing to the masters stays leadership-only, but
  // that is enforced by RLS on the rows, not by hiding the page.
  { id: "expense-vendors", label: "Vendors", href: "/finance/expenses/vendors", roles: ["finance"] },
  { id: "expense-categories", label: "Expense Categories", href: "/finance/expenses/categories", roles: ["finance"] },
  { id: "expense-approvals", label: "Expense Approvals", href: "/finance/expenses/approvals", roles: ["finance"] },
  { id: "payroll", label: "Payroll", href: "/payroll", roles: ["finance"] },
  { id: "leaderboard", label: "Leaderboard", href: "/leaderboard", roles: ["hr"] },
  { id: "people", label: "People", href: "/people", roles: ["hr"] },
  // The Review Gate is a module in its own right, not a child of People. It sat
  // at /people/review-gate and inherited access from the People module until it
  // was promoted to a top-level route.
  { id: "review-gate", label: "Review Gate", href: "/reviewgate", roles: ["hr"] },
  { id: "probation", label: "Probation", href: "/people/probation", roles: ["hr"] },
  { id: "daily-logs", label: "Daily Logs", href: "/attendance", roles: ["hr"] },
  { id: "recruitment", label: "Recruitment", href: "/recruitment", roles: ["hr"] },
  { id: "moderation", label: "Moderation Queue", href: "/live-ops/moderation", roles: ["hr"] },
  { id: "lms", label: "LMS", href: "/knowledge", roles: ["hr"] },
  // Granted so the HR rail's own entries resolve instead of bouncing to
  // /access-denied. The pages behind them keep their own action and data
  // guards. /ceo is deliberately NOT here: it calls requireRole(["ceo","coo"]),
  // which no preview scope satisfies, so a grant would not open it -- the rail
  // marks it unavailable instead. /home/dept IS here, because HR now carries
  // department_head (see PREVIEW_ACCOUNT_ROLES) and passes that page's guard.
  // Every department scope gets Tony. /tony guards on requireProfile() alone --
  // any signed-in person opens it -- so this grants the nav entry, not the
  // page: no scope gains anything it could not already reach by typing the URL.
  // Granted per-scope rather than special-cased in the shell so the rail, the
  // module matrix and canAccessModulePath all agree on one answer.
  {
    id: "copilot", label: "Tony · Copilot", href: "/tony",
    roles: ["ecom", "creative", "warehouse", "cs", "live", "affiliate", "finance", "hr"],
  },
  { id: "dept-cockpits", label: "Department Cockpits", href: "/home/dept", roles: ["hr"] },
  // The Leave Tracker is one of HR's own tools in the Team Workspace, and
  // /leave gates on requireProfile() alone, so the grant is what opens it.
  { id: "leave-tracker", label: "Leave Tracker", href: "/leave", roles: ["hr"] },
  // Every department scope gets its own Team Workspace. The page resolves which
  // department it shows from the session, not the URL, so one grant does not
  // open one scope's queue to another.
  {
    id: "team-workspace", label: "Team Workspace", href: "/team-workspace",
    roles: ["ecom", "creative", "warehouse", "cs", "live", "affiliate", "finance", "hr"],
  },
  { id: "client-portal", label: "Client Portal", href: "/clients", roles: ["hr"] },
] as const satisfies readonly { id: string; label: string; href: string; roles: readonly DepartmentRole[] }[];

export type WorkspaceModule = (typeof WORKSPACE_MODULES)[number];

export function modulesForRole(role: WorkspaceRole | null): WorkspaceModule[] {
  return WORKSPACE_MODULES.filter((module) => role === "operator" ||
    (module.roles as readonly string[]).includes(role ?? ""));
}

const MODULE_CHILDREN: readonly [RegExp, string][] = [
  // The Finance rail rewrites its first icon to /finance/dashboard
  // (FinanceRail.tsx), but that route was neither a module nor a declared child
  // — so the Finance view's own Dashboard button led to /access-denied. Exact
  // match, not a /finance prefix: a prefix would hand the whole module tree to
  // anyone holding /finance.
  [/^\/finance\/dashboard$/, "/finance"],
  [/^\/brands\/[^/]+$/, "/brands"],
  [/^\/warehouse\/cases\/[^/]+$/, "/warehouse/cases"],
  [/^\/live\/[^/]+$/, "/live"],
  [/^\/live-ops\/(schedule|campaigns|bottlenecks|reports)(\/[^/]+)?$/, "/live-ops"],
  [/^\/affiliate\/(campaigns\/[^/]+|engage|fulfillment)$/, "/affiliate"],
  [/^\/creators\/[^/]+$/, "/creators"],
  [/^\/outreach\/[^/]+$/, "/outreach"],
  [/^\/contracts\/[^/]+$/, "/contracts"],
];

export function pathOnly(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "";
  try {
    const path = decodeURIComponent(value.split(/[?#]/, 1)[0]).replace(/\/+$/, "") || "/";
    if (path.split("/").some((part) => part === "." || part === "..")) return "";
    return path;
  } catch { return ""; }
}

export function canAccessModulePath(role: WorkspaceRole | null, value: string): boolean {
  const path = pathOnly(value);
  if (!path || !role) return false;
  if (role === "operator") return true;
  const parent = MODULE_CHILDREN.find(([pattern]) => pattern.test(path))?.[1];
  return modulesForRole(role).some((module) => module.href === path || module.href === parent);
}

// Where a role lands. Roles share the Operator-style dashboard by default;
// HR opens on its Review Gate instead, because the people-class queue is the
// first thing that role is meant to act on. Module-level RBAC is unaffected --
// canAccessModulePath and the route/action/data guards still decide what each
// home may contain.
//
// A home must be reachable by the role that gets it, and the middleware only
// redirects when the home differs from the current path, so never point this at
// a path the role cannot open (that lands them on /access-denied) or at the
// path it is redirecting from (that was the "/" -> "/" loop fixed in c372e6e).
const ROLE_HOMES: Partial<Record<WorkspaceRole, string>> = {
  hr: "/reviewgate",
  // Finance lands on its own dashboard rather than "/". Scoping
  // /finance/dashboard to Finance was only half the job: the role still
  // arrived at the shared company board -- Affiliate GMV, CSAT, content
  // scores -- because that board IS "/", and the scoped page was reachable
  // only by clicking the rail's first icon. A role whose landing page shows
  // seven other departments' numbers has not been scoped.
  finance: "/finance/dashboard",
};

export function workspaceHome(role: WorkspaceRole): string {
  return ROLE_HOMES[role] ?? "/";
}

export function roleForDepartment(department: string | null | undefined): WorkspaceRole | null {
  const name = (department ?? "").trim().toLowerCase();
  const aliases: Record<string, DepartmentRole> = {
    "e-commerce": "ecom", "e-commerce ops": "ecom",
    "creative": "creative", "creatives": "creative",
    "warehouse & fulfillment": "warehouse", "warehouse & fulfilment": "warehouse",
    "customer service": "cs", "live operations": "live", "live host": "live",
    "affiliate marketing": "affiliate", "affiliate manager": "affiliate",
    "finance": "finance", "human resources": "hr", "hr & admin": "hr",
  };
  return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : null;
}

export function workspaceRoleForProfile(profile: {
  role: string; department_name?: string | null; preview_role?: WorkspaceRole;
}): WorkspaceRole | null {
  if (profile.preview_role) return profile.preview_role;
  if (profile.role === "ceo" || profile.role === "coo") return "operator";
  return roleForDepartment(profile.department_name);
}
