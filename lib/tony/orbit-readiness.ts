type OrbitReadinessOptions = {
  hostWindow: Window;
  getFrameWindow: () => Window | null;
  onSettled: (ready: boolean) => void;
  timeoutMs?: number;
};

/**
 * One watcher per scene mount/retry. Probing recovers an early cached-frame message.
 *
 * The timeout is spent in VISIBLE time, not wall-clock time, and that is the
 * whole point of it.
 *
 * orbit.js only reports readiness once its arrival animation settles — roughly
 * 3.6 seconds into the render loop — and it stops that loop on `document.hidden`
 * (correctly: nothing should animate a tab nobody is looking at). So a hidden
 * tab makes no progress toward ready. A wall-clock deadline kept running
 * through that and declared the scene broken after 15 seconds, painting
 * "Tony's space view could not start" over a scene that had loaded perfectly
 * and was merely paused. Opening /tony in a background tab reproduced it every
 * time; so did switching away during the intro.
 *
 * Pausing the deadline while hidden makes the budget measure what it was always
 * meant to measure: time the scene actually had in which to start.
 */
export function watchOrbitReadiness({
  hostWindow, getFrameWindow, onSettled, timeoutMs = 15000,
}: OrbitReadinessOptions): () => void {
  const hostDocument = hostWindow.document;
  let active = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  /** Visible milliseconds already spent waiting. */
  let spent = 0;
  /** When the current visible stretch began; null while hidden. */
  let visibleSince: number | null = null;

  const hidden = () => hostDocument.visibilityState === "hidden";

  function dispose() {
    active = false;
    clearTimeout(timeout);
    clearInterval(poll);
    hostWindow.removeEventListener("message", onMessage);
    hostDocument.removeEventListener("visibilitychange", onVisibility);
  }
  function settle(ready: boolean) {
    if (!active) return;
    dispose();
    onSettled(ready);
  }
  function onMessage(event: MessageEvent) {
    const frame = getFrameWindow();
    if (!frame || event.source !== frame || event.origin !== hostWindow.location.origin) return;
    if (event.data?.source !== "tony-orbit" || typeof event.data.ready !== "boolean") return;
    settle(event.data.ready);
  }
  function probe() {
    getFrameWindow()?.postMessage({ source: "tony-host", action: "ready" }, hostWindow.location.origin);
  }

  /** Arm the deadline for whatever budget remains — only while visible. */
  function arm() {
    clearTimeout(timeout);
    if (hidden()) {
      visibleSince = null;
      return;
    }
    visibleSince = Date.now();
    timeout = setTimeout(() => settle(false), Math.max(0, timeoutMs - spent));
  }

  function onVisibility() {
    if (!active) return;
    if (hidden()) {
      // Bank the stretch that just ended and stop the clock.
      if (visibleSince !== null) spent += Date.now() - visibleSince;
      visibleSince = null;
      clearTimeout(timeout);
      return;
    }
    arm();
  }

  hostWindow.addEventListener("message", onMessage);
  hostDocument.addEventListener("visibilitychange", onVisibility);
  // Keep probing even while hidden: it costs nothing, and a scene that did
  // finish before the tab was hidden is then picked up the moment we ask.
  poll = setInterval(probe, 250);
  arm();
  probe();
  return dispose;
}
