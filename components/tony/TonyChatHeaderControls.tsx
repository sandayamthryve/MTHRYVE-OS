"use client";

import { useEffect } from "react";

/**
 * Keeps the existing Tony visibility control visually inside the chat header
 * without disturbing the Chat Block's state/streaming logic. The underlying
 * toggle still owns showTony; this layer only positions it in the top nav and
 * gives the control the SYM LINK language used by the UI.
 */
export function TonyChatHeaderControls() {
  useEffect(() => {
    let boundButton: HTMLButtonElement | null = null;
    let unbind: (() => void) | null = null;

    const syncLabel = () => {
      const hud = document.querySelector<HTMLElement>(".tonyChatHud");
      const button = document.querySelector<HTMLButtonElement>(".tonyVisualToggle");
      if (!button) return;

      const hidden = hud?.classList.contains("tonyHidden") ?? false;
      const label = hidden ? "SHOW SYM LINK" : "REMOVE SYM LINK";

      for (const node of Array.from(button.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          node.textContent = ` ${label}`;
        }
      }
      button.setAttribute("aria-label", label);
      button.title = label;

      if (button !== boundButton) {
        unbind?.();
        const handleClick = () => {
          requestAnimationFrame(() => requestAnimationFrame(syncLabel));
        };
        button.addEventListener("click", handleClick);
        boundButton = button;
        unbind = () => button.removeEventListener("click", handleClick);
      }
    };

    const observer = new MutationObserver(syncLabel);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    syncLabel();

    return () => {
      observer.disconnect();
      unbind?.();
    };
  }, []);

  return (
    <style jsx global>{`
      /* Place the existing show/hide control inside Chat Mode's top navigation. */
      .tonyChatHud .chatPanelWrap > .tonyVisualToggle {
        top: 14px !important;
        left: auto !important;
        right: 66px !important;
        transform: none !important;
        z-index: 12 !important;
        min-width: 132px !important;
        height: 30px !important;
        box-shadow: none !important;
        background: rgba(8, 18, 30, .78) !important;
      }

      .tonyChatHud .chatPanelWrap > .tonyVisualToggle:active {
        transform: translateY(1px) !important;
      }

      .tonyChatHud .chatHeader {
        padding-right: 222px !important;
      }

      @media (max-width: 900px) {
        .tonyChatHud .chatPanelWrap > .tonyVisualToggle {
          right: 58px !important;
          min-width: 118px !important;
          padding-inline: 9px !important;
          letter-spacing: .1em !important;
        }
        .tonyChatHud .chatHeader {
          padding-right: 194px !important;
        }
      }

      @media (max-width: 640px) {
        .tonyChatHud .chatHeader {
          padding-right: 16px !important;
        }
      }
    `}</style>
  );
}
