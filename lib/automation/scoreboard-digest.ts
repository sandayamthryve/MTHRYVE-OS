// lib/automation/scoreboard-digest.ts — the weekly Growth Scoreboard notification
// digest, rendered from the SAME scoreboard engine the /scoreboard page uses.
//
// Pure and DB-free: takes an already-computed Scoreboard and formats the compact
// leadership bell. Honesty rules carry over unchanged — a KPI that isn't
// measurable renders the em-dash (EMPTY), never a zero dressed up as data.

import { EMPTY, pesoCompact } from "@/lib/metrics/format";
import type { Scoreboard } from "@/lib/vesper/scoreboard";

export interface ScoreboardDigest {
  title: string;
  body: string;
}

const pct = (n: number | null | undefined): string =>
  n == null ? EMPTY : `${Math.round(n)}%`;

export function formatScoreboardDigest(board: Scoreboard): ScoreboardDigest {
  const o = board.org;

  const gmv = o.hasGmv ? pesoCompact(o.gmv) : EMPTY;
  const roas = o.roas != null ? `${o.roas.toFixed(2)}x` : EMPTY;
  const retention = pct(o.retentionPct);
  const concentration =
    o.concentrationPct != null
      ? `${pct(o.concentrationPct)} (${o.topClientName ?? "top client"})`
      : EMPTY;
  const contribution = o.contributionMeasurable && o.agencyRevenue != null ? pesoCompact(o.agencyRevenue) : EMPTY;

  // Top pod by GMV — only meaningful when at least one pod moved any GMV.
  const withGmv = board.pods.filter((p) => p.hasGmv).sort((a, b) => b.gmv - a.gmv);
  const topPod = withGmv[0];
  const podLine =
    board.pods.length > 0
      ? `${board.pods.length} pod${board.pods.length === 1 ? "" : "s"}` +
        (topPod ? ` · top: ${topPod.name} ${pesoCompact(topPod.gmv)}` : "")
      : "no pods yet";

  return {
    title: `Growth Scoreboard · ${o.windowLabel}`,
    body:
      `${o.brandsUnderManagement}/${o.totalBrands} brands under management · GMV ${gmv} · ROAS ${roas}. ` +
      `Agency revenue ${contribution} · concentration ${concentration} · retention ${retention}. ` +
      `${podLine}. Full board on the Growth Scoreboard.`,
  };
}
