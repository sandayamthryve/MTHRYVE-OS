// lib/automation/approval-sweep.test.ts — unit coverage for the daily Approval
// Sweep's pure decision logic (who escalates, who gets an outcome report) and
// the weekly scoreboard digest's honesty rules. No DB, no mocks.

import { describe, expect, it } from "vitest";
import {
  escalationCandidates,
  outcomeCandidates,
  OUTCOME_LABEL,
  outcomeSeverity,
  PENDING_STATES,
  type SweepRow,
} from "./approval-sweep";
import { formatScoreboardDigest } from "./scoreboard-digest";
import type { Scoreboard } from "@/lib/vesper/scoreboard";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-25T00:00:00.000Z");
const HOURS_AGO = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function row(overrides: Partial<SweepRow>): SweepRow {
  return {
    id: "req_1",
    title: "A request",
    status: "pending",
    created_at: HOURS_AGO(72),
    created_by: "filer",
    decided_by: null,
    decided_at: null,
    ...overrides,
  };
}

const emptyBoard = (): Scoreboard => ({
  window: { key: "mtd", start: "2026-08-01", end: "2026-08-25", label: "MTD" },
  org: {
    windowLabel: "MTD",
    totalBrands: 3,
    brandsUnderManagement: 2,
    activeBrands: 3,
    gmv: 0,
    hasGmv: false,
    roas: null,
    agencyRevenue: null,
    contributionMeasurable: false,
    concentrationPct: null,
    topClientName: null,
    retentionPct: null,
    churnedCount: null,
  },
  pods: [],
  unassignedBrandCount: 1,
});

// ── Escalation ─────────────────────────────────────────────────────────────────

describe("escalationCandidates", () => {
  it("escalates pendings at or past the threshold, with honest age", () => {
    const rows = [row({ id: "a", created_at: HOURS_AGO(48) }), row({ id: "b", created_at: HOURS_AGO(71) })];
    const out = escalationCandidates(rows, NOW, 48);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0].ageHours).toBe(48);
    expect(out[1].ageHours).toBe(71);
  });

  it("does NOT escalate below the threshold or non-pending states", () => {
    const rows = [
      row({ id: "fresh", created_at: HOURS_AGO(47) }),
      row({ id: "approved_old", status: "approved", created_at: HOURS_AGO(200), decided_by: "ceo", decided_at: HOURS_AGO(100) }),
      row({ id: "rejected_old", status: "rejected", created_at: HOURS_AGO(200), decided_by: "ceo", decided_at: HOURS_AGO(100) }),
    ];
    expect(escalationCandidates(rows, NOW, 48).map((r) => r.id)).toEqual([]);
  });

  it("includes the governed chain stages as pending", () => {
    const rows = [
      row({ id: "coo_stage", status: "pending_coo" }),
      row({ id: "ceo_stage", status: "pending_ceo" }),
    ];
    for (const s of ["pending_coo", "pending_ceo"]) {
      expect(PENDING_STATES.has(s)).toBe(true);
    }
    expect(escalationCandidates(rows, NOW, 48).map((r) => r.id).sort()).toEqual(["ceo_stage", "coo_stage"]);
  });

  it("returns nothing for a nonsense threshold (fails closed)", () => {
    expect(escalationCandidates([row({})], NOW, 0)).toEqual([]);
    expect(escalationCandidates([row({})], NOW, -5)).toEqual([]);
  });
});

// ── Outcome report-back ────────────────────────────────────────────────────────

describe("outcomeCandidates", () => {
  const since = HOURS_AGO(24);

  it("reports every terminal kind reached inside the window to the filer", () => {
    const kinds = ["approved", "executed", "failed", "rejected", "expired", "cancelled"];
    const rows = kinds.map((status, i) =>
      row({ id: `r${i}`, status, decided_by: "decider", decided_at: HOURS_AGO(2 + i) })
    );
    const out = outcomeCandidates(rows, since);
    expect(out.map((o) => o.kind).sort()).toEqual([...kinds].sort());
    expect(out.every((o) => o.row.created_by === "filer")).toBe(true);
  });

  it("never reports a decision that happened before the window or lacks a timestamp", () => {
    const rows = [
      row({ id: "old", status: "executed", decided_by: "d", decided_at: HOURS_AGO(30) }),
      row({ id: "no_ts", status: "executed", decided_by: "d", decided_at: null }),
    ];
    expect(outcomeCandidates(rows, since)).toEqual([]);
  });

  it("skips self-decided requests and still-pending states", () => {
    const rows = [
      row({ id: "self", status: "executed", created_by: "ceo", decided_by: "ceo", decided_at: HOURS_AGO(1) }),
      row({ id: "chain", status: "pending_ceo", created_at: HOURS_AGO(90) }),
    ];
    expect(outcomeCandidates(rows, since)).toEqual([]);
  });
});

describe("outcome labels & severity", () => {
  it("labels all six terminal kinds honestly", () => {
    expect(OUTCOME_LABEL.executed).toMatch(/approved & executed/);
    expect(OUTCOME_LABEL.failed).toMatch(/FAILED/);
    expect(OUTCOME_LABEL.rejected).toBe("rejected");
  });

  it("escalates severity for failed executions, warns on rejection", () => {
    expect(outcomeSeverity("failed")).toBe("critical");
    expect(outcomeSeverity("rejected")).toBe("warning");
    expect(outcomeSeverity("executed")).toBe("info");
  });
});

// ── Scoreboard digest honesty ──────────────────────────────────────────────────

describe("formatScoreboardDigest", () => {
  it("renders em-dashes for everything unmeasurable — never zeros dressed as data", () => {
    const d = formatScoreboardDigest(emptyBoard());
    expect(d.title).toContain("MTD");
    expect(d.body).toContain("GMV —");
    expect(d.body).toContain("ROAS —");
    expect(d.body).toContain("Agency revenue —");
    expect(d.body).toContain("concentration —");
    expect(d.body).toContain("retention —");
    expect(d.body).toContain("no pods yet");
    expect(d.body).not.toMatch(/GMV ₱?0\b/);
  });

  it("renders live figures when they exist and names the top pod by GMV", () => {
    const b = emptyBoard();
    b.org = {
      ...b.org,
      hasGmv: true,
      gmv: 1_500_000,
      roas: 2.4,
      agencyRevenue: 120_000,
      contributionMeasurable: true,
      concentrationPct: 41.6,
      topClientName: "Acme",
      retentionPct: 92.3,
    };
    b.pods = [
      {
        podId: "p1",
        name: "Pod North",
        leadName: null,
        status: "active",
        targetBrands: null,
        brandCount: 1,
        brandNames: ["Acme"],
        gmv: 900_000,
        hasGmv: true,
        roas: 2.4,
        agencyRevenue: null,
        contributionPct: null,
        concentrationPct: null,
      },
    ];
    const d = formatScoreboardDigest(b);
    expect(d.body).toContain("₱1.5M"); // pesoCompact of 1.5M (en-US compact, PHP)
    expect(d.body).toContain("2.40x");
    expect(d.body).toContain("Acme");
    expect(d.body).toContain("Pod North");
    expect(d.body).toContain("top: Pod North");
  });
});
