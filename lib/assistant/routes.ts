// Route Registry for Mthryve AI's `navigate` tool (Phase 2, Step A).
//
// Tony (the grounded Ask Mthryve AI assistant) can move the user around the app
// by calling the `navigate` tool. That tool is deliberately dumb and SAFE: it
// only changes the page shown in the browser — it reads nothing, writes nothing,
// and needs no approval. To keep it honest, the model may only choose a `path`
// from THIS registry (surfaced in the system prompt); the endpoint re-validates
// every model-supplied path against the registry before handing it to the
// client, so an invented or off-list path is refused and Tony says so instead of
// navigating somewhere that doesn't exist.
//
// Role filtering: leadership-only pages (Finance, Payroll, the Executive view,
// the AI Platform) mirror the sidebar's `leadershipOnly` flag and the pages'
// own requireRole(["ceo","coo"]) guards. They are stripped from the registry for
// anyone who isn't ceo/coo, so a team member's Tony is never even offered them —
// and because every surface (typed chat, voice, any future Mini-Tony) calls the
// same /api/assistant with the caller's session role, that filter is enforced in
// exactly one place.

import type { UserRole } from "@/types/database";

export type AppRoute = {
  /** Canonical path handed to the client's router.push. */
  path: string;
  /** Human-friendly destination name, used in the "Taking you to X →" confirm. */
  label: string;
  /** Plain-language description so the model can match intent to a page. */
  description: string;
  /** When true, only ceo/coo see this route in the registry. */
  leadershipOnly?: boolean;
};

// The app's real, navigable routes. There is no per-brand or per-department
// detail page reachable without an id, so "take me to <brand>" targets the
// Clients list and "<department>" targets Departments — the description on each
// entry tells the model that.
export const ROUTE_REGISTRY: readonly AppRoute[] = [
  // --- Executive / overview ---
  { path: "/", label: "Command Center", description: "The main company dashboard / home overview." },
  { path: "/tony", label: "Tony", description: "The Tony command view — the live agent constellation and AI hub." },
  { path: "/assistant", label: "Ask Mthryve AI", description: "The typed company assistant chat." },
  { path: "/accounts", label: "Business Intelligence", description: "Accounts and business-intelligence overview." },
  { path: "/metrics", label: "Metrics", description: "Company and department performance metrics." },
  { path: "/reports", label: "Reports", description: "Reports and weekly rollups." },
  {
    path: "/departments",
    label: "Departments",
    description:
      "The list of all departments. Use this to show a specific department or team (there is no standalone per-department page to navigate to).",
  },

  // --- Commerce / clients ---
  {
    path: "/brands",
    label: "Clients",
    description:
      "The brands / clients list. Use this for any specific brand or client the user names (e.g. 'take me to <brand>') — there is no separate per-brand page.",
  },
  { path: "/platforms", label: "Commerce Ops", description: "Brand × platform performance — GMV, orders, ad spend, blended ROAS." },
  { path: "/contracts", label: "Client Delivery", description: "Client contracts and delivery." },
  { path: "/campaigns", label: "Campaigns", description: "Marketing campaigns." },
  { path: "/live", label: "Live Selling", description: "Live selling sessions." },

  // --- Partners / growth ---
  { path: "/creators", label: "Partner Ecosystem", description: "Creators and partners." },
  { path: "/leads", label: "Leads", description: "Sales and partner leads." },
  { path: "/outreach", label: "BizDev Outreach", description: "Business-development outreach." },

  // --- Growth Pods / Vesper ---
  { path: "/vesper", label: "Vesper — Operator", description: "The Vesper operator agent — run Growth Pod plays (generate scripts, forecast restock, next best product, match creators, analyze content, compile scoreboard)." },
  { path: "/vesper/core", label: "Vesper Core", description: "The capability registry — what Mthryve can actually do across 16 intelligence domains, with coverage scoring, leadership editing, and turning live/partial capabilities into linked tasks." },
  { path: "/scoreboard", label: "Growth Scoreboard", description: "The weekly growth cockpit — brands, GMV, ROAS, contribution, retention and concentration risk, per pod and org-wide." },
  { path: "/pods", label: "Pods", description: "The Growth Pod manager — create pods, set leads and targets, assign brands to pods." },

  // --- Warehouse ---
  { path: "/warehouse", label: "Warehouse", description: "Warehouse overview." },
  { path: "/warehouse/intelligence", label: "Product Intelligence", description: "Warehouse product intelligence." },
  { path: "/warehouse/products", label: "Product Master", description: "The product master list." },

  // --- Creative / content ---
  {
    path: "/creative-studio",
    label: "Creative Studio",
    description:
      "The unified Creative Studio workspace — this is where the content / creative calendar lives (e.g. 'open the creative calendar').",
  },
  { path: "/updates", label: "Experience", description: "Team updates and the employee experience feed." },

  // --- People / governance ---
  { path: "/care", label: "Care", description: "Care — wellbeing and people-care agent (HR & Admin). Confidential pulse and check-ins." },
  { path: "/atlas", label: "Atlas", description: "Atlas — knowledge graph agent (maps documents, memory, graph)." },
  { path: "/oracle", label: "Oracle", description: "Oracle — finance forecast agent (P&L, cashflow, budgets).", leadershipOnly: true },
  { path: "/herald", label: "Herald", description: "Herald — outreach agent (drafts to leads/creators, proposes sends)." },
  { path: "/prospector", label: "Prospector", description: "Prospector — opportunity engine agent (scores HOT/WARM/COLD, proposes qualification)." },
  { path: "/people", label: "People", description: "The people directory." },
  { path: "/reviewgate", label: "Review Gate", description: "The people-class review gate — every pending agent action that touches a person's status, with Approve / Request changes." },
  { path: "/recruitment", label: "Recruitment", description: "Hiring and recruitment." },
  { path: "/approvals", label: "Approvals", description: "The approvals queue." },
  { path: "/tasks", label: "Tasks", description: "The task board." },
  { path: "/projects", label: "Projects Log", description: "The projects board / Projects Log." },
  { path: "/attendance", label: "Attendance", description: "Attendance tracking." },
  { path: "/leaderboard", label: "Leaderboard", description: "The team leaderboard." },
  { path: "/notifications", label: "Notifications", description: "The notifications inbox." },
  { path: "/search", label: "Search", description: "Global search across the OS." },
  { path: "/settings", label: "Settings", description: "App and account settings." },
  { path: "/employee", label: "My Workspace", description: "The employee home / personal workspace." },

  // --- Leadership only (ceo / coo) ---
  { path: "/ceo", label: "Executive Dashboard", description: "The CEO / COO executive dashboard.", leadershipOnly: true },
  { path: "/finance", label: "HR & Finance", description: "Company P&L and finance.", leadershipOnly: true },
  { path: "/payroll", label: "Payroll", description: "Payroll runs.", leadershipOnly: true },
  { path: "/ai-governance", label: "AI Platform", description: "AI model governance and access.", leadershipOnly: true },
];

function isLeadershipRole(role: UserRole): boolean {
  return role === "ceo" || role === "coo";
}

// The registry a given role is allowed to see. Non-leadership callers never get
// the leadership-only routes — so those pages are never offered to them.
export function routesForRole(role: UserRole): AppRoute[] {
  const leadership = isLeadershipRole(role);
  return ROUTE_REGISTRY.filter((r) => !r.leadershipOnly || leadership);
}

// Normalize a path for comparison: trim, ensure a single leading slash, and drop
// any trailing slash (except the root "/"). Query strings / fragments are
// stripped — navigate targets whole pages only.
function normalizePath(raw: string): string {
  let p = raw.trim();
  if (!p) return "";
  const cut = p.search(/[?#]/);
  if (cut !== -1) p = p.slice(0, cut);
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p.toLowerCase();
}

export type Navigation = { path: string; label: string };

// Validate a model-supplied path against the role's allowed registry. Returns
// the CANONICAL { path, label } from the registry when it matches (so the client
// only ever pushes a known-good path), or null when it doesn't — in which case
// the endpoint tells the model there's no such page rather than navigating. The
// model-supplied label is only used to enrich the confirmation text, never to
// pick where to go.
export function resolveNavigation(
  role: UserRole,
  rawPath: unknown,
  rawLabel?: unknown
): Navigation | null {
  if (typeof rawPath !== "string") return null;
  const target = normalizePath(rawPath);
  if (!target) return null;

  const match = routesForRole(role).find((r) => normalizePath(r.path) === target);
  if (!match) return null;

  // Prefer a clean, model-supplied label for the confirmation; fall back to the
  // registry label. Cap length and strip newlines so it stays a short tag.
  let label = match.label;
  if (typeof rawLabel === "string" && rawLabel.trim()) {
    label = rawLabel.trim().replace(/\s+/g, " ").slice(0, 60);
  }
  return { path: match.path, label };
}

// The Anthropic tool definition for `navigate`. One tool, typed params, no free
// text that reaches the router unchecked.
export const NAVIGATE_TOOL = {
  name: "navigate",
  description:
    "Navigate the user to a page. Use when they ask to go to / open / show / take them to a page, brand, department, or module. Choose `path` ONLY from the Route Registry provided in your context — never invent a path. If nothing in the registry matches, do NOT call this tool; tell the user there is no page for that instead. Navigation only changes the page shown — it reads nothing and writes nothing.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'The exact route path from the Route Registry, e.g. "/brands" or "/creative-studio".',
      },
      label: {
        type: "string",
        description: 'A short, human-friendly name of the destination for the confirmation, e.g. "Clients" or "Creative Studio".',
      },
    },
    required: ["path", "label"],
    additionalProperties: false,
  },
} as const;

// Build the Route Registry block appended to the system prompt, listing only the
// routes this caller's role may reach. This is the ONLY set of paths the model is
// told about, which is the first line of defense; resolveNavigation is the second.
export function buildNavigationPrompt(routes: AppRoute[]): string {
  const lines = routes.map((r) => `- ${r.path} — ${r.label} — ${r.description}`);
  return [
    "=== Navigation (the `navigate` tool) ===",
    "You can move the user around the app. When they ask to go to / open / show /",
    "take them to a page, brand, department, or module, call the `navigate` tool",
    "with a `path` chosen ONLY from the Route Registry below and a short `label`.",
    "Never invent a path. If nothing in the registry matches what they asked for,",
    "do NOT call the tool — say plainly that there is no page for that. There is no",
    "per-brand or per-department page: to show a specific brand/client use /brands,",
    "and for a specific department use /departments. Navigation only changes the",
    "page shown; it reads and writes nothing.",
    "",
    "Route Registry (path — label — what it's for):",
    ...lines,
  ].join("\n");
}
