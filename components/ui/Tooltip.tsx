"use client";

import React, { useEffect, useId, useRef, useState } from "react";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  delay?: number;
  position?: "top" | "bottom" | "left" | "right";
}

export function Tooltip({
  content,
  children,
  delay = 200,
  position = "right",
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const timerRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleMouseEnter = () => {
    timerRef.current = setTimeout(() => setOpen(true), delay);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setOpen(false);
  };

  const handleFocus = () => setOpen(true);
  const handleBlur = () => setOpen(false);

  const positionStyles = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  const arrowStyles = {
    top: "top-full left-1/2 -translate-x-1/2 border-t-charcoal-700",
    bottom: "bottom-full left-1/2 -translate-x-1/2 border-b-charcoal-700",
    left: "left-full top-1/2 -translate-y-1/2 border-l-charcoal-700",
    right: "right-full top-1/2 -translate-y-1/2 border-r-charcoal-700",
  };

  const child = React.Children.only(children);
  const childWithEvents = React.cloneElement(child, {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
  });

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {childWithEvents}
      {open && (
        <span
          role="tooltip"
          id={tipId}
          className={`absolute z-50 whitespace-nowrap rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-[11px] font-medium text-ink shadow-elevate ${positionStyles[position]}`}
        >
          {content}
          <span
            className={`absolute w-0 h-0 border-4 border-transparent ${arrowStyles[position]}`}
          />
        </span>
      )}
    </span>
  );
}