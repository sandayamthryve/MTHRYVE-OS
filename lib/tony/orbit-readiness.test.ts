import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchOrbitReadiness } from "./orbit-readiness";

// A host window/document pair small enough to drive by hand.
//
// The bug this covers shipped to production: /tony painted "space view could
// not start" over a scene that had loaded fine. orbit.js stops its render loop
// while the tab is hidden, and only reports readiness once its 3.6s arrival
// animation settles — so a hidden tab never reports, while the old wall-clock
// deadline ran on regardless and called it a failure.
function harness({ visibility = "visible" as DocumentVisibilityState } = {}) {
  const messageListeners: ((event: MessageEvent) => void)[] = [];
  const visibilityListeners: (() => void)[] = [];
  const posted: unknown[] = [];

  const frame = {
    postMessage: (data: unknown) => posted.push(data),
  } as unknown as Window;

  const doc = {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, fn: () => void) => {
      if (type === "visibilitychange") visibilityListeners.push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type !== "visibilitychange") return;
      const i = visibilityListeners.indexOf(fn);
      if (i >= 0) visibilityListeners.splice(i, 1);
    },
  };

  const hostWindow = {
    document: doc,
    location: { origin: "https://example.test" },
    addEventListener: (type: string, fn: (event: MessageEvent) => void) => {
      if (type === "message") messageListeners.push(fn);
    },
    removeEventListener: (type: string, fn: (event: MessageEvent) => void) => {
      if (type !== "message") return;
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
    },
  } as unknown as Window;

  return {
    hostWindow,
    frame,
    posted,
    setVisibility(next: DocumentVisibilityState) {
      visibility = next;
      for (const fn of [...visibilityListeners]) fn();
    },
    /** Deliver a message as the orbit frame would. */
    reply(ready: boolean, over: { source?: unknown; origin?: string } = {}) {
      const event = {
        source: frame,
        origin: over.origin ?? "https://example.test",
        data: { source: over.source ?? "tony-orbit", ready },
      } as unknown as MessageEvent;
      for (const fn of [...messageListeners]) fn(event);
    },
    listenerCounts: () => ({ message: messageListeners.length, visibility: visibilityListeners.length }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchOrbitReadiness", () => {
  it("settles ready when the frame reports in", () => {
    const h = harness();
    const onSettled = vi.fn();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled });

    h.reply(true);
    expect(onSettled).toHaveBeenCalledWith(true);
  });

  it("fails after the timeout when the tab stays visible and nothing reports", () => {
    const h = harness();
    const onSettled = vi.fn();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled, timeoutMs: 15000 });

    vi.advanceTimersByTime(14999);
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledWith(false);
  });

  it("does NOT fail while the tab is hidden — the regression", () => {
    // This is the production bug: hidden the whole time, so the scene never got
    // a chance to start, and the old watcher called that a failure.
    const h = harness({ visibility: "hidden" });
    const onSettled = vi.fn();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled, timeoutMs: 15000 });

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("starts its budget when the tab becomes visible", () => {
    const h = harness({ visibility: "hidden" });
    const onSettled = vi.fn();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled, timeoutMs: 15000 });

    vi.advanceTimersByTime(60000);
    expect(onSettled).not.toHaveBeenCalled();

    h.setVisibility("visible");
    vi.advanceTimersByTime(14999);
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettled).toHaveBeenCalledWith(false);
  });

  it("spends the budget only while visible, across several switches", () => {
    const h = harness();
    const onSettled = vi.fn();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled, timeoutMs: 15000 });

    // 6s visible, a long hidden stretch, then 6s visible = 12s spent.
    vi.advanceTimersByTime(6000);
    h.setVisibility("hidden");
    vi.advanceTimersByTime(5 * 60 * 1000);
    h.setVisibility("visible");
    vi.advanceTimersByTime(6000);
    expect(onSettled).not.toHaveBeenCalled();

    // The remaining 3s of budget then runs out.
    vi.advanceTimersByTime(3000);
    expect(onSettled).toHaveBeenCalledWith(false);
  });

  it("still accepts a ready report that arrives while hidden", () => {
    // The scene may have finished before the tab was hidden; the poll keeps
    // asking, so the answer must still count.
    const h = harness({ visibility: "hidden" });
    const onSettled = vi.fn();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled });

    vi.advanceTimersByTime(30000);
    h.reply(true);
    expect(onSettled).toHaveBeenCalledWith(true);
  });

  it("passes a genuine failure through", () => {
    // orbit.js reports ready:false when WebGL is unavailable or the loop dies.
    const h = harness();
    const onSettled = vi.fn();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled });

    h.reply(false);
    expect(onSettled).toHaveBeenCalledWith(false);
  });

  it("ignores messages from the wrong origin, sender or shape", () => {
    const h = harness();
    const onSettled = vi.fn();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled });

    h.reply(true, { origin: "https://evil.test" });
    h.reply(true, { source: "not-tony-orbit" });
    expect(onSettled).not.toHaveBeenCalled();

    h.reply(true);
    expect(onSettled).toHaveBeenCalledWith(true);
  });

  it("removes both listeners when disposed, and never settles after", () => {
    const h = harness();
    const onSettled = vi.fn();
    const dispose = watchOrbitReadiness({
      hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled, timeoutMs: 15000,
    });

    expect(h.listenerCounts()).toEqual({ message: 1, visibility: 1 });
    dispose();
    expect(h.listenerCounts()).toEqual({ message: 0, visibility: 0 });

    vi.advanceTimersByTime(60000);
    h.reply(true);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("probes the frame so an already-finished scene is picked up", () => {
    const h = harness();
    watchOrbitReadiness({ hostWindow: h.hostWindow, getFrameWindow: () => h.frame, onSettled: () => {} });

    // One immediately, then on the poll.
    expect(h.posted.length).toBe(1);
    vi.advanceTimersByTime(750);
    expect(h.posted.length).toBeGreaterThan(1);
    expect(h.posted[0]).toEqual({ source: "tony-host", action: "ready" });
  });
});
