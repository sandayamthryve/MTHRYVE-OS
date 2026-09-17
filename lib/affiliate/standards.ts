// lib/affiliate/standards.ts — the affiliate performance-standard KPI (pure, no
// DB). It resolves a creator's tier, grades them against that tier's three-part
// standard (posting cadence, attributed GMV, follower band), and returns an
// honest verdict + badge the registry and detail views render, and the weekly
// "Scan standards" producer flags on.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, the OS
// EXECUTES. This module only computes and grades — it never writes, never sends,
// and NEVER fabricates: a missing input yields an explicit honest state
// ("no commitment set" / "no posts yet" / "untiered"), never a made-up 0 that
// would read as a real breach.
//
// The standard, per the creator's creator_tiers row:
//   (a) post_rate  >= required_post_rate_pct (the weekly bar, default 95%)
//   (b) attributed_gmv >= tier.min_gmv        (over tier.gmv_period)
//   (c) follower_count within the tier band   (min_following..max_following)
//
// POST RATE is WEEKLY: delivered = posted creator_posts in the ISO week (Mon–Sun,
// Asia/Manila); committed = creators.posts_committed (a per-week commitment);
// post_rate = delivered / committed (guarded against divide-by-zero).
//
// BADGE — a three-way severity overlay on the standard. The task's literal bands
// ("at risk 80–94%" vs "below <95%") overlap, so we reconcile them the only way
// that uses every number without contradiction: 95% is the bar, 80% is the
// at-risk floor for cadence, and 20% above the GMV floor is the at-risk cushion.
//   • BELOW STANDARD — a real breach: post_rate < 80%  OR  gmv < floor.
//   • AT RISK        — meeting the hard floors but slipping: post_rate 80–94%,
//                      OR gmv within 20% above floor, OR follower out of band.
//   • MEETS STANDARD — post_rate >= bar AND gmv >= floor AND follower in band.
// (The producer's DRAFT trigger is separate and simpler — see lib/actions/
// standards.ts: flag when post_rate < bar OR gmv < floor.)

// ── Tunables (one place so UI copy, badge and producer never drift) ───────────

export const DEFAULT_REQUIRED_POST_RATE_PCT = 95; // the weekly bar
export const AT_RISK_POST_RATE_FLOOR = 80; // below this = a real cadence breach
export const GMV_AT_RISK_CUSHION = 0.2; // within 20% above the GMV floor = at risk

// ── Row shapes (only the columns the KPI needs) ───────────────────────────────

export interface StandardCreator {
  id: string;
  name: string;
  handle: string | null;
  tier: string | null; // explicit tier override, if set
  follower_count: number | null;
  posts_committed: number | null; // WEEKLY commitment
  attributed_gmv: number | null;
  owner_id: string | null;
}

export interface TierRow {
  tier: string;
  rank: number;
  min_following: number | null; // null = unbounded below
  max_following: number | null; // null = unbounded above
  min_gmv: number | null; // null = no GMV floor for this tier
  gmv_period: string; // e.g. "monthly"
  required_post_rate_pct: number; // the weekly bar for this tier
}

// ── Verdict vocabulary ────────────────────────────────────────────────────────

export type StandardVerdict =
  | "meets" // MEETS STANDARD — all three parts satisfied
  | "at_risk" // AT RISK — meeting hard floors but a warning sign
  | "below" // BELOW STANDARD — a real breach on cadence or GMV
  | "no_commitment" // posts_committed not set — cadence can't be graded
  | "no_posts" // committed set but the creator has never posted — no data yet
  | "untiered"; // no tier could be resolved — can't grade the standard

export const VERDICT_LABEL: Record<StandardVerdict, string> = {
  meets: "Meets standard",
  at_risk: "At risk",
  below: "Below standard",
  no_commitment: "No commitment set",
  no_posts: "No posts yet",
  untiered: "Untiered",
};

// Badge tone for the verdict, reusing the shared Badge palette.
export type VerdictTone = "teal" | "amber" | "red" | "muted";
export function verdictTone(v: StandardVerdict): VerdictTone {
  switch (v) {
    case "meets":
      return "teal";
    case "at_risk":
      return "amber";
    case "below":
      return "red";
    default:
      return "muted"; // the honest "missing input" states are neutral, not alarming
  }
}

// Sort weight so the registry can rank worst-first (below > at risk > meets >
// missing-input states last).
export function verdictSeverity(v: StandardVerdict): number {
  switch (v) {
    case "below":
      return 4;
    case "at_risk":
      return 3;
    case "meets":
      return 2;
    default:
      return 1;
  }
}

// ── Delivery flag (on-track vs HOARDER) ───────────────────────────────────────
// A DELIVERY-ONLY read on top of the KPI: did the creator post at their tier's
// required cadence THIS week? This is deliberately narrower than the three-part
// standard — it ignores GMV and follower band and looks only at post rate vs the
// bar. "HOARDER" is the affiliate-manager vocabulary for a creator sitting on a
// deal/product without posting it out at the committed rate. It is a delivery
// signal, NOT a pay decision.
//
// Honest missing states never earn a HOARDER label: no weekly commitment, or a
// creator who has genuinely never posted, both read as "no data" so we don't
// brand a brand-new creator a hoarder on zero information.

export type DeliveryFlag = "on_track" | "hoarder" | "no_data";

export const DELIVERY_LABEL: Record<DeliveryFlag, string> = {
  on_track: "On track",
  hoarder: "Hoarder",
  no_data: "No data",
};

export function deliveryTone(f: DeliveryFlag): VerdictTone {
  switch (f) {
    case "on_track":
      return "teal";
    case "hoarder":
      return "red";
    default:
      return "muted";
  }
}

// The flag from a computed KPI. post_rate < required_post_rate_pct ⇒ HOARDER.
export function deliveryFlag(kpi: StandardKpi): DeliveryFlag {
  if (kpi.committed == null || kpi.committed <= 0) return "no_data"; // no commitment to grade
  if (kpi.verdict === "no_posts") return "no_data"; // committed but genuinely no data yet
  // meetsPostRate is boolean here (committed is set): rate >= bar ⇒ on track.
  return kpi.meetsPostRate ? "on_track" : "hoarder";
}

// ── Tier resolution ───────────────────────────────────────────────────────────
// Prefer the creator's explicit tier; else derive from follower_count against
// the bands. `null` on min/max_following means unbounded on that side. Bands are
// tried in rank order so an ambiguous overlap resolves deterministically to the
// lowest-rank match.

export type TierSource = "explicit" | "band";

export interface ResolvedTier {
  tier: TierRow;
  source: TierSource;
}

function followerInBand(count: number, tier: TierRow): boolean {
  if (tier.min_following != null && count < tier.min_following) return false;
  if (tier.max_following != null && count > tier.max_following) return false;
  return true;
}

export function resolveTier(
  creator: Pick<StandardCreator, "tier" | "follower_count">,
  tiers: TierRow[]
): ResolvedTier | null {
  const ordered = [...tiers].sort((a, b) => a.rank - b.rank);

  // 1) Explicit override — match the tier row by name (case-insensitive).
  const explicit = (creator.tier ?? "").trim().toLowerCase();
  if (explicit) {
    const row = ordered.find((t) => t.tier.trim().toLowerCase() === explicit);
    if (row) return { tier: row, source: "explicit" };
    // An explicit tier that names no known row still counts as "tiered" — build a
    // permissive synthetic row so we grade cadence without inventing a GMV/band.
    return {
      tier: {
        tier: creator.tier!.trim(),
        rank: 0,
        min_following: null,
        max_following: null,
        min_gmv: null,
        gmv_period: "monthly",
        required_post_rate_pct: DEFAULT_REQUIRED_POST_RATE_PCT,
      },
      source: "explicit",
    };
  }

  // 2) Derive from follower_count against the bands.
  if (creator.follower_count == null) return null;
  const match = ordered.find((t) => followerInBand(creator.follower_count!, t));
  return match ? { tier: match, source: "band" } : null;
}

// ── Post rate (weekly) ────────────────────────────────────────────────────────

// delivered / committed as a percent, guarded against divide-by-zero. Returns
// null when there is no committed count to divide by (so callers show an honest
// "no commitment set" rather than a fabricated rate).
export function postRatePct(delivered: number, committed: number | null): number | null {
  if (committed == null || committed <= 0) return null;
  return Math.round((delivered / committed) * 1000) / 10; // one decimal
}

// ── The computed KPI ──────────────────────────────────────────────────────────

export interface StandardKpi {
  creatorId: string;
  tierName: string | null; // resolved tier, or null when untiered
  tierSource: TierSource | null;
  committed: number | null; // weekly commitment
  delivered: number; // posted this ISO week
  postRatePct: number | null; // delivered/committed %, null when no commitment
  requiredPostRatePct: number; // the bar (from tier, else default)
  attributedGmv: number | null;
  minGmv: number | null; // the tier's GMV floor, if any
  gmvPeriod: string;
  followerCount: number | null;
  followerInBand: boolean | null; // null when untiered / follower unknown
  gmvGap: number | null; // max(0, floor - gmv) when both known
  meetsPostRate: boolean | null; // per-part results (null = can't assess)
  meetsGmv: boolean | null;
  meetsFollower: boolean | null;
  verdict: StandardVerdict;
}

export interface ComputeStandardInput {
  creator: StandardCreator;
  tiers: TierRow[];
  delivered: number; // posted creator_posts in the active ISO week
  hasEverPosted: boolean; // any posted creator_posts lifetime — distinguishes
  // "never posted, no data" from a real 0/N this week
}

export function computeStandardKpi(input: ComputeStandardInput): StandardKpi {
  const { creator, tiers, delivered, hasEverPosted } = input;
  const resolved = resolveTier(creator, tiers);
  const required = resolved?.tier.required_post_rate_pct ?? DEFAULT_REQUIRED_POST_RATE_PCT;
  const committed = creator.posts_committed ?? null;
  const rate = postRatePct(delivered, committed);
  const gmv = creator.attributed_gmv != null ? Number(creator.attributed_gmv) : null;
  const minGmv = resolved?.tier.min_gmv != null ? Number(resolved.tier.min_gmv) : null;
  const gmvGap = gmv != null && minGmv != null ? Math.max(0, minGmv - gmv) : null;

  const inBand =
    resolved == null || creator.follower_count == null
      ? null
      : followerInBand(creator.follower_count, resolved.tier);

  const meetsPostRate = rate == null ? null : rate >= required;
  const meetsGmv = gmv == null || minGmv == null ? null : gmv >= minGmv;
  const meetsFollower = inBand;

  const base: Omit<StandardKpi, "verdict"> = {
    creatorId: creator.id,
    tierName: resolved?.tier.tier ?? null,
    tierSource: resolved?.source ?? null,
    committed,
    delivered,
    postRatePct: rate,
    requiredPostRatePct: required,
    attributedGmv: gmv,
    minGmv,
    gmvPeriod: resolved?.tier.gmv_period ?? "monthly",
    followerCount: creator.follower_count ?? null,
    followerInBand: inBand,
    gmvGap,
    meetsPostRate,
    meetsGmv,
    meetsFollower,
  };

  return { ...base, verdict: gradeVerdict(base, hasEverPosted) };
}

// The badge verdict. Honest missing-input states first, then the three-way grade.
function gradeVerdict(k: Omit<StandardKpi, "verdict">, hasEverPosted: boolean): StandardVerdict {
  if (k.tierName == null) return "untiered";
  if (k.committed == null || k.committed <= 0) return "no_commitment";
  // committed is set but the creator has genuinely never posted — no data to
  // grade cadence on yet, so say so rather than reporting a 0% breach.
  if (!hasEverPosted && k.delivered === 0) return "no_posts";

  const rate = k.postRatePct ?? 0;
  const bar = k.requiredPostRatePct;

  // A real breach on either hard floor.
  const belowCadence = rate < Math.min(AT_RISK_POST_RATE_FLOOR, bar);
  const belowGmv = k.meetsGmv === false; // gmv < floor (only when both known)
  if (belowCadence || belowGmv) return "below";

  // Meeting the hard floors but showing a warning sign.
  const cadenceAtRisk = rate < bar; // in [floor, bar)
  const gmvAtRisk =
    k.meetsGmv === true && k.minGmv != null && k.attributedGmv != null
      ? k.attributedGmv < k.minGmv * (1 + GMV_AT_RISK_CUSHION)
      : false;
  const followerAtRisk = k.followerInBand === false;
  if (cadenceAtRisk || gmvAtRisk || followerAtRisk) return "at_risk";

  return "meets";
}
