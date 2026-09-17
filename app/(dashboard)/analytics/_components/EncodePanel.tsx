"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SectionCard, Badge } from "@/components/ui";
import {
  VALIDATION_LABEL,
  VALIDATION_TONE,
  ORIGIN_LABEL,
} from "@/lib/metrics/display";
import type { Unit, ValidationStatus, Origin } from "@/lib/metrics/types";

export interface EncodeMetric {
  metric_key: string;
  label: string;
  unit: Unit;
  lane: string;
  manual_value: number | null;
  api_value: number | null;
  display_origin: Origin | null;
  entry_id: string | null;
  entered_by_name: string | null;
  updated_at: string | null;
  validation_status: ValidationStatus;
  approved_at: string | null;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

// The encoding floor: every non-calculated metric for the selected department +
// brand + period, with a numeric input pre-filled from manual_value. Save posts
// an upsert that only ever writes manual_value (api_value is untouchable from
// here). Leadership additionally sees an Approve control per encoded row.
export function EncodePanel({
  department,
  brandId,
  periodStart,
  periodEnd,
  metrics,
  canApprove,
}: {
  department: string;
  brandId: string | null;
  periodStart: string;
  periodEnd: string;
  metrics: EncodeMetric[];
  canApprove: boolean;
}) {
  return (
    <SectionCard
      title="Encode / Update"
      className="mt-8"
      action={
        <span className="font-mono text-[10px] text-ink-dim">
          {periodStart} → {periodEnd}
          {brandId ? "" : " · org-level"}
        </span>
      }
    >
      <p className="mb-3 text-xs text-ink-muted">
        The manual floor. Enter each metric for the selected period; values save to
        the manual column only and never touch API-synced values. Leave blank to
        clear (shows as “—”, never 0).
      </p>
      <div className="divide-y divide-charcoal-800">
        {metrics.map((m) => (
          <EncodeRow
            key={`${m.metric_key}:${periodStart}:${periodEnd}:${brandId ?? "shop"}`}
            department={department}
            brandId={brandId}
            periodStart={periodStart}
            periodEnd={periodEnd}
            metric={m}
            canApprove={canApprove}
          />
        ))}
      </div>
    </SectionCard>
  );
}

function EncodeRow({
  department,
  brandId,
  periodStart,
  periodEnd,
  metric,
  canApprove,
}: {
  department: string;
  brandId: string | null;
  periodStart: string;
  periodEnd: string;
  metric: EncodeMetric;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<string>(
    metric.manual_value != null ? String(metric.manual_value) : ""
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function save() {
    setStatus("saving");
    setMessage("");
    try {
      const res = await fetch("/api/metrics/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metric_key: metric.metric_key,
          department,
          brand_id: brandId,
          period_start: periodStart,
          period_end: periodEnd,
          manual_value: value.trim() === "" ? null : Number(value),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(json?.error ?? "Save failed.");
        return;
      }
      setStatus("saved");
      router.refresh();
    } catch {
      setStatus("error");
      setMessage("Network error.");
    }
  }

  async function approve(override: boolean) {
    if (!metric.entry_id) return;
    setStatus("saving");
    try {
      const res = await fetch("/api/metrics/entries/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: metric.entry_id, override }),
      });
      const json = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(json?.error ?? "Approve failed.");
        return;
      }
      setStatus("saved");
      router.refresh();
    } catch {
      setStatus("error");
      setMessage("Network error.");
    }
  }

  const showValidation =
    metric.manual_value != null && metric.api_value != null
      ? true
      : metric.validation_status === "overridden";

  return (
    <div className="flex flex-wrap items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-ink">{metric.label}</span>
          {metric.api_value != null && (
            <span className="font-mono text-[10px] text-teal-400/70" title="API-synced value (read-only)">
              API {metric.api_value}
            </span>
          )}
          {showValidation && (
            <Badge tone={VALIDATION_TONE[metric.validation_status]}>
              {VALIDATION_LABEL[metric.validation_status]}
            </Badge>
          )}
        </div>
        {(metric.entered_by_name || metric.updated_at) && (
          <p className="mt-0.5 font-mono text-[10px] text-ink-dim">
            {metric.entered_by_name ? `by ${metric.entered_by_name}` : ""}
            {metric.updated_at ? ` · ${fmtWhen(metric.updated_at)}` : ""}
            {metric.approved_at ? " · ✓ approved" : ""}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="number"
          step="any"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setStatus("idle");
          }}
          placeholder="—"
          className="w-28 rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-right font-mono text-sm text-ink"
        />
        <button
          type="button"
          onClick={save}
          disabled={status === "saving"}
          className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-50"
        >
          {status === "saving" ? "…" : status === "saved" ? "Saved" : "Save"}
        </button>
        {canApprove && metric.entry_id && (
          <button
            type="button"
            onClick={() => approve(metric.validation_status === "mismatch")}
            title={
              metric.validation_status === "mismatch"
                ? "Approve and override the API mismatch"
                : "Approve this entry"
            }
            className="rounded-md border border-charcoal-700 bg-charcoal-800 px-2.5 py-1.5 text-xs font-medium text-ink-muted hover:bg-charcoal-700 hover:text-ink"
          >
            {metric.validation_status === "mismatch" ? "Approve ⚠" : "Approve"}
          </button>
        )}
      </div>
      {status === "error" && (
        <p className="w-full text-[11px] text-red-300">{message}</p>
      )}
    </div>
  );
}
