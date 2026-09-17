import type { BadgeTone } from "@/components/ui";

// The content turnaround SLA, from the affiliate onboarding deck (slide 9):
//
//   Sample Received --72 hrs--> Video 1 --48 hrs--> Video 2
//
// The deck's Monitoring stage asks to "follow up proactively with creators who
// are approaching or past their SLA", so this reports an approaching state
// before the deadline rather than only a breach after it.
//
// Nothing here writes or auto-chases. It turns timestamps into a status an
// operator can sort by — the same advisory-colouring posture as agingTone in
// domain.ts, on a different clock.

/** Hours from sample receipt to the first video. */
export const SLA_VIDEO_1_HOURS = 72;

/**
 * Hours from the FIRST video's posting to the second.
 *
 * The deck draws the 48h arrow from Video 1, not from receipt, so the second
 * clock starts when the first video actually goes up — which is also what an
 * operator chasing a creator would quote. The consequence worth knowing: a late
 * Video 1 moves Video 2's deadline with it, rather than compressing it.
 *
 * If the intent is instead a fixed schedule (receipt + 120h regardless), that
 * is a one-line change here plus the branch in computeSampleSla — the constant
 * is named for the reading it implements so the difference stays visible.
 */
export const SLA_VIDEO_2_HOURS = 48;

/**
 * How far into a window counts as "approaching".
 *
 * 0.66 matches agingTone's existing threshold in domain.ts, so the two SLAs in
 * this module warn at the same point in their windows. On the 72h clock that is
 * roughly 24 hours of notice.
 */
export const SLA_WARN_AT = 0.66;

const HOUR_MS = 60 * 60 * 1000;

export type SlaStep = "video_1" | "video_2";

export type SlaState =
  /** No receipt timestamp — the clock has not started (or predates the column). */
  | "awaiting_sample"
  | "on_track"
  | "approaching"
  | "overdue"
  /** Both videos posted. */
  | "complete";

export const SLA_STEP_LABEL: Record<SlaStep, string> = {
  video_1: "Video 1",
  video_2: "Video 2",
};

export interface SlaInput {
  /** affiliate_samples.received_at */
  receivedAt: string | null | undefined;
  /**
   * posted_at for this sample's content rows, in any order.
   *
   * Taken as a LIST rather than an explicit video1/video2 pair because that is
   * what the data is: affiliate_content carries sample_id and posted_at but no
   * ordinal, so "Video 1" means the earliest thing posted against the sample.
   * Nulls (not yet posted) and unparseable values are ignored.
   */
  postedAt: readonly (string | null | undefined)[];
  now: Date;
}

export interface SlaStatus {
  /** The outstanding step, or null when complete or not started. */
  step: SlaStep | null;
  state: SlaState;
  dueAt: Date | null;
  /** Negative once past due. Null when there is no live deadline. */
  msRemaining: number | null;
  tone: BadgeTone;
}

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Posting timestamps, valid ones only, earliest first. */
function postings(input: SlaInput): Date[] {
  return input.postedAt
    .map(parse)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
}

function stateFor(windowMs: number, msRemaining: number): Exclude<SlaState, "awaiting_sample" | "complete"> {
  if (msRemaining <= 0) return "overdue";
  // Elapsed as a fraction of the whole window.
  const elapsed = (windowMs - msRemaining) / windowMs;
  return elapsed >= SLA_WARN_AT ? "approaching" : "on_track";
}

const TONE: Record<SlaState, BadgeTone> = {
  awaiting_sample: "muted",
  on_track: "teal",
  approaching: "amber",
  overdue: "red",
  complete: "teal",
};

/**
 * Where a sample stands against the turnaround SLA.
 *
 * Two videos posted is complete regardless of timing — this answers "what is
 * outstanding and when is it due", which is what the Monitoring stage chases.
 * It does not grade delivered work as late after the fact.
 */
export function computeSampleSla(input: SlaInput): SlaStatus {
  const posted = postings(input);

  if (posted.length >= 2) {
    return { step: null, state: "complete", dueAt: null, msRemaining: null, tone: TONE.complete };
  }

  const received = parse(input.receivedAt);
  // A video posted before any receipt was recorded still counts as delivered —
  // but with no receipt there is no clock, so nothing is due.
  if (!received) {
    return {
      step: null,
      state: "awaiting_sample",
      dueAt: null,
      msRemaining: null,
      tone: TONE.awaiting_sample,
    };
  }

  const step: SlaStep = posted.length === 0 ? "video_1" : "video_2";
  const windowMs = (step === "video_1" ? SLA_VIDEO_1_HOURS : SLA_VIDEO_2_HOURS) * HOUR_MS;
  // Video 1 runs from receipt; Video 2 from when Video 1 actually went up.
  const start = step === "video_1" ? received : posted[0];
  const dueAt = new Date(start.getTime() + windowMs);
  const msRemaining = dueAt.getTime() - input.now.getTime();
  const state = stateFor(windowMs, msRemaining);

  return { step, state, dueAt, msRemaining, tone: TONE[state] };
}

/** Whole hours remaining, rounded toward zero; negative once past due. */
export function hoursRemaining(status: SlaStatus): number | null {
  return status.msRemaining == null ? null : Math.trunc(status.msRemaining / HOUR_MS);
}

/** A short phrase for a badge: "Video 1 due in 14h", "Video 2 overdue by 3h". */
export function slaLabel(status: SlaStatus): string {
  if (status.state === "complete") return "Both videos posted";
  if (status.state === "awaiting_sample" || status.step == null) return "Not received";

  const label = SLA_STEP_LABEL[status.step];
  const hours = hoursRemaining(status) ?? 0;
  if (status.state === "overdue") {
    const over = Math.abs(hours);
    // Under an hour past due still reads as overdue, not "0h".
    return over < 1 ? `${label} overdue` : `${label} overdue by ${over}h`;
  }
  return hours < 1 ? `${label} due within the hour` : `${label} due in ${hours}h`;
}

/** Sort key: the most urgent first — overdue, then approaching, then the rest. */
export function slaSeverity(status: SlaStatus): number {
  switch (status.state) {
    case "overdue":
      return 0;
    case "approaching":
      return 1;
    case "on_track":
      return 2;
    case "awaiting_sample":
      return 3;
    case "complete":
      return 4;
  }
}
