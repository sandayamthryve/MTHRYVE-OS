// Central help-copy registry.
//
// Every "(?)" affordance in the app resolves its text from this one map, so the
// plain-language explainer for each cluster and key feature lives in a single
// auditable place instead of being scattered across JSX. Keep each entry to two
// or three short sentences: what the thing is, and what a user actually does
// here. Plain English — no jargon, no acronyms without spelling them out once.
//
// IDs are dotted: a top-level cluster (`work`) and its features (`work.tasks`).
// Adding a new hint is just adding a row here and dropping <HelpHint id="…" />
// into the relevant header.

export type HelpEntry = {
  /** Short bold heading shown at the top of the tooltip. */
  title: string;
  /** 2–3 plain-language sentences: what it is + what to do here. */
  body: string;
};

export const HELP_REGISTRY: Record<string, HelpEntry> = {
  // ── HOME ───────────────────────────────────────────────────────────────
  home: {
    title: "Home",
    body: "Your personal landing view, tuned to your role — leadership sees the org command center, department heads see their brands and KPIs, everyone else sees their own day. It pulls together what needs you, how your brands are doing, and your numbers versus target. Start here each day, then jump to whatever needs action.",
  },

  // ── WORK ───────────────────────────────────────────────────────────────
  work: {
    title: "Work",
    body: "The workflow cluster — tasks, approvals, and the automation tooling that sits around them. This is where day-to-day work is assigned, reviewed, and signed off. Use it to see what's on your plate and to move items forward.",
  },
  "work.tasks": {
    title: "Tasks",
    body: "Every project and task the team is tracking, grouped by project with open counts up top. Create a project or task, assign an owner, and update status as work moves. This is the single to-do list the whole org reads from.",
  },
  "work.approvals": {
    title: "Action & Approval Queue",
    body: "Where AI-drafted actions and governed changes wait for a human decision. Tony drafts, you approve, and only then does the OS execute — nothing runs on its own. Review each item, then approve or reject it here.",
  },
  "work.automationRadar": {
    title: "Automation Radar",
    body: "One engine scans every department's real work for repetitive patterns and proposes automations, ranked by the time they'd save each month. Nothing is automated until a leader approves the proposal. Review the ranked suggestions and approve the ones worth wiring up.",
  },
  "work.bulkImport": {
    title: "Bulk Import",
    body: "Load many records at once from a CSV or spreadsheet: upload, map your columns to fields, preview, then commit. Duplicates are blocked, invalid rows are flagged, and every import is audited. Use it to backfill or migrate data instead of typing rows one by one.",
  },

  // ── COMMERCE ───────────────────────────────────────────────────────────
  commerce: {
    title: "Commerce",
    body: "The revenue-facing cluster — client brands and shops, campaigns, live selling, the partner ecosystem, warehouse, and creative. Everything tied to selling and fulfilling lives under this door. Use it to run and monitor the commercial side of the business.",
  },
  "commerce.liveVideoWall": {
    title: "Live & Video Wall",
    body: "Mission control for live selling — every active session at a glance, plus a library of posted videos that play right inside the OS. Numbers shown are real entries only; a metric with no data reads as a dash rather than a guess. Watch running lives, review past videos, and spot which sessions need attention.",
  },
  "commerce.affiliate": {
    title: "Affiliate Campaigns",
    body: "The home for the affiliate program — campaigns, creator sourcing, and the qualification pipeline in one place. Launch a campaign, source and vet creators, and move them through the pipeline to active partnerships. Use it to grow and manage your roster of affiliate creators.",
  },
  "commerce.marketplace": {
    title: "Marketplace Operations",
    body: "Standardized operational records for the marketplace side — campaigns, promotions, missions, and rewards — each running through one approval workflow with roll-down routing. Budgets and reward values are recorded here for humans to act on, not auto-spent. Log an operational record and route it for the right sign-off.",
  },

  // ── INTELLIGENCE ───────────────────────────────────────────────────────
  intelligence: {
    title: "Intelligence",
    body: "The analytics and AI cluster — Tony, the Copilot Fleet, the metrics floor, growth tooling, and the Executive Council. It's where the OS turns real numbers into briefs and recommendations. Use it to understand what's happening and what to do about it.",
  },
  "intelligence.tony": {
    title: "Tony",
    body: "Your always-on operations copilot and the live map of the whole business — every node is a real figure pulled from the OS. Click a node to drill into its details, or just ask Tony a question in plain language. Tony explains and drafts, but a human still approves anything that changes data.",
  },
  "intelligence.council": {
    title: "Executive AI Council",
    body: "A panel of AI officers that each read their own domain — finance, growth, operations, and more — and surface a grounded point of view for leadership. Every claim traces back to a real metric; nothing is invented. Run the council to get a fast, multi-angle read before a decision.",
  },
  "intelligence.cognition": {
    title: "Cognition Loop",
    body: "Tony reads a specific metric compartment against its targets, then drafts a grounded brief — the situation, the likely root cause, and three options with what/why/how and expected impact. The brief lands in the approval queue for a human to act on; it never executes on its own. Run it when you want a data-backed recommendation for a lagging area.",
  },

  // ── MONEY ──────────────────────────────────────────────────────────────
  money: {
    title: "Money",
    body: "The finance cluster — the profit-and-loss view, expenses, and budgets. Access is limited to leadership, matching the underlying data rules. Use it to see how the business and each pod are performing financially.",
  },
  "money.podPnl": {
    title: "Pod P&L",
    body: "Growth pods are the small cross-functional teams that each manage a set of brands. This view shows how brands are distributed across pods and how each pod is performing against its targets. Use it to balance workload and see which pods are driving growth.",
  },
  "money.podPnl.timeframe": {
    title: "Mixed timeframes — read as directional",
    body: "These figures don't share one period. Retainer is a monthly amount. GMV and everything derived from it (take revenue, revenue total, gross contribution) are synced-to-date totals — the sum of what's been pulled from each channel so far, not yet normalized to a calendar month. Read the P&L as a directional signal, not a closed monthly statement. Gross contribution is pre-labor: payroll isn't tracked in the OS, so net contribution and direct labor stay blank.",
  },
  "money.finance": {
    title: "Finance / P&L",
    body: "The leadership profit-and-loss view — revenue computed per brand by business model, with costs entered below to build the full picture. It also carries the cash-flow forecast and the P&L waterfall. Enter costs and read the margins to understand real profitability.",
  },

  // ── PEOPLE ─────────────────────────────────────────────────────────────
  people: {
    title: "People",
    body: "The people cluster — the contractor directory, payroll, daily logs, recruitment, the host/intern program, and recognition. It's the single source of truth every HR module reads from. Edit a person once here and the change flows everywhere it's used.",
  },
  "people.probation": {
    title: "Probation",
    body: "New hires start on a probation period with a set end date; the directory flags who's still probationary and how many days remain. When someone clears probation, leadership promotes them to permanent right here. Watch the probation flags so no one's review date slips.",
  },
  "people.contributors": {
    title: "Contributors",
    body: "Hosts and interns who help run lives without a full OS login — they get a private link whose token is their credential. Create a contributor, assign them a brand, hand over their link, and revoke access when they're done. Use this to manage everyone who supports live operations from the outside.",
  },
};

/** Resolve a help entry by id. Returns undefined for unknown ids so callers can
 *  render nothing rather than break — help is always additive. */
export function getHelp(id: string): HelpEntry | undefined {
  return HELP_REGISTRY[id];
}
