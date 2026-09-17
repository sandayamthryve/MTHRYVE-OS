import type { ReactNode } from "react";

// The standard top-of-page block: a bold page title with a muted subtitle,
// matching the Command Center header. An optional right-aligned action slot
// keeps page-level buttons/links aligned with the title.
export function PageHeader({
  title,
  subtitle,
  action,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-6 flex flex-wrap items-start justify-between gap-3 ${className}`}>
      <div>
        <h1 className="text-xl font-bold text-ink">{title}</h1>
        {subtitle ? <p className="text-sm text-ink-muted">{subtitle}</p> : null}
      </div>
      {action ? <div className="min-w-0 max-w-full shrink-0">{action}</div> : null}
    </div>
  );
}
