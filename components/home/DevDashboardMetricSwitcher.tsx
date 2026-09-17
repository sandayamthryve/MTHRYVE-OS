"use client";

import { useEffect } from "react";

type DashboardPane = {
  key: string;
  title: string;
  html?: string;
};

type RangePreset = {
  key: string;
  label: string;
};

const RANGE_PRESETS: readonly RangePreset[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 Days" },
  { key: "mtd", label: "Month to Date" },
  { key: "monthly", label: "Monthly" },
  { key: "qtd", label: "Quarter to Date" },
  { key: "ytd", label: "Year to Date" },
  { key: "custom", label: "Custom Date" },
];

const panes: readonly DashboardPane[] = [
  {
    key: "gmv",
    title: "Gross Merchandise Value",
  },
  {
    key: "agents",
    title: "Agents Live",
    html: `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:#8b9aa8">Agents Live</div>
        <div style="font-size:18px;line-height:1">🤖</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:auto;margin-bottom:auto">
        <div style="border:1px solid #1e2a35;background:#0d141b;border-radius:14px;padding:14px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(45,212,191,.16);color:#2dd4bf;font-weight:800">A</div>
            <div><div style="font-size:13px;font-weight:800;color:#e9f0f6">Atlas</div><div style="font-size:10.5px;color:#8b9aa8">Orchestrator</div></div>
            <span style="width:9px;height:9px;border-radius:50%;background:#3ecf8e;box-shadow:0 0 0 4px rgba(62,207,142,.12);margin-left:auto"></span>
          </div>
          <p style="margin-top:11px;font-size:11.5px;line-height:1.5;color:#8b9aa8">Dispatches the daily run, routes work to the team, holds the plan.</p>
        </div>
        <div style="border:1px solid #1e2a35;background:#0d141b;border-radius:14px;padding:14px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(90,169,230,.16);color:#5aa9e6;font-weight:800">P</div>
            <div><div style="font-size:13px;font-weight:800;color:#e9f0f6">Prospector</div><div style="font-size:10.5px;color:#8b9aa8">Lead-Gen</div></div>
            <span style="width:9px;height:9px;border-radius:50%;background:#3ecf8e;box-shadow:0 0 0 4px rgba(62,207,142,.12);margin-left:auto"></span>
          </div>
          <p style="margin-top:11px;font-size:11.5px;line-height:1.5;color:#8b9aa8">Sources qualified brand and partner leads across platforms daily.</p>
        </div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:11px;font-weight:700;color:#8b9aa8"><span>● TikTok 46%</span><span>● Shopee 33%</span><span>● Lazada 21%</span></div>
    `,
  },
  {
    key: "review",
    title: "In Review Gate",
    html: `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:#8b9aa8">In Review Gate</div>
        <div style="font-size:18px;line-height:1">🛡️</div>
      </div>
      <div style="font-size:28px;font-weight:800;letter-spacing:-.5px;color:#e9f0f6;margin-bottom:18px">6</div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div><div style="display:flex;justify-content:space-between;font-size:11px;color:#8b9aa8;margin-bottom:6px"><span>Needs review</span><b style="color:#f5b942">3</b></div><div style="height:7px;border-radius:999px;background:#0d141b;overflow:hidden"><div style="width:50%;height:100%;background:#f5b942;border-radius:999px"></div></div></div>
        <div><div style="display:flex;justify-content:space-between;font-size:11px;color:#8b9aa8;margin-bottom:6px"><span>Waiting on owner</span><b style="color:#a78bfa">2</b></div><div style="height:7px;border-radius:999px;background:#0d141b;overflow:hidden"><div style="width:33%;height:100%;background:#a78bfa;border-radius:999px"></div></div></div>
        <div><div style="display:flex;justify-content:space-between;font-size:11px;color:#8b9aa8;margin-bottom:6px"><span>Ready to approve</span><b style="color:#3ecf8e">1</b></div><div style="height:7px;border-radius:999px;background:#0d141b;overflow:hidden"><div style="width:17%;height:100%;background:#3ecf8e;border-radius:999px"></div></div></div>
      </div>
    `,
  },
  {
    key: "leads",
    title: "Leads",
    html: `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:#8b9aa8">Leads</div>
        <div style="font-size:18px;line-height:1">🎯</div>
      </div>
      <div style="display:flex;align-items:flex-end;gap:10px;margin-bottom:18px"><div style="font-size:28px;font-weight:800;letter-spacing:-.5px;color:#e9f0f6">11</div><div style="padding-bottom:4px;font-size:10.5px;color:#8b9aa8">today</div></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        <div style="border:1px solid #1e2a35;background:#0d141b;border-radius:12px;padding:12px"><div style="font-size:10px;color:#8b9aa8">Qualified</div><div style="margin-top:5px;font-size:18px;font-weight:800;color:#2dd4bf">6</div></div>
        <div style="border:1px solid #1e2a35;background:#0d141b;border-radius:12px;padding:12px"><div style="font-size:10px;color:#8b9aa8">Contacted</div><div style="margin-top:5px;font-size:18px;font-weight:800;color:#5aa9e6">3</div></div>
        <div style="border:1px solid #1e2a35;background:#0d141b;border-radius:12px;padding:12px"><div style="font-size:10px;color:#8b9aa8">New</div><div style="margin-top:5px;font-size:18px;font-weight:800;color:#f5b942">2</div></div>
      </div>
    `,
  },
];

function isoToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthStart() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function compactDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

export function DevDashboardMetricSwitcher() {
  useEffect(() => {
    const stage = document.getElementById("dev-os-stage");
    if (!stage) return;

    const sections = Array.from(stage.querySelectorAll("section"));
    const kpiSection = sections.find((section) => {
      const text = section.textContent ?? "";
      return text.includes("Gross Merchandise Value") && text.includes("Agents Live") && text.includes("In Review Gate") && text.includes("Leads");
    }) as HTMLElement | undefined;
    const detailSection = sections.find((section) => {
      const text = section.textContent ?? "";
      return text.includes("Gross Merchandise Value") && text.includes("TikTok 46%") && text.includes("Shopee 33%");
    }) as HTMLElement | undefined;
    if (!kpiSection || !detailSection) return;

    const metricsWrap = kpiSection.querySelector(":scope > .relative") as HTMLElement | null;
    const metricNodes = metricsWrap ? (Array.from(metricsWrap.children).slice(0, 4) as HTMLElement[]) : [];
    if (!metricsWrap || metricNodes.length !== 4) return;

    // The four KPI items should read as four evenly spaced rows. Using a fixed
    // distribution area avoids the Monthly/Today pills changing perceived gaps.
    const previousMetricsWrapStyle = metricsWrap.getAttribute("style");
    Object.assign(metricsWrap.style, {
      display: "flex",
      flexDirection: "column",
      height: "270px",
      justifyContent: "space-between",
    });
    metricNodes.forEach((node) => {
      node.style.margin = "0";
      node.style.flex = "0 0 auto";
    });

    // Turn the existing Monthly/Today badges into an expanding range picker.
    // The picker is rendered as a floating overlay so it can grow horizontally
    // beyond the narrow KPI card without changing the card layout.
    const rangePills = metricNodes.flatMap((node) => {
      const labelRow = node.firstElementChild as HTMLElement | null;
      if (!labelRow) return [];
      const pill = Array.from(labelRow.children).find((child) => {
        const text = (child.textContent ?? "").trim();
        return text === "Monthly" || text === "Today";
      });
      return pill instanceof HTMLElement ? [pill] : [];
    });

    const rangeState = new WeakMap<HTMLElement, { key: string; start?: string; end?: string }>();
    rangePills.forEach((pill) => {
      const initial = (pill.textContent ?? "").trim();
      rangeState.set(pill, { key: initial === "Today" ? "today" : "monthly" });
      pill.setAttribute("role", "button");
      pill.setAttribute("tabindex", "0");
      pill.setAttribute("aria-haspopup", "listbox");
      pill.setAttribute("aria-expanded", "false");
      pill.style.cursor = "ew-resize";
      pill.style.userSelect = "none";
    });

    const rangeBar = document.createElement("div");
    rangeBar.setAttribute("data-dev-range-bar", "true");
    Object.assign(rangeBar.style, {
      position: "fixed",
      display: "none",
      alignItems: "center",
      height: "26px",
      width: "390px",
      maxWidth: "calc(100vw - 16px)",
      overflow: "hidden",
      border: "1px solid #243540",
      borderRadius: "999px",
      background: "rgba(13,20,27,.98)",
      boxShadow: "0 10px 28px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.035)",
      zIndex: "120",
      padding: "2px 20px",
      backdropFilter: "blur(14px)",
    });

    const leftHint = document.createElement("div");
    leftHint.textContent = "‹";
    Object.assign(leftHint.style, {
      position: "absolute",
      left: "4px",
      top: "50%",
      transform: "translateY(-50%)",
      color: "#617887",
      fontSize: "14px",
      lineHeight: "1",
      pointerEvents: "none",
      zIndex: "2",
    });
    rangeBar.appendChild(leftHint);

    const rightHint = document.createElement("div");
    rightHint.textContent = "›";
    Object.assign(rightHint.style, {
      position: "absolute",
      right: "4px",
      top: "50%",
      transform: "translateY(-50%)",
      color: "#617887",
      fontSize: "14px",
      lineHeight: "1",
      pointerEvents: "none",
      zIndex: "2",
    });
    rangeBar.appendChild(rightHint);

    const rangeScroller = document.createElement("div");
    rangeScroller.setAttribute("role", "listbox");
    Object.assign(rangeScroller.style, {
      display: "flex",
      alignItems: "center",
      gap: "4px",
      width: "100%",
      overflowX: "auto",
      overflowY: "hidden",
      scrollbarWidth: "none",
      cursor: "grab",
      userSelect: "none",
      touchAction: "pan-y",
    });
    rangeBar.appendChild(rangeScroller);

    const rangeButtons = RANGE_PRESETS.map((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.rangeKey = preset.key;
      button.textContent = preset.label;
      button.setAttribute("role", "option");
      Object.assign(button.style, {
        flex: "0 0 auto",
        height: "20px",
        border: "0",
        borderRadius: "999px",
        padding: "0 8px",
        background: "transparent",
        color: "#9aa9b5",
        fontSize: "10px",
        fontWeight: "750",
        lineHeight: "20px",
        whiteSpace: "nowrap",
        cursor: "pointer",
      });
      rangeScroller.appendChild(button);
      return button;
    });

    const calendar = document.createElement("div");
    calendar.setAttribute("data-dev-range-calendar", "true");
    Object.assign(calendar.style, {
      position: "fixed",
      display: "none",
      width: "318px",
      maxWidth: "calc(100vw - 16px)",
      border: "1px solid #243540",
      borderRadius: "14px",
      background: "rgba(13,20,27,.99)",
      boxShadow: "0 18px 45px rgba(0,0,0,.58)",
      zIndex: "130",
      padding: "12px",
      color: "#e9f0f6",
      backdropFilter: "blur(16px)",
    });

    const calendarTitle = document.createElement("div");
    calendarTitle.textContent = "Custom date range";
    Object.assign(calendarTitle.style, {
      marginBottom: "10px",
      fontSize: "12px",
      fontWeight: "800",
      color: "#e9f0f6",
    });
    calendar.appendChild(calendarTitle);

    const fields = document.createElement("div");
    Object.assign(fields.style, {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "8px",
    });
    calendar.appendChild(fields);

    const makeDateField = (labelText: string) => {
      const label = document.createElement("label");
      Object.assign(label.style, { display: "grid", gap: "5px" });
      const caption = document.createElement("span");
      caption.textContent = labelText;
      Object.assign(caption.style, { fontSize: "9px", fontWeight: "750", color: "#8b9aa8", textTransform: "uppercase", letterSpacing: ".55px" });
      const input = document.createElement("input");
      input.type = "date";
      Object.assign(input.style, {
        width: "100%",
        height: "32px",
        boxSizing: "border-box",
        border: "1px solid #2b3a46",
        borderRadius: "9px",
        background: "#0a1117",
        color: "#e9f0f6",
        colorScheme: "dark",
        padding: "0 7px",
        fontSize: "11px",
        outline: "none",
      });
      label.append(caption, input);
      fields.appendChild(label);
      return input;
    };

    const startInput = makeDateField("Start date");
    const endInput = makeDateField("End date");
    startInput.value = monthStart();
    endInput.value = isoToday();
    endInput.min = startInput.value;
    endInput.max = isoToday();
    startInput.max = isoToday();

    const calendarActions = document.createElement("div");
    Object.assign(calendarActions.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "7px",
      marginTop: "11px",
    });
    calendar.appendChild(calendarActions);

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    Object.assign(cancelButton.style, {
      height: "28px",
      border: "1px solid #283943",
      borderRadius: "8px",
      background: "#101920",
      color: "#9aa9b5",
      padding: "0 10px",
      fontSize: "10px",
      fontWeight: "750",
      cursor: "pointer",
    });
    calendarActions.appendChild(cancelButton);

    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.textContent = "Apply range";
    Object.assign(applyButton.style, {
      height: "28px",
      border: "1px solid rgba(45,212,191,.35)",
      borderRadius: "8px",
      background: "rgba(45,212,191,.9)",
      color: "#03211e",
      padding: "0 10px",
      fontSize: "10px",
      fontWeight: "850",
      cursor: "pointer",
    });
    calendarActions.appendChild(applyButton);

    document.body.append(rangeBar, calendar);

    let activePill: HTMLElement | null = null;
    let hideTimer = 0;
    let edgeDirection = 0;
    let edgeFrame = 0;
    let dragging = false;
    let dragStartX = 0;
    let dragStartScroll = 0;

    const cancelHide = () => {
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = 0;
    };

    const hideRangeBar = () => {
      if (calendar.style.display !== "none") return;
      rangeBar.style.display = "none";
      rangePills.forEach((pill) => pill.setAttribute("aria-expanded", "false"));
      edgeDirection = 0;
    };

    const scheduleHide = () => {
      cancelHide();
      hideTimer = window.setTimeout(hideRangeBar, 130);
    };

    const updateRangeButtons = () => {
      const activeKey = activePill ? rangeState.get(activePill)?.key : undefined;
      rangeButtons.forEach((button) => {
        const selected = button.dataset.rangeKey === activeKey;
        button.setAttribute("aria-selected", selected ? "true" : "false");
        button.style.background = selected ? "#17242c" : "transparent";
        button.style.color = selected ? "#e9f0f6" : "#9aa9b5";
      });
    };

    const positionRangeUi = () => {
      if (!activePill) return;
      const rect = activePill.getBoundingClientRect();
      const barWidth = Math.min(390, window.innerWidth - 16);
      let left = rect.left - 4;
      if (left + barWidth > window.innerWidth - 8) left = window.innerWidth - barWidth - 8;
      left = Math.max(8, left);
      rangeBar.style.left = `${left}px`;
      rangeBar.style.top = `${Math.max(8, rect.top - 4)}px`;

      const calendarWidth = Math.min(318, window.innerWidth - 16);
      let calendarLeft = left + barWidth - calendarWidth;
      calendarLeft = Math.max(8, Math.min(calendarLeft, window.innerWidth - calendarWidth - 8));
      calendar.style.left = `${calendarLeft}px`;
      calendar.style.top = `${Math.min(window.innerHeight - 154, rect.bottom + 10)}px`;
    };

    const showRangeBar = (pill: HTMLElement) => {
      cancelHide();
      activePill = pill;
      rangePills.forEach((item) => item.setAttribute("aria-expanded", item === pill ? "true" : "false"));
      updateRangeButtons();
      rangeBar.style.display = "flex";
      positionRangeUi();
      const activeButton = rangeButtons.find((button) => button.dataset.rangeKey === rangeState.get(pill)?.key);
      activeButton?.scrollIntoView({ block: "nearest", inline: "center" });
    };

    const closeCalendar = () => {
      calendar.style.display = "none";
      hideRangeBar();
    };

    const showCalendar = () => {
      if (!activePill) return;
      const saved = rangeState.get(activePill);
      startInput.value = saved?.start ?? monthStart();
      endInput.value = saved?.end ?? isoToday();
      endInput.min = startInput.value;
      calendar.style.display = "block";
      rangeBar.style.display = "none";
      positionRangeUi();
      startInput.focus();
    };

    const choosePreset = (preset: RangePreset) => {
      if (!activePill) return;
      if (preset.key === "custom") {
        rangeState.set(activePill, { key: "custom", start: rangeState.get(activePill)?.start, end: rangeState.get(activePill)?.end });
        updateRangeButtons();
        showCalendar();
        return;
      }
      rangeState.set(activePill, { key: preset.key });
      activePill.textContent = preset.label;
      activePill.title = `Range: ${preset.label}`;
      calendar.style.display = "none";
      hideRangeBar();
    };

    const rangeCleanups: Array<() => void> = [];

    rangeButtons.forEach((button) => {
      const onClick = (event: MouseEvent) => {
        event.stopPropagation();
        const preset = RANGE_PRESETS.find((item) => item.key === button.dataset.rangeKey);
        if (preset) choosePreset(preset);
      };
      button.addEventListener("click", onClick);
      rangeCleanups.push(() => button.removeEventListener("click", onClick));
    });

    rangePills.forEach((pill) => {
      const onEnter = () => showRangeBar(pill);
      const onLeave = () => scheduleHide();
      const onClick = (event: MouseEvent) => {
        event.stopPropagation();
        showRangeBar(pill);
      };
      const onPointerDown = (event: PointerEvent) => event.stopPropagation();
      const onKeyDown = (event: KeyboardEvent) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showRangeBar(pill);
        } else if (event.key === "Escape") {
          calendar.style.display = "none";
          hideRangeBar();
        }
      };
      pill.addEventListener("mouseenter", onEnter);
      pill.addEventListener("mouseleave", onLeave);
      pill.addEventListener("click", onClick);
      pill.addEventListener("pointerdown", onPointerDown);
      pill.addEventListener("keydown", onKeyDown);
      rangeCleanups.push(() => {
        pill.removeEventListener("mouseenter", onEnter);
        pill.removeEventListener("mouseleave", onLeave);
        pill.removeEventListener("click", onClick);
        pill.removeEventListener("pointerdown", onPointerDown);
        pill.removeEventListener("keydown", onKeyDown);
        pill.removeAttribute("role");
        pill.removeAttribute("tabindex");
        pill.removeAttribute("aria-haspopup");
        pill.removeAttribute("aria-expanded");
        pill.removeAttribute("style");
      });
    });

    const edgeTick = () => {
      if (edgeDirection && !dragging) rangeScroller.scrollLeft += edgeDirection * 4;
      edgeFrame = window.requestAnimationFrame(edgeTick);
    };
    edgeFrame = window.requestAnimationFrame(edgeTick);

    const onScrollerPointerMove = (event: PointerEvent) => {
      if (dragging) {
        rangeScroller.scrollLeft = dragStartScroll - (event.clientX - dragStartX);
        return;
      }
      const rect = rangeScroller.getBoundingClientRect();
      const x = event.clientX - rect.left;
      edgeDirection = x < 34 ? -1 : x > rect.width - 34 ? 1 : 0;
      rangeScroller.style.cursor = edgeDirection ? "ew-resize" : "grab";
    };
    const onScrollerPointerDown = (event: PointerEvent) => {
      dragging = true;
      edgeDirection = 0;
      dragStartX = event.clientX;
      dragStartScroll = rangeScroller.scrollLeft;
      rangeScroller.style.cursor = "grabbing";
      rangeScroller.setPointerCapture?.(event.pointerId);
    };
    const stopDragging = () => {
      dragging = false;
      rangeScroller.style.cursor = "grab";
    };
    const onScrollerLeave = () => {
      edgeDirection = 0;
      stopDragging();
    };
    rangeScroller.addEventListener("pointermove", onScrollerPointerMove);
    rangeScroller.addEventListener("pointerdown", onScrollerPointerDown);
    rangeScroller.addEventListener("pointerup", stopDragging);
    rangeScroller.addEventListener("pointercancel", stopDragging);
    rangeScroller.addEventListener("pointerleave", onScrollerLeave);

    const onBarEnter = () => cancelHide();
    const onBarLeave = () => scheduleHide();
    rangeBar.addEventListener("mouseenter", onBarEnter);
    rangeBar.addEventListener("mouseleave", onBarLeave);

    const onStartChange = () => {
      endInput.min = startInput.value;
      if (endInput.value && endInput.value < startInput.value) endInput.value = startInput.value;
    };
    startInput.addEventListener("change", onStartChange);

    const onApply = (event: MouseEvent) => {
      event.stopPropagation();
      if (!activePill || !startInput.value || !endInput.value) return;
      const start = startInput.value;
      const end = endInput.value < start ? start : endInput.value;
      rangeState.set(activePill, { key: "custom", start, end });
      activePill.textContent = `${compactDate(start)} – ${compactDate(end)}`;
      activePill.title = `Custom range: ${start} to ${end}`;
      calendar.style.display = "none";
      hideRangeBar();
    };
    const onCancel = (event: MouseEvent) => {
      event.stopPropagation();
      closeCalendar();
    };
    applyButton.addEventListener("click", onApply);
    cancelButton.addEventListener("click", onCancel);

    const stopUiPropagation = (event: Event) => event.stopPropagation();
    rangeBar.addEventListener("click", stopUiPropagation);
    rangeBar.addEventListener("pointerdown", stopUiPropagation);
    calendar.addEventListener("click", stopUiPropagation);
    calendar.addEventListener("pointerdown", stopUiPropagation);

    const onDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rangeBar.contains(target) || calendar.contains(target) || rangePills.some((pill) => pill.contains(target))) return;
      calendar.style.display = "none";
      hideRangeBar();
    };
    document.addEventListener("mousedown", onDocumentPointerDown);

    const onViewportChange = () => {
      if (rangeBar.style.display !== "none" || calendar.style.display !== "none") positionRangeUi();
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);

    const originalChildren = Array.from(detailSection.children) as HTMLElement[];
    detailSection.style.position = "relative";

    const overlay = document.createElement("div");
    overlay.setAttribute("data-dashboard-metric-pane", "true");
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      flexDirection: "column",
      padding: "18px 20px",
      background: "#111820",
      borderRadius: "22px",
      zIndex: "3",
    });
    detailSection.appendChild(overlay);

    const cleanups: Array<() => void> = [];
    const select = (index: number) => {
      metricNodes.forEach((node, nodeIndex) => {
        node.style.cursor = "pointer";
        node.style.background = "transparent";
        node.style.boxShadow = "none";
        node.style.outline = "none";
        node.style.opacity = nodeIndex === index ? "1" : ".88";
        node.setAttribute("aria-pressed", nodeIndex === index ? "true" : "false");

        const value = Array.from(node.children).at(-1) as HTMLElement | undefined;
        if (value) {
          value.style.color = nodeIndex === index ? "#2dd4bf" : "#e9f0f6";
          value.style.transition = "color .15s ease";
        }
      });

      const pane = panes[index];
      if (index === 0) {
        overlay.style.display = "none";
        originalChildren.forEach((child) => {
          child.style.opacity = "";
          child.style.pointerEvents = "";
        });
        return;
      }

      originalChildren.forEach((child) => {
        child.style.opacity = "0";
        child.style.pointerEvents = "none";
      });
      overlay.innerHTML = pane?.html ?? "";
      overlay.style.display = "flex";
    };

    metricNodes.forEach((node, index) => {
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-label", `Show ${panes[index]?.title ?? "metric"} details`);
      const onClick = () => select(index);
      const onKeyDown = (event: Event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          select(index);
        }
      };
      node.addEventListener("click", onClick);
      node.addEventListener("keydown", onKeyDown);
      cleanups.push(() => {
        node.removeEventListener("click", onClick);
        node.removeEventListener("keydown", onKeyDown);
        node.removeAttribute("role");
        node.removeAttribute("tabindex");
        node.removeAttribute("aria-label");
        node.removeAttribute("aria-pressed");
        node.removeAttribute("style");
        const value = Array.from(node.children).at(-1) as HTMLElement | undefined;
        value?.removeAttribute("style");
      });
    });

    select(0);

    return () => {
      cleanups.forEach((cleanup) => cleanup());
      rangeCleanups.forEach((cleanup) => cleanup());
      if (edgeFrame) window.cancelAnimationFrame(edgeFrame);
      if (hideTimer) window.clearTimeout(hideTimer);
      rangeScroller.removeEventListener("pointermove", onScrollerPointerMove);
      rangeScroller.removeEventListener("pointerdown", onScrollerPointerDown);
      rangeScroller.removeEventListener("pointerup", stopDragging);
      rangeScroller.removeEventListener("pointercancel", stopDragging);
      rangeScroller.removeEventListener("pointerleave", onScrollerLeave);
      rangeBar.removeEventListener("mouseenter", onBarEnter);
      rangeBar.removeEventListener("mouseleave", onBarLeave);
      startInput.removeEventListener("change", onStartChange);
      applyButton.removeEventListener("click", onApply);
      cancelButton.removeEventListener("click", onCancel);
      rangeBar.removeEventListener("click", stopUiPropagation);
      rangeBar.removeEventListener("pointerdown", stopUiPropagation);
      calendar.removeEventListener("click", stopUiPropagation);
      calendar.removeEventListener("pointerdown", stopUiPropagation);
      document.removeEventListener("mousedown", onDocumentPointerDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      rangeBar.remove();
      calendar.remove();
      if (previousMetricsWrapStyle === null) metricsWrap.removeAttribute("style");
      else metricsWrap.setAttribute("style", previousMetricsWrapStyle);
      originalChildren.forEach((child) => {
        child.style.opacity = "";
        child.style.pointerEvents = "";
      });
      overlay.remove();
    };
  }, []);

  return null;
}
