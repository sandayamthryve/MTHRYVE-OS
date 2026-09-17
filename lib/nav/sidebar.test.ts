import { describe, expect, it } from "vitest";
import { SIDEBAR_GROUPS, sidebarGroupsFor, sidebarItemVisible } from "./sidebar";

// The production sidebar, checked the way the devchannel rails are.
//
// The failure this guards against is specific and has happened twice: a link is
// rendered to someone the destination will refuse, and the /access-denied they
// land on reads as a broken page rather than a permission. The other half is
// the opposite — a page built and linked from nowhere, which is how
// /performance and /employee both sat unreachable.

const hrefs = () => SIDEBAR_GROUPS.flat().map((item) => item.href);
const labelsFor = (viewer: { role?: "ceo" | "coo" | "department_head" | "team_member"; department?: string | null }) =>
  sidebarGroupsFor(viewer).flat().map((item) => item.label);

describe("sidebar visibility", () => {
  it("never gates one item two ways", () => {
    // roles and moduleGated answer different questions — which account role you
    // hold, versus which department's modules. An item setting both would have
    // one of them silently ignored by sidebarItemVisible's ordering.
    const both = SIDEBAR_GROUPS.flat().filter((item) => item.roles && item.moduleGated);
    expect(both.map((item) => item.href)).toEqual([]);
  });

  it("shows leadership everything", () => {
    // ceo resolves to the operator workspace role, which holds every module.
    const ceo = labelsFor({ role: "ceo", department: null });
    expect(ceo).toContain("Performance");
    expect(ceo).toContain("Payroll");
    expect(ceo).toContain("Expense Approvals");
    expect(ceo.length).toBe(hrefs().length);
  });

  it("does not show a team member the pages that would refuse them", () => {
    const seen = labelsFor({ role: "team_member", department: "Finance" });
    // requireRole(["ceo","coo","department_head"]) and (["ceo","coo"]).
    expect(seen).not.toContain("Performance");
    expect(seen).not.toContain("Payroll");
    // Still gets the pages that guard on requireProfile alone.
    expect(seen).toContain("Leave Management");
    expect(seen).toContain("Daily Logs");
  });

  it("keeps one department's module pages out of another's sidebar", () => {
    // The whole reason moduleGated exists: `roles` cannot tell these two apart,
    // because both are department_head.
    const finance = labelsFor({ role: "department_head", department: "Finance" });
    const ecom = labelsFor({ role: "department_head", department: "E-Commerce Ops" });

    for (const label of ["Vendors", "Expense Categories", "Expense Approvals", "Budgets"]) {
      expect({ label, finance: finance.includes(label) }).toEqual({ label, finance: true });
      expect({ label, ecom: ecom.includes(label) }).toEqual({ label, ecom: false });
    }
    // Performance is role-gated, not module-gated, so BOTH heads keep it.
    expect(finance).toContain("Performance");
    expect(ecom).toContain("Performance");
  });

  it("drops a group rather than drawing a divider around nothing", () => {
    // A team member in an unmapped department loses the whole Money group.
    const groups = sidebarGroupsFor({ role: "team_member", department: "Unassigned" });
    expect(groups.every((group) => group.length > 0)).toBe(true);
    expect(groups.flat().map((item) => item.label)).not.toContain("Budgets");
  });

  it("signs nobody out of the ungated core", () => {
    // No role at all (a profile still loading) must not blank the nav.
    const anonymous = labelsFor({});
    expect(anonymous).toContain("Dashboard (Command Center)");
    expect(anonymous).toContain("My Workspace");
    // ...but must not leak a gated destination.
    expect(anonymous).not.toContain("Payroll");
    expect(anonymous).not.toContain("Vendors");
  });

  it("lists /employee once, as the personal page it is", () => {
    // It is a personal dashboard on requireProfile, not the employee-records
    // admin list — which does not exist. Naming it "Employee Management" here
    // would advertise a screen nobody can open, and listing it twice would
    // imply they are different pages.
    const employee = SIDEBAR_GROUPS.flat().filter((item) => item.href === "/employee");
    expect(employee.map((item) => item.label)).toEqual(["My Workspace"]);
  });

  it("has no duplicate destinations", () => {
    // Everything the nav actually renders, children included — a href reachable
    // from two places in one rail is either a mistake or a decision worth
    // seeing. /reports is the one known repeat: a child under Dept Cockpit and
    // again as "Report" in the last group.
    const all = SIDEBAR_GROUPS.flat().flatMap((item) => [
      item.href,
      ...(item.children?.map((child) => child.href) ?? []),
    ]);
    const dupes = [...new Set(all.filter((href, index) => all.indexOf(href) !== index))];
    expect(dupes).toEqual(["/reports"]);
    // And no href is listed twice at the TOP level, where it would render as
    // two separate rows.
    const top = hrefs();
    expect(top.filter((href, index) => top.indexOf(href) !== index)).toEqual([]);
  });
});

describe("sidebarItemVisible", () => {
  it("treats an ungated item as visible to anyone", () => {
    expect(sidebarItemVisible({ href: "/x", label: "X", icon: "command" }, {})).toBe(true);
  });
});
