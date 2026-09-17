import type { ReactNode } from "react";
import { Card } from "./Card";

// A Card with the standard Command Center section header: a small icon slot +
// title on the left, an optional right-aligned action / link on the right,
// then the section body below. Purely presentational.
export function SectionCard({
  title,
  icon,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {icon ? (
            <span className="flex h-5 w-5 items-center justify-center text-ink-muted" aria-hidden>
              {icon}
            </span>
          ) : null}
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
        </div>
        {action ? <div className="min-w-0 max-w-full shrink-0">{action}</div> : null}
      </div>
      {children != null ? <div className={bodyClassName}>{children}</div> : null}
    </Card>
  );
}
