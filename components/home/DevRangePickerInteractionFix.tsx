"use client";

import { useEffect } from "react";

export function DevRangePickerInteractionFix() {
  useEffect(() => {
    const buttonHandlers = new Map<HTMLButtonElement, (event: PointerEvent) => void>();
    const calendarHandlers = new Map<HTMLElement, {
      pointerdown: (event: PointerEvent) => void;
      mousedown: (event: MouseEvent) => void;
      click: (event: MouseEvent) => void;
    }>();

    const attach = () => {
      document
        .querySelectorAll<HTMLButtonElement>('[data-dev-range-bar] button[data-range-key]')
        .forEach((button) => {
          if (buttonHandlers.has(button)) return;

          // The range scroller starts drag mode on pointerdown. Without stopping
          // the button's pointerdown here, the scroller captures the pointer and
          // the browser never delivers the button click. Keep drag behavior on
          // the empty scroller area while making each date preset a real button.
          const stopScrollerDrag = (event: PointerEvent) => {
            event.stopPropagation();
          };

          button.addEventListener("pointerdown", stopScrollerDrag);
          buttonHandlers.set(button, stopScrollerDrag);
        });

      document
        .querySelectorAll<HTMLElement>('[data-mthryve-custom-calendar]')
        .forEach((panel) => {
          if (calendarHandlers.has(panel)) return;

          // The custom calendar is rendered outside the original range popup.
          // The range popup has a document-level mousedown handler that treats
          // anything outside itself as a dismissal. Without intercepting these
          // events, clicking a custom calendar day closes the parent popup on
          // mousedown before the day can receive its click event.
          const stopPointerDown = (event: PointerEvent) => event.stopPropagation();
          const stopMouseDown = (event: MouseEvent) => event.stopPropagation();
          const stopClick = (event: MouseEvent) => event.stopPropagation();

          panel.addEventListener("pointerdown", stopPointerDown);
          panel.addEventListener("mousedown", stopMouseDown);
          panel.addEventListener("click", stopClick);

          calendarHandlers.set(panel, {
            pointerdown: stopPointerDown,
            mousedown: stopMouseDown,
            click: stopClick,
          });
        });
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      buttonHandlers.forEach((handler, button) => {
        button.removeEventListener("pointerdown", handler);
      });
      buttonHandlers.clear();

      calendarHandlers.forEach((handlers, panel) => {
        panel.removeEventListener("pointerdown", handlers.pointerdown);
        panel.removeEventListener("mousedown", handlers.mousedown);
        panel.removeEventListener("click", handlers.click);
      });
      calendarHandlers.clear();
    };
  }, []);

  return null;
}
