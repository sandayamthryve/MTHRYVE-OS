import { describe, expect, it } from "vitest";
import {
  SLA_VIDEO_1_HOURS,
  SLA_VIDEO_2_HOURS,
  computeSampleSla,
  hoursRemaining,
  slaLabel,
  slaSeverity,
  type SlaInput,
} from "./sla";

// A fixed clock, so nothing here depends on when the suite runs.
const NOW = new Date("2026-09-17T12:00:00.000Z");
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

const sla = (over: Partial<SlaInput> = {}) =>
  computeSampleSla({ receivedAt: null, postedAt: [], now: NOW, ...over });

describe("the deck's turnaround SLA", () => {
  it("matches the deck: 72 hours to Video 1, then 48 to Video 2", () => {
    // Slide 9, read off the SLA snapshot. If these ever disagree with the deck
    // the rest of this file is measuring the wrong thing.
    expect(SLA_VIDEO_1_HOURS).toBe(72);
    expect(SLA_VIDEO_2_HOURS).toBe(48);
  });

  it("has no clock until the sample is received", () => {
    const status = sla();
    expect(status.state).toBe("awaiting_sample");
    expect(status.dueAt).toBeNull();
    expect(status.step).toBeNull();
    expect(slaLabel(status)).toBe("Not received");
  });

  it("starts Video 1's clock at receipt", () => {
    const status = sla({ receivedAt: hoursBefore(2) });
    expect(status.step).toBe("video_1");
    expect(status.state).toBe("on_track");
    // 72h window opened 2h ago.
    expect(hoursRemaining(status)).toBe(70);
    expect(status.dueAt?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });

  it("warns BEFORE the deadline, which is the deck's actual instruction", () => {
    // The deck says follow up with creators "approaching or past" their SLA, so
    // a flag that only fires after the breach would not satisfy it.
    expect(sla({ receivedAt: hoursBefore(47) }).state).toBe("on_track");
    expect(sla({ receivedAt: hoursBefore(48) }).state).toBe("approaching");
    expect(sla({ receivedAt: hoursBefore(71) }).state).toBe("approaching");
  });

  it("goes overdue exactly at the deadline, not after a grace period", () => {
    expect(sla({ receivedAt: hoursBefore(71.9) }).state).toBe("approaching");
    expect(sla({ receivedAt: hoursBefore(72) }).state).toBe("overdue");
    const late = sla({ receivedAt: hoursBefore(75) });
    expect(late.state).toBe("overdue");
    expect(hoursRemaining(late)).toBe(-3);
    expect(slaLabel(late)).toBe("Video 1 overdue by 3h");
  });

  it("moves to Video 2 once the first video is posted, timed from that posting", () => {
    // Posted 10h ago, so 38h of the 48h window remain — NOT counted from receipt.
    const status = sla({ receivedAt: hoursBefore(60), postedAt: [hoursBefore(10)] });
    expect(status.step).toBe("video_2");
    expect(hoursRemaining(status)).toBe(38);
    expect(slaLabel(status)).toBe("Video 2 due in 38h");
  });

  it("lets a late Video 1 carry Video 2's deadline with it", () => {
    // The consequence of reading the deck's 48h arrow as starting at Video 1:
    // this creator blew the first deadline but is on track for the second.
    const status = sla({ receivedAt: hoursBefore(100), postedAt: [hoursBefore(1)] });
    expect(status.step).toBe("video_2");
    expect(status.state).toBe("on_track");
    expect(hoursRemaining(status)).toBe(47);
  });

  it("is complete once both videos are posted, however late they were", () => {
    const status = sla({ receivedAt: hoursBefore(500), postedAt: [hoursBefore(400), hoursBefore(300)] });
    expect(status.state).toBe("complete");
    expect(status.step).toBeNull();
    expect(status.dueAt).toBeNull();
    expect(slaLabel(status)).toBe("Both videos posted");
  });

  it("treats the earliest posting as Video 1 whatever order it arrives in", () => {
    // affiliate_content has no ordinal — order is whatever the query returned.
    const ordered = sla({ receivedAt: hoursBefore(60), postedAt: [hoursBefore(10)] });
    const jumbled = sla({ receivedAt: hoursBefore(60), postedAt: [null, hoursBefore(10), undefined] });
    expect(jumbled).toEqual(ordered);
  });

  it("ignores nulls and unparseable timestamps rather than trusting them", () => {
    // A bad string must not become Invalid Date and poison every comparison.
    expect(sla({ receivedAt: "not a date" }).state).toBe("awaiting_sample");
    expect(sla({ receivedAt: "", postedAt: ["nonsense"] }).state).toBe("awaiting_sample");
    const status = sla({ receivedAt: hoursBefore(2), postedAt: ["nonsense", null] });
    expect(status.step).toBe("video_1");
  });

  it("does not invent a deadline for a video posted with no recorded receipt", () => {
    // Samples received before the received_at column existed. One video is up,
    // but nothing honest says when the clock started.
    const status = sla({ receivedAt: null, postedAt: [hoursBefore(5)] });
    expect(status.state).toBe("awaiting_sample");
    expect(status.dueAt).toBeNull();
  });

  it("sorts the ones worth chasing to the top", () => {
    const states = [
      sla({ receivedAt: hoursBefore(80) }), // overdue
      sla({ receivedAt: hoursBefore(50) }), // approaching
      sla({ receivedAt: hoursBefore(1) }), // on track
      sla(), // not received
      sla({ receivedAt: hoursBefore(500), postedAt: [hoursBefore(9), hoursBefore(8)] }), // complete
    ];
    const shuffled = [states[4], states[2], states[0], states[3], states[1]];
    expect(shuffled.sort((a, b) => slaSeverity(a) - slaSeverity(b)).map((s) => s.state)).toEqual([
      "overdue",
      "approaching",
      "on_track",
      "awaiting_sample",
      "complete",
    ]);
  });

  it("reads sensibly at the edges of an hour", () => {
    expect(slaLabel(sla({ receivedAt: hoursBefore(71.5) }))).toBe("Video 1 due within the hour");
    expect(slaLabel(sla({ receivedAt: hoursBefore(72.5) }))).toBe("Video 1 overdue");
  });
});
