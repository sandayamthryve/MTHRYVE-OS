"use client";

// Inline status change on a Status Board card. The pipeline stages are the
// pipeline enum; picking a new one submits the (server) updateItemStatus action
// immediately. brand/month ride along as hidden fields so the redirect back
// lands on the same filtered view.
import { useFormStatus } from "react-dom";

const STAGES = ["idea", "brief", "production", "scheduled", "published", "archived"] as const;
const LABELS: Record<string, string> = {
  idea: "Idea",
  brief: "Brief",
  production: "Production",
  scheduled: "Scheduled",
  published: "Published",
  archived: "Archived",
};

function Select({ status }: { status: string }) {
  const { pending } = useFormStatus();
  return (
    <select
      name="status"
      defaultValue={status}
      disabled={pending}
      aria-label="Change status"
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
      className="rounded-md border border-charcoal-700 bg-charcoal-950 px-1.5 py-1 text-[11px] text-ink-muted disabled:opacity-60"
    >
      {STAGES.map((s) => (
        <option key={s} value={s}>
          {LABELS[s]}
        </option>
      ))}
    </select>
  );
}

export function InlineStatusSelect({
  id,
  status,
  brand,
  month,
  action,
}: {
  id: string;
  status: string;
  brand: string;
  month: string;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="brand" value={brand} />
      <input type="hidden" name="month" value={month} />
      <Select status={status} />
    </form>
  );
}
