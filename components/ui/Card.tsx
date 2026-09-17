import type { ReactNode } from "react";

// Base surface primitive, extracted from the Command Center panels so every
// dashboard page reads as the same design language. Plain, dependency-free and
// safe in both server and client components — no hooks, no async, no
// server-only imports. Tokens match the home page: charcoal-900 surface, a
// hairline charcoal-700/60 border, generous radius and the shared elevation.
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate ${className}`}
    >
      {children}
    </div>
  );
}
