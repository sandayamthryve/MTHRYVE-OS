// lib/people/review-gate-preview.ts — dev-channel-only sample rows for the HR
// Review Gate.
//
// The devchannel runs with AGENT_MOCK_MODE / DEV_CHANNEL_BYPASS_AUTH on and a
// fixed in-memory reviewer identity (lib/auth/dev-channel.ts), so there is no
// Supabase session and no action_requests to read. Without these rows the gate
// would always render its empty state and a reviewer could never SEE the queue.
//
// These are people-class examples — the class the DB derives for anything that
// touches a person's status. They are inert: cards marked preview_only resolve
// the tap in the browser and never call decideActionRequest, so nothing is
// written, executed, or audited. They are never used when a real session is
// present.

import type { ReviewGateItem } from "./review-gate";

export const REVIEW_GATE_PREVIEW: ReviewGateItem[] = [
  {
    id: "preview-probation",
    title: "Confirm 3 contractors past probation",
    agent: "Sentinel",
    source: "governance",
    sourceLabel: "People · Probation review",
    preview:
      "Three contractors reached their probation end date with supervisor sign-off on file. Approving moves them to permanent and unlocks full module access.",
    impact:
      "Impact: changes employment status for 3 people — leadership (CEO / COO) only. Reversible.",
    riskLabel: "L2 · Moderate",
    riskTier: 2,
    reversible: true,
    confidence: "88%",
    createdAt: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
    canDecide: true,
    recommendationOnly: false,
    problem:
      "Three probation windows lapsed this week with no decision filed. A lapsed window suspends the contractor's access automatically.",
    rootCause:
      "Probation decisions were tracked in a spreadsheet the supervisors updated, not in the OS, so nothing surfaced the deadline.",
    recommendation:
      "Confirm all three as permanent — each has a supervisor sign-off and no open performance flag.",
    evidence: [
      { label: "Probation lapsed", value: "3 contractors" },
      { label: "Supervisor sign-off", value: "3 of 3 on file" },
      { label: "Open performance flags", value: "None" },
    ],
    options: [
      { label: "Confirm all three", tradeoff: "Fastest; assumes the sign-offs are current." },
      { label: "Extend 30 days", tradeoff: "Buys review time but keeps access suspended." },
    ],
    preview_only: true,
  },
  {
    id: "preview-recruitment",
    title: "Send offer — Live Host (Basic City pod)",
    agent: "Prospector",
    source: "bizdev",
    sourceLabel: "People · Recruitment",
    preview:
      "Offer drafted at ₱24,000 base plus live commission, matching the approved band for the role. Approving sends the offer and opens onboarding.",
    impact:
      "Impact: commits a new headcount and a salary line — leadership (CEO / COO) only. Reversible until accepted.",
    riskLabel: "L3 · High risk",
    riskTier: 3,
    reversible: true,
    confidence: "76%",
    createdAt: new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
    canDecide: true,
    recommendationOnly: false,
    problem:
      "The Basic City pod has run one host short for four weeks, capping live hours below the schedule target.",
    rootCause: "The previous host left mid-probation and the requisition was never re-opened.",
    recommendation:
      "Send the offer at the band midpoint — the candidate cleared two live trials above the pod average.",
    evidence: [
      { label: "Live trials passed", value: "2 of 2" },
      { label: "Trial GMV vs pod avg", value: "+18%" },
      { label: "Band midpoint", value: "₱24,000" },
    ],
    options: [
      { label: "Send at midpoint", tradeoff: "Matches the band; no precedent set." },
      { label: "Send at band floor", tradeoff: "Saves ₱2K/mo but the candidate has a competing offer." },
    ],
    preview_only: true,
  },
  {
    id: "preview-leave",
    title: "Approve 5 leave requests — week of 22 Sep",
    agent: "Tony",
    source: "assistant",
    sourceLabel: "People · Leave",
    preview:
      "Five leave requests clear the coverage check — no pod drops below its minimum staffing on any requested day.",
    impact: "Impact: internal / operational — a department head can approve. Reversible.",
    riskLabel: "L1 · Low risk",
    riskTier: 1,
    reversible: true,
    confidence: "94%",
    createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    canDecide: true,
    recommendationOnly: false,
    problem: "Five requests sat unanswered past the 48-hour service level.",
    rootCause: "Leave approval had no queue — requests arrived by chat and were answered ad hoc.",
    recommendation: "Approve all five; coverage holds on every affected day.",
    evidence: [
      { label: "Requests", value: "5" },
      { label: "Coverage conflicts", value: "0" },
      { label: "Oldest waiting", value: "4 days" },
    ],
    options: [
      { label: "Approve all five", tradeoff: "Clears the backlog; coverage verified." },
      { label: "Approve four, hold one", tradeoff: "Keeps a buffer on the 24th at the cost of one reply." },
    ],
    preview_only: true,
  },
  {
    id: "preview-payroll",
    title: "Apply commission correction — 2 hosts · ₱11,400",
    agent: "Ledger",
    source: "finance",
    sourceLabel: "People · Payroll adjustment",
    preview:
      "Two live hosts were paid against the pre-July commission table. Approving files the back-pay correction onto the next payroll run.",
    impact: "Impact: closes a ₱11,400 gap. NOT reversible — approving is final.",
    riskLabel: "L3 · High risk",
    riskTier: 3,
    reversible: false,
    confidence: "91%",
    createdAt: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
    canDecide: true,
    recommendationOnly: false,
    problem:
      "Two hosts were underpaid across three cycles after the commission table changed in July.",
    rootCause:
      "The July table was applied to new hosts only; existing host records kept the old rate.",
    recommendation:
      "File the ₱11,400 correction as back-pay on the next run and re-point both records at the current table.",
    evidence: [
      { label: "Hosts affected", value: "2" },
      { label: "Cycles underpaid", value: "3" },
      { label: "Total owed", value: "₱11,400" },
    ],
    options: [
      { label: "Pay in full next run", tradeoff: "Correct and fast; hits one payroll line hard." },
      { label: "Split over two runs", tradeoff: "Smoother cash but leaves the shortfall open a month." },
    ],
    preview_only: true,
  },
];
