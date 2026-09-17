"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const REF_W = 1440;
const MIN_S = 0.22;
const MAX_S = 1.6;
const DH_MIN = 700;
const DH_MAX = 1600;
const STEPS = [0.25, 0.33, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.6] as const;

const viewportWidth = () => document.documentElement.clientWidth || window.innerWidth;
const viewportHeight = () => window.visualViewport?.height || window.innerHeight;
const clampScale = (value: number) => Math.min(MAX_S, Math.max(MIN_S, value));

export function DevZoomDock() {
  const userScale = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [auto, setAuto] = useState(true);
  const autoScale = useCallback(() => clampScale(viewportWidth() / REF_W), []);

  const fit = useCallback(() => {
    const stage = document.getElementById("dev-os-stage");
    const viewport = document.getElementById("dev-os-viewport");
    const chrome = document.getElementById("dev-os-chrome");
    if (!stage || !viewport || !chrome) return;
    const scale = userScale.current !== null ? userScale.current : autoScale();
    const vw = viewportWidth();
    const vh = viewportHeight();
    const designHeight = Math.max(DH_MIN, Math.min(DH_MAX, vh / scale));
    const scaledWidth = REF_W * scale;

    // Measure the real page content instead of clipping the stage to one screen.
    stage.style.width = `${REF_W}px`;
    stage.style.height = "auto";
    stage.style.minHeight = `${designHeight}px`;
    stage.style.transform = `scale(${scale})`;
    stage.style.transformOrigin = "top left";
    const contentHeight = Math.max(designHeight, stage.scrollHeight);
    const scaledHeight = contentHeight * scale;
    const offsetX = Math.max(0, (vw - scaledWidth) / 2);
    // Never vertically center a page taller than the screen; doing so makes its lower content unreachable.
    const offsetY = scaledHeight <= vh ? Math.max(0, (vh - scaledHeight) / 2) : 0;

    viewport.style.width = `${scaledWidth}px`;
    viewport.style.height = `${scaledHeight}px`;
    viewport.style.marginLeft = `${offsetX}px`;
    viewport.style.marginTop = `${offsetY}px`;
    chrome.style.width = `${REF_W}px`;
    chrome.style.height = `${designHeight}px`;
    chrome.style.left = `${offsetX}px`;
    chrome.style.top = `${offsetY}px`;
    chrome.style.transform = `scale(${scale})`;
    chrome.style.transformOrigin = "top left";
    setZoom(scale); setAuto(userScale.current === null);
  }, [autoScale]);

  const stepZoom = (direction: 1 | -1) => { const current = userScale.current !== null ? userScale.current : autoScale(); let next = current; if (direction > 0) { for (const value of STEPS) { if (value > current + 0.001) { next = value; break; } } } else { for (let index = STEPS.length - 1; index >= 0; index -= 1) { if (STEPS[index] < current - 0.001) { next = STEPS[index]; break; } } } userScale.current = clampScale(next); fit(); };
  const fitReset = () => { userScale.current = null; fit(); };

  useEffect(() => {
    fit();
    let orientationTimer: number | undefined;
    const onResize = () => fit();
    const onOrientationChange = () => { if (orientationTimer) window.clearTimeout(orientationTimer); orientationTimer = window.setTimeout(fit, 140); };
    window.addEventListener("resize", onResize); window.addEventListener("orientationchange", onOrientationChange); window.visualViewport?.addEventListener("resize", onResize);
    return () => { if (orientationTimer) window.clearTimeout(orientationTimer); window.removeEventListener("resize", onResize); window.removeEventListener("orientationchange", onOrientationChange); window.visualViewport?.removeEventListener("resize", onResize); };
  }, [fit]);

  return <div aria-label="Zoom controls" className={`group fixed bottom-3 left-3 z-[90] flex h-9 w-9 items-center overflow-hidden rounded-full border border-[#1e2a35] bg-[#0d141b]/95 p-[3px] shadow-[0_4px_18px_rgba(0,0,0,.5)] backdrop-blur-lg transition-[width,border-color,box-shadow] duration-200 hover:w-[151px] hover:border-[#2b3b49] hover:shadow-[0_6px_22px_rgba(0,0,0,.56)] focus-within:w-[151px] ${auto ? "text-teal-300" : ""}`}><span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-extrabold text-teal-300">⌕</span><div className="ml-[3px] flex min-w-[110px] -translate-x-[5px] items-center gap-px opacity-0 pointer-events-none transition duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100 group-focus-within:pointer-events-auto"><button type="button" onClick={() => stepZoom(-1)} title="Zoom out" aria-label="Zoom out" className="h-[26px] w-6 rounded-lg text-xs font-extrabold text-ink-muted hover:bg-[#111820] hover:text-teal-300">−</button><span className={`min-w-[34px] text-center text-[10px] font-extrabold tabular-nums ${auto ? "text-teal-300" : "text-ink-muted"}`}>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => stepZoom(1)} title="Zoom in" aria-label="Zoom in" className="h-[26px] w-6 rounded-lg text-xs font-extrabold text-ink-muted hover:bg-[#111820] hover:text-teal-300">+</button><button type="button" onClick={fitReset} title="Fit the whole width to this screen" aria-label="Reset zoom to fit" className="h-[26px] w-6 rounded-lg text-xs font-extrabold text-ink-muted hover:bg-[#111820] hover:text-teal-300">⤢</button></div></div>;
}
