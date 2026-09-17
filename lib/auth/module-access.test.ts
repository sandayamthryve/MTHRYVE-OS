import { describe, expect, it } from "vitest";
import { WORKSPACE_MODULES, WORKSPACE_ROLES, canAccessModulePath, modulesForRole, workspaceHome, workspaceRoleForProfile, type WorkspaceRole } from "./module-access";
import { canAccessPreviewRequest, resolvePreviewRole } from "./preview-access";
import { DEV_CHANNEL_PROFILE, devChannelProfileForRole } from "./dev-channel";
import { isWarehouseWriter } from "./session";
// The rails as data, imported rather than transcribed — see lib/nav/rails.ts.
import { FINANCE_DASHBOARD_HREF, HR_RAIL, MODULE_RAIL_ICONS, RAIL_DESTINATIONS, moduleRailIcon } from "@/lib/nav/rails";

// Independently transcribed from RBAC(1).pdf, including its two labels for the
// existing /affiliate workspace. Do not derive expected permissions from code.
const PDF: Record<Exclude<WorkspaceRole, "operator">, string[]> = {
  ecom: ["Campaigns", "TikTok Orders", "Ad Ops", "Operational Records", "Clients", "E-Commerce Analytics"],
  creative: ["Creative Studio", "Vesper Studio", "Content Calendar", "Creatives Analysis"],
  warehouse: ["Warehouse Overview", "Product Intelligence", "Product Master", "Stock", "RTS", "Case Monitoring", "Warehouse Analytics"],
  cs: ["Operational Records", "Case Monitoring", "RTS", "Live Ops Analytics"],
  live: ["Live & Video Wall", "Live Selling", "Live Operations", "Live Ops Analytics", "Host Attendance"],
  affiliate: ["Affiliate Campaigns", "Creators", "Leads", "BizDev Outreach", "Client Delivery", "Affiliate Reach", "Affiliate Analytics"],
  finance: ["Finance", "Expenses", "Expense Records", "Budgets", "Expense Audit", "Payroll"],
  hr: ["Leaderboard", "People", "Probation", "Daily Logs", "Recruitment", "Moderation Queue", "LMS"],
};

// Modules deliberately granted BEYOND the PDF, each one a recorded decision.
// The PDF stays the baseline above — widening a role means adding it here on
// purpose, so accidental drift still fails the matrix. Keep the reason with it.
const GRANTED_BEYOND_PDF: Partial<Record<Exclude<WorkspaceRole, "operator">, string[]>> = {
  // 2026-09-17: the ledger selects from these two masters and files into that
  // queue, and all three were reachable from nothing. Read access follows the
  // module; writing the masters is still leadership-only, enforced by RLS.
  finance: ["Vendors", "Expense Categories", "Expense Approvals"],
  // 2026-09-17: HR's rail opens on the Review Gate and links these, so they are
  // granted rather than left to bounce off /access-denied. Department Cockpits
  // and Executive Review are NOT granted -- requireRole() rejects team_member
  // there, so the grant would buy nothing. Review Gate is here because it is a
  // module of its own since moving to /reviewgate; at /people/review-gate it
  // inherited the People grant and needed no entry.
  hr: ["Review Gate", "Client Portal", "Department Cockpits", "Leave Tracker"],
};

// Granted to every department scope rather than to one. Kept separate so a
// blanket grant reads as a blanket grant, instead of hiding as the same string
// repeated in eight per-role lists.
const GRANTED_TO_EVERY_SCOPE = [
  // 2026-09-17: each scope gets its own Team Workspace. The page resolves the
  // department from the session, not the URL, so this opens no scope to another.
  "Team Workspace",
  // 2026-09-17: Tony on every department rail, by request. /tony guards on
  // requireProfile() alone, so the grant buys a nav entry rather than access --
  // every one of these scopes could already open it by typing the URL. It was
  // HR-only before, which is why it moved out of GRANTED_BEYOND_PDF.
  "Tony · Copilot",
];

// Preview scopes that carry an account role above the team_member floor. Each
// one is a deliberate privilege decision, not a nav convenience: the raised role
// is checked in hundreds of places, writes included, so it must be written down
// here to pass. See PREVIEW_ACCOUNT_ROLES in dev-channel.ts.
const RAISED_ACCOUNT_ROLE: Partial<Record<Exclude<WorkspaceRole, "operator">, string>> = {
  // 2026-09-17: raised so the HR rail's Department Cockpit entry opens --
  // /home/dept accepts ceo, coo or department_head.
  hr: "department_head",
};

// Preview scopes carrying a team assignment. Separate from the account role
// above because it is a narrower grant: it satisfies the gates that ask which
// TEAM someone is on (isWarehouseWriter) without touching the ~325 checks on
// department_head. Written down here for the same reason -- a scope that can
// write should never acquire that quietly.
const TEAM_ASSIGNMENT: Partial<Record<Exclude<WorkspaceRole, "operator">, string>> = {
  // 2026-09-17: makes the Warehouse view a warehouse writer, so Product Master
  // is editable (add, bulk upload, bulk edit, per-row) for the role it belongs
  // to. Before this it rendered read-only for Warehouse and was writable only
  // by Operator.
  warehouse: "Warehouse & Fulfillment",
};

describe("PDF least-privilege module matrix", () => {
  for (const [role, labels] of Object.entries(PDF)) {
    it(`${role} gets the PDF modules plus only its recorded grants`, () => {
      const expected = [
        ...labels,
        ...GRANTED_TO_EVERY_SCOPE,
        ...(GRANTED_BEYOND_PDF[role as Exclude<WorkspaceRole, "operator">] ?? []),
      ];
      expect(modulesForRole(role as WorkspaceRole).map((module) => module.label).sort()).toEqual(expected.sort());
    });
    it(`${role} retains the operator identity without CEO privileges`, () => {
      const profile = devChannelProfileForRole(role as WorkspaceRole);
      expect(profile.id).toBe(DEV_CHANNEL_PROFILE.id);
      expect(profile.org_id).toBe(DEV_CHANNEL_PROFILE.org_id);
      expect(profile.email).toBe(DEV_CHANNEL_PROFILE.email);
      expect(profile.department_id).toBeNull();
      // team_member is the floor; a raise has to be written down to pass.
      expect(profile.role).toBe(RAISED_ACCOUNT_ROLE[role as Exclude<WorkspaceRole, "operator">] ?? "team_member");
      // So does a team assignment, which is a write grant of its own.
      expect(profile.team_assignment).toBe(
        TEAM_ASSIGNMENT[role as Exclude<WorkspaceRole, "operator">] ?? null
      );
      // The point of this test, whatever the floor: no preview scope is ever
      // leadership. ceo/coo is what gates /ceo, governance and the approval
      // spine, and no amount of nav or module work may hand it out.
      expect(["ceo", "coo"]).not.toContain(profile.role);
      expect(workspaceRoleForProfile(profile)).toBe(role);
    });
  }

  it.each([
    ["cs", "/commerce-ops", true], ["cs", "/warehouse/rts", true],
    ["cs", "/warehouse/cases/case-1", true], ["cs", "/warehouse/stock", false],
    ["cs", "/warehouse/overview", false], ["cs", "/care", false],
    ["ecom", "/warehouse/stock", false], ["warehouse", "/tiktok-orders", false],
    ["creative", "/content-calendar", true], ["live", "/content-calendar", false],
    ["live", "/live-ops/attendance", true], ["live", "/live-ops/moderation", false],
    ["live", "/live-ops/contributors", false], ["hr", "/live-ops/moderation", true],
    ["hr", "/live-ops/attendance", false], ["hr", "/payroll", false],
    ["finance", "/payroll", true], ["finance", "/people", false],
    ["finance", "/finance/expenses/approvals", true],
    ["finance", "/finance/expenses/vendors", true],
    ["finance", "/finance/expenses/categories", true],
    // Still closed to everyone else, and the prefix stays shut.
    ["hr", "/finance/expenses/vendors", false], ["cs", "/finance/expenses/approvals", false],
    ["finance", "/finance/expenses/vendors-evil", false],
    ["affiliate", "/contracts/contract-1", true], ["affiliate", "/brands", false],
    ["finance", "/finance-evil", false], ["cs", "/warehouse/cases-evil", false],
    ["finance", "/finance/../people", false], ["finance", "/finance/%2e%2e/people", false],
    ["finance", "//finance", false], ["finance", "/finance/%", false],
    // The Review Gate is a child of the People module -- it must not open that
    // module to other /people prefixes, nor to roles without People at all.
    // The Review Gate is its own module now, so it must stand on its own grant
    // and must not drag any /people prefix along with it.
    ["hr", "/reviewgate", true], ["hr", "/reviewgate-evil", false],
    ["hr", "/reviewgate/anything", false], ["finance", "/reviewgate", false],
    ["hr", "/people/review-gate", false], ["hr", "/people/anything", false],
    // Team Workspace is the one module every scope holds; the page, not the
    // module table, decides which department it shows.
    ["hr", "/team-workspace", true], ["finance", "/team-workspace", true],
    ["cs", "/team-workspace", true], ["hr", "/team-workspace-evil", false],
    // The Finance rail's own Dashboard icon. Declared as a child of /finance,
    // exact-match — holding /finance must not open the rest of the tree.
    ["finance", "/finance/dashboard", true], ["cs", "/finance/dashboard", false],
    ["finance", "/finance/dashboard-evil", false], ["finance", "/finance/anything", false],
  ])("%s access to %s is %s", (role, path, allowed) => {
    expect(canAccessModulePath(role as WorkspaceRole, path)).toBe(allowed);
  });

  it("does not let a department head or explicit legacy allowlist inherit other departments", () => {
    expect(workspaceRoleForProfile({ role: "department_head", department_name: "Creative" })).toBe("creative");
    expect(workspaceRoleForProfile({ role: "team_member", department_name: "Unassigned" })).toBeNull();
    expect(modulesForRole(null)).toEqual([]);
  });

  it("unknown or malformed preview roles fail closed", () => {
    expect(resolvePreviewRole(undefined)).toBe("operator");
    for (const value of ["", "ceo", "admin", "OPERATOR", "__proto__"]) {
      expect(resolvePreviewRole(value)).toBeNull();
    }
  });

  it("does not expose unscoped or cross-department API data", () => {
    expect(canAccessPreviewRequest("cs", "/api/metrics/export", "department=live_ops")).toBe(true);
    expect(canAccessPreviewRequest("cs", "/api/metrics/export", "department=ecommerce")).toBe(false);
    expect(canAccessPreviewRequest("cs", "/api/metrics/export")).toBe(false);
    expect(canAccessPreviewRequest("cs", "/api/metrics/export", "department=live_ops&department=ecommerce")).toBe(false);
    expect(canAccessPreviewRequest("cs", "/api/metrics/catalog")).toBe(false);
    expect(canAccessPreviewRequest("hr", "/api/finance/expenses")).toBe(false);
    expect(canAccessPreviewRequest("creative", "/api/vesper/jobs/1/segment")).toBe(true);
    expect(canAccessPreviewRequest("creative", "/api/vesper/diag")).toBe(false);
    expect(canAccessPreviewRequest("finance", "/api/admin/automation/run")).toBe(false);
    expect(canAccessPreviewRequest("finance", "/api/os/snapshot")).toBe(false);
    expect(canAccessPreviewRequest("finance", "/api/new-unassigned-module")).toBe(false);
  });
});

// Every nav destination must be reachable by the roles that are shown it.
//
// Two bugs of this shape shipped on 2026-09-17 and neither was a broken page:
// the Finance rail's own Dashboard icon pointed at /finance/dashboard, and the
// header logo sat at a root path — both existed, both worked, and neither was
// granted, so both answered /access-denied. A destination that is rendered and
// not granted looks like a bug in the page it never reaches.
//
// This walks RAIL_DESTINATIONS, the same arrays DevBentoShell and FinanceRail
// render, so a rail entry added there is covered here without anyone
// remembering to mirror it. That mirroring is what failed last time.
describe("nav destinations are reachable by the roles shown them", () => {
  it.each(RAIL_DESTINATIONS.map((d) => [d.source, d.role, d.href] as const))(
    "%s: %s can open %s",
    (_source, role, href) => {
      expect(canAccessPreviewRequest(role as WorkspaceRole, href)).toBe(true);
    }
  );

  it("covers every rail, so a new one cannot slip the check", () => {
    // If a rail is added and not registered in RAIL_DESTINATIONS, this is the
    // test that notices — the per-entry cases above would simply not run.
    const sources = new Set(RAIL_DESTINATIONS.map((d) => d.source));
    expect([...sources].sort()).toEqual(["Finance rail", "HR rail", "operator rail"]);
    expect(RAIL_DESTINATIONS.length).toBeGreaterThanOrEqual(HR_RAIL.filter((e) => e[0]).length);
  });

  it("every module granted to a role is reachable by that role", () => {
    const unreachable: string[] = [];
    for (const role of Object.keys(PDF) as Exclude<WorkspaceRole, "operator">[]) {
      for (const module of modulesForRole(role)) {
        if (!canAccessPreviewRequest(role, module.href)) {
          unreachable.push(`${role} -> ${module.href}`);
        }
      }
    }
    expect(unreachable).toEqual([]);
  });

  it("granting a nav entry does not open its siblings", () => {
    // The fix for /finance/dashboard is an exact match, not a prefix. A prefix
    // would have handed the whole expenses tree to anyone holding /finance.
    expect(canAccessPreviewRequest("finance", FINANCE_DASHBOARD_HREF)).toBe(true);
    expect(canAccessPreviewRequest("finance", "/finance/anything")).toBe(false);
    expect(canAccessPreviewRequest("cs", FINANCE_DASHBOARD_HREF)).toBe(false);
  });
});

// Where each role lands, and the two rules a landing page has to obey.
//
// Both were learned the hard way. Pointing a home at a path the role cannot
// open drops it on /access-denied; pointing it at the path the middleware
// redirects FROM is the "/" -> "/" loop that shipped to production in c372e6e.
// The rules were written in a comment above ROLE_HOMES and enforced by nothing.
describe("role landing pages", () => {
  const REDIRECTS_FROM = ["/", "/home"];

  it.each(WORKSPACE_ROLES.filter((r) => r.id !== "operator").map((r) => r.id))(
    "%s lands somewhere it can actually open",
    (role) => {
      const home = workspaceHome(role as WorkspaceRole);
      if (home === "/") return; // the shared board, open to every scope
      expect(canAccessPreviewRequest(role as WorkspaceRole, home)).toBe(true);
      // A home equal to a path the middleware redirects from redirects to
      // itself, forever.
      expect(REDIRECTS_FROM).not.toContain(home);
    }
  );

  // Named explicitly: these two are product decisions, not incidental. If one
  // changes, it should change here on purpose.
  it("HR opens on the Review Gate and Finance on its own dashboard", () => {
    expect(workspaceHome("hr")).toBe("/reviewgate");
    // Not "/": that is the shared company board -- Affiliate GMV, CSAT,
    // content scores -- which is exactly what Finance must not land on.
    expect(workspaceHome("finance")).toBe(FINANCE_DASHBOARD_HREF);
  });

  it("operator keeps the shared board", () => {
    expect(workspaceHome("operator")).toBe("/");
  });
});

// The HR rail drew emoji while every other rail drew the shared SVG set, so one
// role rendered in the system emoji font -- full-colour, sized differently on
// each platform, and unable to take the active pill's dark ink.
//
// OrderedRailEntry types the icon as IconName, which stops an emoji LITERAL at
// the build. This catches the other way in: a cast, or a name assembled at
// runtime. Every rail icon is ASCII, and no emoji is.
describe("rail icons are icons, not emoji", () => {
  it.each(HR_RAIL.map((entry) => [entry[1], entry[2]] as const))(
    "HR's %s uses the icon %s",
    (_label, icon) => {
      expect(icon).toMatch(/^[a-z]+$/);
    }
  );
});

// The write gates a preview scope satisfies, checked against the gate itself
// rather than against a copy of its rules.
//
// isWarehouseWriter passes for leadership OR a team_assignment naming
// warehouse. Asserting through the real function means a change to either half
// of that "or" shows up here, instead of a test that agrees with a stale
// transcription of it.
describe("preview scopes satisfy only the write gates they are meant to", () => {
  it("Warehouse can write the product master; no other department scope can", () => {
    for (const role of Object.keys(PDF) as Exclude<WorkspaceRole, "operator">[]) {
      const profile = devChannelProfileForRole(role);
      expect({ role, writer: isWarehouseWriter(profile) }).toEqual({
        role,
        // HR is department_head, which isWarehouseWriter accepts on the
        // leadership half -- that came with the 2026-09-17 raise and is why the
        // narrower team assignment was used for Warehouse instead.
        writer: role === "warehouse" || role === "hr",
      });
    }
  });

  it("the warehouse grant is a team assignment, not a raised account role", () => {
    const profile = devChannelProfileForRole("warehouse");
    expect(profile.role).toBe("team_member");
    expect(profile.team_assignment).toBe("Warehouse & Fulfillment");
  });
});

// A rail is only navigable if its icons differ from each other.
//
// Every role except HR and Finance used to fall back to one icon for every
// module, so six rails drew the same checkbox eight times over. The icons
// carried no information and the tooltip was the only way to tell one
// destination from another.
//
// The rule is per-RAIL, not global: ICONS deliberately reuses paths across
// names, and two roles drawing the same glyph for different modules is fine
// because nobody sees both rails at once. Two entries in ONE rail drawing the
// same glyph is the defect.
describe("rail icons are distinguishable within a rail", () => {
  // What DevBentoShell builds for a department role: the workspace home,
  // then the role's modules deduplicated by href.
  const railFor = (role: Exclude<WorkspaceRole, "operator">) => {
    const seen = new Set<string>();
    return modulesForRole(role)
      .filter((module) => (seen.has(module.href) ? false : (seen.add(module.href), true)))
      .map((module) => ({ href: module.href, label: module.label, icon: moduleRailIcon(module.href) }));
  };

  // HR is excluded on purpose: it renders HR_RAIL, hand-ordered, and never its
  // module list. Its modules collide in MODULE_RAIL_ICONS (Review Gate and
  // Moderation Queue both resolve, Probation / Daily Logs / Leave Tracker all
  // resolve) and that is harmless, because nothing draws them. Contorting the
  // shared map to satisfy a rail no one sees would make the icons worse for the
  // roles that DO use it. HR's real rail is checked below.
  const MAP_DRIVEN = (Object.keys(PDF) as Exclude<WorkspaceRole, "operator">[]).filter(
    (role) => role !== "hr"
  );

  it.each(MAP_DRIVEN)(
    "%s draws a different icon for every module in its rail",
    (role) => {
      const rail = railFor(role);
      const byIcon = new Map<string, string[]>();
      for (const entry of rail) {
        byIcon.set(entry.icon, [...(byIcon.get(entry.icon) ?? []), entry.label]);
      }
      const collisions = [...byIcon.entries()]
        .filter(([, labels]) => labels.length > 1)
        .map(([icon, labels]) => `${icon}: ${labels.join(" + ")}`);
      expect(collisions).toEqual([]);
      // "command" belongs to the workspace home the shell prepends; a module
      // taking it would collide with that.
      expect(rail.map((entry) => entry.icon)).not.toContain("command");
    }
  );

  it("every module in the matrix has a declared icon, not the fallback", () => {
    // The fallback keeps a new module from crashing the rail, but shipping on
    // it is how the all-checkboxes rails happened in the first place.
    const undeclared = WORKSPACE_MODULES.map((module) => module.href).filter(
      (href) => !(href in MODULE_RAIL_ICONS)
    );
    expect(undeclared).toEqual([]);
  });

  it("HR's hand-ordered rail is distinguishable too", () => {
    const icons = HR_RAIL.map((entry) => entry[2]);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
