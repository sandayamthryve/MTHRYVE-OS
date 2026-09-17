"use client";

import { useEffect } from "react";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

function todayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function toIso(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayDate(value: string) {
  const date = parseIso(value);
  if (!date) return "Select date";
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

export function DevCustomDateCalendar() {
  useEffect(() => {
    let activeInput: HTMLInputElement | null = null;
    let visibleMonth = new Date();

    const panel = document.createElement("div");
    panel.setAttribute("data-mthryve-custom-calendar", "true");
    Object.assign(panel.style, {
      position: "fixed",
      display: "none",
      width: "286px",
      boxSizing: "border-box",
      border: "1px solid #243540",
      borderRadius: "14px",
      background: "rgba(10,17,23,.995)",
      boxShadow: "0 20px 48px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.035)",
      zIndex: "180",
      padding: "10px",
      color: "#e9f0f6",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      backdropFilter: "blur(16px)",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "grid",
      gridTemplateColumns: "30px minmax(0,1fr) 30px",
      alignItems: "center",
      gap: "6px",
      marginBottom: "8px",
    });

    const makeNavButton = (label: string, ariaLabel: string) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", ariaLabel);
      Object.assign(button.style, {
        display: "grid",
        placeItems: "center",
        width: "30px",
        height: "30px",
        border: "1px solid #22343e",
        borderRadius: "9px",
        background: "#0d161c",
        color: "#8b9aa8",
        fontSize: "17px",
        lineHeight: "1",
        cursor: "pointer",
      });
      return button;
    };

    const prevButton = makeNavButton("‹", "Previous month");
    const nextButton = makeNavButton("›", "Next month");
    const monthLabel = document.createElement("div");
    Object.assign(monthLabel.style, {
      minWidth: "0",
      textAlign: "center",
      fontSize: "11.5px",
      fontWeight: "850",
      color: "#e9f0f6",
      whiteSpace: "nowrap",
    });
    header.append(prevButton, monthLabel, nextButton);
    panel.appendChild(header);

    const weekdayRow = document.createElement("div");
    Object.assign(weekdayRow.style, {
      display: "grid",
      gridTemplateColumns: "repeat(7,1fr)",
      gap: "2px",
      marginBottom: "3px",
    });
    WEEKDAYS.forEach((weekday) => {
      const cell = document.createElement("div");
      cell.textContent = weekday;
      Object.assign(cell.style, {
        height: "22px",
        display: "grid",
        placeItems: "center",
        color: "#778b98",
        fontSize: "9px",
        fontWeight: "800",
      });
      weekdayRow.appendChild(cell);
    });
    panel.appendChild(weekdayRow);

    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid",
      gridTemplateColumns: "repeat(7,1fr)",
      gap: "2px",
    });
    panel.appendChild(grid);

    const footer = document.createElement("div");
    Object.assign(footer.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      marginTop: "9px",
      paddingTop: "8px",
      borderTop: "1px solid #1c2a33",
    });

    const contextLabel = document.createElement("span");
    Object.assign(contextLabel.style, {
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: "#708693",
      fontSize: "9.5px",
      fontWeight: "700",
    });

    const todayButton = document.createElement("button");
    todayButton.type = "button";
    todayButton.textContent = "Today";
    Object.assign(todayButton.style, {
      height: "27px",
      flex: "0 0 auto",
      border: "1px solid rgba(45,212,191,.30)",
      borderRadius: "8px",
      background: "rgba(45,212,191,.08)",
      color: "#69e6d5",
      padding: "0 9px",
      fontSize: "10px",
      fontWeight: "800",
      cursor: "pointer",
    });
    footer.append(contextLabel, todayButton);
    panel.appendChild(footer);
    document.body.appendChild(panel);

    const getContainerInputs = (input: HTMLInputElement) => {
      const root = input.closest("[data-dev-range-calendar]");
      const inputs = root ? Array.from(root.querySelectorAll("input[type='date']")) as HTMLInputElement[] : [];
      return { root, start: inputs[0] ?? null, end: inputs[1] ?? null };
    };

    const syncTrigger = (input: HTMLInputElement) => {
      const trigger = input.parentElement?.querySelector<HTMLButtonElement>("[data-custom-date-trigger]");
      if (trigger) trigger.firstChild!.textContent = displayDate(input.value);
    };

    const positionPanel = () => {
      if (!activeInput || panel.style.display === "none") return;
      const trigger = activeInput.parentElement?.querySelector<HTMLElement>("[data-custom-date-trigger]");
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const panelWidth = Math.min(286, window.innerWidth - 16);
      panel.style.width = `${panelWidth}px`;
      let left = rect.left;
      if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
      left = Math.max(8, left);
      const estimatedHeight = 306;
      let top = rect.bottom + 7;
      if (top + estimatedHeight > window.innerHeight - 8) top = Math.max(8, rect.top - estimatedHeight - 7);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const isSameMonthAsToday = () => {
      const now = new Date();
      return visibleMonth.getFullYear() === now.getFullYear() && visibleMonth.getMonth() === now.getMonth();
    };

    const render = () => {
      if (!activeInput) return;
      const { start, end } = getContainerInputs(activeInput);
      const startValue = start?.value ?? "";
      const endValue = end?.value ?? "";
      const selectedValue = activeInput.value;
      const activeIsStart = activeInput === start;

      monthLabel.textContent = `${MONTHS[visibleMonth.getMonth()]} ${visibleMonth.getFullYear()}`;
      contextLabel.textContent = activeIsStart ? "Choose start date" : "Choose end date";
      nextButton.style.opacity = isSameMonthAsToday() ? ".28" : "1";
      nextButton.style.cursor = isSameMonthAsToday() ? "default" : "pointer";
      grid.replaceChildren();

      const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
      const gridStart = new Date(first);
      gridStart.setDate(first.getDate() - first.getDay());
      const maxIso = todayIso();

      for (let index = 0; index < 42; index += 1) {
        const date = new Date(gridStart);
        date.setDate(gridStart.getDate() + index);
        const iso = toIso(date);
        const inMonth = date.getMonth() === visibleMonth.getMonth();
        const disabled = iso > maxIso || (!activeIsStart && Boolean(startValue) && iso < startValue);
        const selected = iso === selectedValue;
        const inRange = Boolean(startValue && endValue && iso >= startValue && iso <= endValue);
        const rangeStart = iso === startValue;
        const rangeEnd = iso === endValue;

        const day = document.createElement("button");
        day.type = "button";
        day.textContent = String(date.getDate());
        day.dataset.date = iso;
        day.disabled = disabled;
        day.setAttribute("aria-label", new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(date));
        Object.assign(day.style, {
          height: "32px",
          minWidth: "0",
          border: selected || rangeStart || rangeEnd ? "1px solid rgba(45,212,191,.72)" : "1px solid transparent",
          borderRadius: rangeStart || rangeEnd || selected ? "9px" : inRange ? "5px" : "9px",
          background: selected || rangeStart || rangeEnd ? "rgba(45,212,191,.88)" : inRange ? "rgba(45,212,191,.10)" : "transparent",
          color: disabled ? "#40505a" : selected || rangeStart || rangeEnd ? "#031a18" : inMonth ? "#dbe5eb" : "#536772",
          fontSize: "10.5px",
          fontWeight: selected || rangeStart || rangeEnd ? "900" : "700",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? ".48" : "1",
        });
        grid.appendChild(day);
      }
    };

    const close = () => {
      panel.style.display = "none";
      activeInput = null;
    };

    const open = (input: HTMLInputElement) => {
      activeInput = input;
      const selected = parseIso(input.value) ?? new Date();
      visibleMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
      render();
      panel.style.display = "block";
      positionPanel();
    };

    const setDate = (iso: string) => {
      if (!activeInput) return;
      const current = activeInput;
      const { start, end } = getContainerInputs(current);
      current.value = iso;
      current.dispatchEvent(new Event("change", { bubbles: true }));
      syncTrigger(current);

      if (current === start && end) {
        if (!end.value || end.value < iso) {
          end.value = iso;
          end.dispatchEvent(new Event("change", { bubbles: true }));
          syncTrigger(end);
        }
        activeInput = end;
        const endDate = parseIso(end.value) ?? parseIso(iso) ?? new Date();
        visibleMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
        render();
        positionPanel();
        return;
      }
      close();
    };

    const onGridClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-date]");
      if (!target || target.disabled || !target.dataset.date) return;
      event.stopPropagation();
      setDate(target.dataset.date);
    };
    grid.addEventListener("click", onGridClick);

    const onPrev = (event: MouseEvent) => {
      event.stopPropagation();
      visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
      render();
    };
    const onNext = (event: MouseEvent) => {
      event.stopPropagation();
      if (isSameMonthAsToday()) return;
      const next = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
      const now = new Date();
      if (next.getFullYear() > now.getFullYear() || (next.getFullYear() === now.getFullYear() && next.getMonth() > now.getMonth())) return;
      visibleMonth = next;
      render();
    };
    prevButton.addEventListener("click", onPrev);
    nextButton.addEventListener("click", onNext);

    const onToday = (event: MouseEvent) => {
      event.stopPropagation();
      setDate(todayIso());
    };
    todayButton.addEventListener("click", onToday);

    const enhanced = new Map<HTMLInputElement, { trigger: HTMLButtonElement; onClick: (event: MouseEvent) => void; originalDisplay: string }>();

    const enhance = () => {
      document.querySelectorAll<HTMLInputElement>("[data-dev-range-calendar] input[type='date']").forEach((input) => {
        if (enhanced.has(input)) return;
        const label = input.parentElement;
        if (!label) return;

        const originalDisplay = input.style.display;
        input.style.display = "none";

        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.setAttribute("data-custom-date-trigger", "true");
        trigger.setAttribute("aria-label", `Open custom calendar for ${(label.querySelector("span")?.textContent ?? "date").toLowerCase()}`);
        const textNode = document.createTextNode(displayDate(input.value));
        const icon = document.createElement("span");
        icon.textContent = "▦";
        Object.assign(icon.style, { color: "#6f8491", fontSize: "12px", lineHeight: "1" });
        trigger.append(textNode, icon);
        Object.assign(trigger.style, {
          width: "100%",
          height: "32px",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          border: "1px solid #2b3a46",
          borderRadius: "9px",
          background: "#0a1117",
          color: "#e9f0f6",
          padding: "0 8px",
          fontSize: "10.5px",
          fontWeight: "700",
          textAlign: "left",
          cursor: "pointer",
          outline: "none",
        });

        const onClick = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          syncTrigger(input);
          open(input);
        };
        trigger.addEventListener("click", onClick);
        label.appendChild(trigger);
        enhanced.set(input, { trigger, onClick, originalDisplay });
      });
    };

    const observer = new MutationObserver((mutations) => {
      enhance();
      for (const mutation of mutations) {
        if (mutation.type !== "attributes") continue;
        const target = mutation.target as HTMLElement;
        if (target.matches?.("[data-dev-range-calendar]") && target.style.display === "none") close();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    enhance();

    const onDocumentMouseDown = (event: MouseEvent) => {
      if (panel.style.display === "none") return;
      const target = event.target as Node;
      if (panel.contains(target)) return;
      const trigger = activeInput?.parentElement?.querySelector("[data-custom-date-trigger]");
      if (trigger?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", onDocumentMouseDown);

    const onViewportChange = () => positionPanel();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);

    return () => {
      observer.disconnect();
      document.removeEventListener("mousedown", onDocumentMouseDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      grid.removeEventListener("click", onGridClick);
      prevButton.removeEventListener("click", onPrev);
      nextButton.removeEventListener("click", onNext);
      todayButton.removeEventListener("click", onToday);
      enhanced.forEach(({ trigger, onClick, originalDisplay }, input) => {
        trigger.removeEventListener("click", onClick);
        trigger.remove();
        input.style.display = originalDisplay;
      });
      panel.remove();
    };
  }, []);

  return null;
}
