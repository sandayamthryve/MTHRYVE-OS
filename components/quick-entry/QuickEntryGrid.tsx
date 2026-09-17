"use client";

// QuickEntryGrid — the standalone full-department Quick-Entry surface for
// recording the hand-enterable (lane='manual') metric floor. Self-contained: it
// takes its scope + catalog as props (resolved server-side from the real tables)
// and owns its own state.
//
// What this surface guarantees:
//   1. The DEPARTMENT SELECTOR works. Leadership (ceo/coo, or anyone with no
//      department) gets a dropdown of every department that has manual metrics;
//      everyone else is locked to their own. The department string is
//      metric_catalog.department itself — the TEXT code — so filtering, saving,
//      reading back, and the Data Analytics read always agree.
//   2. Every metric row has an EDITABLE number input bound to state. Type a
//      number, tap Save, and each entered value is written to
//      metric_entries.manual_value (origin='manual', entered_by = you) at ORG
//      level (brand_id null) for the selected day.
//   3. REFLECT: on load (and after each save) the grid reads back the org-level
//      values already stored for the selected department + day and PRE-FILLS each
//      row, so what you see equals what's persisted — and the same value shows in
//      that department's Data Analytics for the day (the read uses identical keys).
//   4. EVIDENCE: any row can carry a photo / video / screenshot / link. On save,
//      the evidence is filed in the private 'evidence' bucket under
//      "<org_id>/quick-entry/<file>" and recorded in evidence_attachments, hung
//      off the metric_entry it substantiates.
//
// Honest nulls: a blank input saves NOTHING and renders "—" as its placeholder —
// never a fabricated 0. Only rows you actually typed a number into are written.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DEPARTMENT_LABELS, type Department } from "@/lib/metrics/types";
import { SnapFill } from "@/components/snapfill/SnapFill";
import type { SnapFillResult } from "@/lib/snapfill/schema";

export interface GridMetric {
  metric_key: string;
  department: string;
  label: string;
  unit: string | null;
}

// A department value is the metrics-floor CODE ("ecommerce", "live_ops", …).
// Show the human label when we know it, but never hide an unmapped code.
function deptLabel(code: string): string {
  return DEPARTMENT_LABELS[code as Department] ?? code;
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type EvidenceKind = "photo" | "video" | "screenshot" | "link";

// One piece of staged evidence for a row: a captured file, or a pasted link.
interface StagedEvidence {
  file: File | null;
  sourceUrl: string;
  kind: EvidenceKind;
}

interface BulkResult {
  ok: boolean;
  saved: number;
  failed: number;
  results: Array<{ metric_key: string; ok: boolean; action?: string; entry_id?: string | null; error?: string }>;
  error?: string;
}

interface SaveSummary {
  saved: number;
  failed: number;
  evidenceSaved: number;
  evidenceFailed: number;
  evidenceSkipped: number;
}

export function QuickEntryGrid({
  canPickDepartment,
  departments,
  ownDepartment,
  catalog,
  initialDepartment = null,
  onSaved,
}: {
  canPickDepartment: boolean;
  departments: string[];
  ownDepartment: string | null;
  catalog: GridMetric[];
  // Preselect this department (a metrics-floor CODE) when the surface knows which
  // team it opened for — e.g. the Data Analytics grid opened on E-Commerce. A
  // locked caller is always pinned to their own department regardless.
  initialDepartment?: string | null;
  // Fired after a successful save (any rows written), so a host modal can react
  // (e.g. keep itself open showing the banner). The grid already refreshes route
  // data itself, so analytics behind the modal repaints with the new values.
  onSaved?: () => void;
}) {
  const router = useRouter();

  // The department we're entering for. A locked user is pinned to their own; a
  // leader lands on the requested initial department (when it's a real option)
  // or the first available one.
  const initialDept = canPickDepartment
    ? initialDepartment && departments.includes(initialDepartment)
      ? initialDepartment
      : departments[0] ?? ""
    : ownDepartment ?? "";
  const [department, setDepartment] = useState(initialDept);
  const [day, setDay] = useState(todayStr());

  // metric_key -> raw input string. Blank means "not entered" (never 0). Seeded
  // from what's already stored (read-back) whenever department/day changes.
  const [values, setValues] = useState<Record<string, string>>({});
  // metric_key -> staged evidence for that row (a file or a link), if any.
  const [attachments, setAttachments] = useState<Record<string, StagedEvidence>>({});
  // Which rows currently show their evidence controls (kept tidy by default).
  const [openEvidence, setOpenEvidence] = useState<Record<string, boolean>>({});

  const [loadingSaved, setLoadingSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<SaveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // "Snap to fill" (now via the shared <SnapFill>): the last PHOTO capture, if any.
  // The screenshot is already in the bucket (storagePath); `aiKeys` marks the rows
  // the model pre-filled so they render as editable "AI-read" and save with
  // origin='vision'; `extract` is the raw JSON kept for the evidence trail. A
  // paste/drop fill lands the same values but stays origin='manual' (human-supplied),
  // so it's not marked AI-read. Cleared once saved.
  const [vision, setVision] = useState<{
    storagePath: string;
    extract: Record<string, unknown>;
    model: string;
  } | null>(null);
  const [aiKeys, setAiKeys] = useState<Set<string>>(new Set());

  // The metrics shown for the selected department, in catalog (sort) order.
  const visibleMetrics = useMemo(
    () => catalog.filter((m) => m.department === department),
    [catalog, department]
  );

  // This department's field whitelist for SnapFill — every visible manual metric as
  // a numeric field. SnapFill (paste or photo) may fill ONLY these keys; the save
  // still re-validates each against the catalog and writes through the sanctioned
  // manual lane (manual_value / origin), so api_value is never touched.
  const snapSchema = useMemo(
    () =>
      visibleMetrics.map((m) => ({
        key: m.metric_key,
        label: m.label,
        type: "number" as const,
        unit: m.unit,
      })),
    [visibleMetrics]
  );

  // Merge a SnapFill result into the grid. Only readable (visible) keys land, as
  // editable prefills — never a saved value. A PHOTO fill marks those rows "AI-read"
  // (origin='vision' on save) and keeps the snapped image as evidence; a PASTE fill
  // is human-supplied and saves as origin='manual'. Honest nulls: a key SnapFill
  // couldn't read simply isn't in the result, so its row stays blank ("—").
  const onSnapFill = useCallback(
    (result: SnapFillResult) => {
      const readable = new Set(visibleMetrics.map((m) => m.metric_key));
      const filled: string[] = [];
      setValues((prev) => {
        const next = { ...prev };
        for (const [key, val] of Object.entries(result.values)) {
          if (readable.has(key)) {
            next[key] = val;
            filled.push(key);
          }
        }
        return next;
      });
      if (result.source === "photo") {
        setAiKeys(new Set(filled));
        setVision(
          result.vision?.storagePath
            ? {
                storagePath: result.vision.storagePath,
                extract: result.vision.extract,
                model: result.vision.model,
              }
            : null
        );
      }
      setSummary(null);
      setError(null);
    },
    [visibleMetrics]
  );

  // Read back the org-level values already stored for this department + day, so
  // the grid PRE-FILLS with what's persisted (blanks stay "—"). Uses the same
  // keys the save writes and Data Analytics reads. A stale response (department or
  // day changed mid-flight) is ignored via the request token.
  const reqToken = useRef(0);
  const loadSaved = useCallback(
    async (dept: string, d: string) => {
      if (!dept) {
        setValues({});
        return;
      }
      const token = ++reqToken.current;
      setLoadingSaved(true);
      try {
        const params = new URLSearchParams({ department: dept, period_start: d, period_end: d });
        const res = await fetch(`/api/quick-entry/bulk?${params.toString()}`, {
          headers: { accept: "application/json" },
        });
        if (token !== reqToken.current) return; // superseded
        const data = (res.ok ? await res.json() : { values: {} }) as { values?: Record<string, number> };
        const next: Record<string, string> = {};
        for (const [key, val] of Object.entries(data.values ?? {})) {
          if (typeof val === "number" && Number.isFinite(val)) next[key] = String(val);
        }
        setValues(next);
      } catch {
        if (token === reqToken.current) setValues({});
      } finally {
        if (token === reqToken.current) setLoadingSaved(false);
      }
    },
    []
  );

  // Reflect on load and whenever the department or day changes.
  useEffect(() => {
    void loadSaved(department, day);
    // Clear any per-row banner/evidence staging when the slice changes.
    setSummary(null);
    setError(null);
    setAttachments({});
    setOpenEvidence({});
    // A snap belongs to the slice it was taken for — drop it when the slice changes.
    setVision(null);
    setAiKeys(new Set());
  }, [department, day, loadSaved]);

  // How many rows currently hold a real, finite number — what Save will write.
  const enteredCount = useMemo(
    () =>
      visibleMetrics.reduce((n, m) => {
        const raw = (values[m.metric_key] ?? "").trim();
        if (raw === "") return n;
        return Number.isFinite(Number(raw)) ? n + 1 : n;
      }, 0),
    [visibleMetrics, values]
  );

  const attachedCount = useMemo(
    () => visibleMetrics.reduce((n, m) => (stagedFor(attachments[m.metric_key]) ? n + 1 : n), 0),
    [visibleMetrics, attachments]
  );

  function setValue(key: string, raw: string) {
    setValues((prev) => ({ ...prev, [key]: raw }));
    if (summary || error) {
      setSummary(null);
      setError(null);
    }
  }

  function onDepartmentChange(next: string) {
    setDepartment(next);
    setSummary(null);
    setError(null);
  }

  function toggleEvidence(key: string) {
    setOpenEvidence((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function setEvidenceFile(key: string, file: File | null) {
    setAttachments((prev) => {
      const next = { ...prev };
      if (!file) {
        // Keep any link the row still has; drop the whole entry if nothing's left.
        const existing = next[key];
        if (existing && existing.sourceUrl.trim()) {
          next[key] = { ...existing, file: null };
        } else {
          delete next[key];
        }
        return next;
      }
      const kind: EvidenceKind = file.type.startsWith("video/") ? "video" : "photo";
      next[key] = { file, sourceUrl: next[key]?.sourceUrl ?? "", kind };
      return next;
    });
    if (summary) setSummary(null);
  }

  function setEvidenceLink(key: string, url: string) {
    setAttachments((prev) => {
      const next = { ...prev };
      const existing = next[key];
      if (!url.trim() && !existing?.file) {
        delete next[key];
        return next;
      }
      next[key] = {
        file: existing?.file ?? null,
        sourceUrl: url,
        kind: existing?.file ? existing.kind : "link",
      };
      return next;
    });
    if (summary) setSummary(null);
  }

  function setEvidenceKind(key: string, kind: EvidenceKind) {
    setAttachments((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      return { ...prev, [key]: { ...existing, kind } };
    });
  }

  function clearEvidence(key: string) {
    setAttachments((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function save() {
    setError(null);
    setSummary(null);

    // Only rows with a real number are sent — honest nulls, no fabricated 0s. A row
    // the model pre-filled (whether or not the user edited it) is recorded with
    // origin='vision'; everything else is 'manual'.
    const entries = visibleMetrics
      .map((m) => {
        const raw = (values[m.metric_key] ?? "").trim();
        if (raw === "") return null;
        const numVal = Number(raw);
        if (!Number.isFinite(numVal)) return null;
        const origin: "manual" | "vision" = aiKeys.has(m.metric_key) ? "vision" : "manual";
        return { metric_key: m.metric_key, department: m.department, manual_value: numVal, origin };
      })
      .filter(
        (e): e is { metric_key: string; department: string; manual_value: number; origin: "manual" | "vision" } =>
          e !== null
      );

    if (entries.length === 0) {
      setError("Enter at least one value to save.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/quick-entry/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period_start: day, period_end: day, entries }),
      });
      const data = (await res.json()) as BulkResult;
      if (!res.ok) {
        setError(data.error ?? "Save failed.");
        return;
      }

      // Map each saved metric to the entry_id we can hang evidence off of.
      const idByMetric = new Map<string, string>();
      for (const r of data.results ?? []) {
        if (r.ok && r.entry_id) idByMetric.set(r.metric_key, r.entry_id);
      }

      // Attach staged evidence to the metric_entry each piece substantiates. A
      // row that carries evidence but whose value didn't save (blank/failed) has
      // no entry to attach to — counted as skipped, not silently dropped.
      let evidenceSaved = 0;
      let evidenceFailed = 0;
      let evidenceSkipped = 0;
      const attachedKeys: string[] = [];
      for (const m of visibleMetrics) {
        const staged = attachments[m.metric_key];
        if (!stagedFor(staged)) continue;
        const entryId = idByMetric.get(m.metric_key);
        if (!entryId) {
          evidenceSkipped += 1;
          continue;
        }
        const ok = await uploadEvidence(entryId, staged);
        if (ok) {
          evidenceSaved += 1;
          attachedKeys.push(m.metric_key);
        } else {
          evidenceFailed += 1;
        }
      }

      // Drop evidence that landed so it isn't re-uploaded on the next save.
      if (attachedKeys.length > 0) {
        setAttachments((prev) => {
          const next = { ...prev };
          for (const k of attachedKeys) delete next[k];
          return next;
        });
      }

      // Attach the "Snap to fill" screenshot (already in the bucket) to the metric
      // entries it read. It's filed once, against the first vision row that saved,
      // as kind='screenshot' with the model's JSON as vision_extract. Best-effort:
      // a failed attach never fails the save (the numbers are already recorded).
      if (vision) {
        const firstVisionEntry = data.results?.find(
          (r) => r.ok && r.entry_id && aiKeys.has(r.metric_key)
        );
        if (firstVisionEntry?.entry_id) {
          try {
            const fd = new FormData();
            fd.set("entity_type", "metric_entry");
            fd.set("entity_id", firstVisionEntry.entry_id);
            fd.set("kind", "screenshot");
            fd.set("storage_path", vision.storagePath);
            fd.set("vision_extract", JSON.stringify(vision.extract));
            await fetch("/api/quick-entry/evidence", { method: "POST", body: fd });
          } catch {
            /* best-effort — numbers are saved regardless */
          }
        }
        // The snap has been committed; clear it and the AI-read highlighting.
        setVision(null);
        setAiKeys(new Set());
      }

      setSummary({
        saved: data.saved,
        failed: data.failed,
        evidenceSaved,
        evidenceFailed,
        evidenceSkipped,
      });

      // Re-fetch so the grid equals what's stored (Save + read agree), and repaint
      // any analytics behind a host modal.
      await loadSaved(department, day);
      router.refresh();
      onSaved?.();
    } catch {
      setError("Save failed — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const noDepartment = department === "";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      {/* Controls: department + day */}
      <div className="flex flex-col gap-4 rounded-2xl border border-charcoal-700 bg-charcoal-900/60 p-4 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-dim">Department</span>
          {canPickDepartment ? (
            <select
              value={department}
              onChange={(e) => onDepartmentChange(e.target.value)}
              className="w-full rounded-lg border border-charcoal-700 bg-charcoal-900 px-3 py-3 text-base text-ink focus:border-teal-500 focus:outline-none"
            >
              {departments.length === 0 && <option value="">No departments</option>}
              {departments.map((d) => (
                <option key={d} value={d}>
                  {deptLabel(d)}
                </option>
              ))}
            </select>
          ) : (
            <div className="w-full rounded-lg border border-charcoal-700 bg-charcoal-900/60 px-3 py-3 text-base text-ink-muted">
              {ownDepartment ? deptLabel(ownDepartment) : "No department"}
            </div>
          )}
        </label>

        <label className="flex flex-col gap-1.5 sm:w-44">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-dim">Day</span>
          <input
            type="date"
            value={day}
            max={todayStr()}
            onChange={(e) => setDay(e.target.value)}
            className="w-full rounded-lg border border-charcoal-700 bg-charcoal-900 px-3 py-3 text-base text-ink focus:border-teal-500 focus:outline-none"
          />
        </label>
      </div>

      {/* Snap to fill — the shared <SnapFill> layer. Snap a dashboard photo OR
          paste/drop a row, and it pre-fills the rows it can confidently read for
          this department's metric whitelist. Additive: it fills the existing inputs,
          and every value stays editable and UNSAVED until you Save — which routes
          through the sanctioned manual lane (manual_value / origin), never api_value. */}
      {!noDepartment && visibleMetrics.length > 0 && (
        <SnapFill
          target={deptLabel(department)}
          schema={snapSchema}
          onFill={onSnapFill}
          modes={["photo", "paste"]}
          retainVision
        />
      )}

      {/* Save confirmation */}
      {summary && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            summary.failed > 0 || summary.evidenceFailed > 0 || summary.evidenceSkipped > 0
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
              : "border-teal-500/40 bg-teal-500/10 text-ink"
          }`}
        >
          <p className="font-semibold">
            {summary.failed > 0 || summary.evidenceFailed > 0 ? "⚠ Saved with issues" : "✓ Saved"}
          </p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {summary.saved} metric{summary.saved === 1 ? "" : "s"} recorded for {deptLabel(department)} on {day}.
            {summary.failed > 0 ? ` ${summary.failed} could not be saved.` : ""}
            {summary.evidenceSaved > 0
              ? ` ${summary.evidenceSaved} evidence attachment${summary.evidenceSaved === 1 ? "" : "s"} filed.`
              : ""}
            {summary.evidenceFailed > 0 ? ` ${summary.evidenceFailed} attachment(s) failed.` : ""}
            {summary.evidenceSkipped > 0
              ? ` ${summary.evidenceSkipped} attachment(s) skipped — enter a value on that row to attach evidence.`
              : ""}
          </p>
        </div>
      )}
      {error && (
        <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {/* Metric rows */}
      {noDepartment ? (
        <p className="rounded-xl border border-charcoal-700 bg-charcoal-900/60 px-4 py-6 text-center text-sm text-ink-muted">
          {canPickDepartment
            ? "Pick a department to start recording."
            : "You don't have a department with hand-enterable metrics yet."}
        </p>
      ) : visibleMetrics.length === 0 ? (
        <p className="rounded-xl border border-charcoal-700 bg-charcoal-900/60 px-4 py-6 text-center text-sm text-ink-muted">
          No hand-enterable metrics configured for {deptLabel(department)} yet.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-charcoal-800 overflow-hidden rounded-2xl border border-charcoal-700 bg-charcoal-900/40">
          {visibleMetrics.map((m) => {
            const raw = values[m.metric_key] ?? "";
            const staged = attachments[m.metric_key];
            const isOpen = openEvidence[m.metric_key] ?? false;
            const hasStaged = stagedFor(staged);
            const isAiRead = aiKeys.has(m.metric_key);
            return (
              <div
                key={m.metric_key}
                className={`flex flex-col px-4 py-3 ${isAiRead ? "bg-amber-500/5" : ""}`}
              >
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-sm text-ink">
                    {m.label}
                    {m.unit ? <span className="ml-1 text-[11px] text-ink-dim">({m.unit})</span> : null}
                    {isAiRead ? (
                      <span className="ml-2 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-amber-300">
                        AI-read · review me
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleEvidence(m.metric_key)}
                    aria-expanded={isOpen}
                    aria-label={`Attach evidence for ${m.label}`}
                    title="Attach evidence"
                    className={`rounded-lg border px-2.5 py-2 text-sm transition-colors ${
                      hasStaged
                        ? "border-teal-500/50 bg-teal-500/10 text-teal-300"
                        : "border-charcoal-700 bg-charcoal-900 text-ink-dim hover:text-ink"
                    }`}
                  >
                    <span aria-hidden>📎</span>
                    {hasStaged ? <span className="ml-1 text-[11px]">1</span> : null}
                  </button>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={raw}
                    placeholder="—"
                    onChange={(e) => setValue(m.metric_key, e.target.value)}
                    aria-label={isAiRead ? `${m.label} — AI-read, review before saving` : m.label}
                    className={`w-28 rounded-lg border px-3 py-2.5 text-right text-base font-semibold text-ink placeholder:text-ink-dim focus:outline-none ${
                      isAiRead
                        ? "border-amber-500/60 bg-amber-500/10 focus:border-amber-400"
                        : "border-charcoal-700 bg-charcoal-900 focus:border-teal-500"
                    }`}
                  />
                </div>

                {isOpen && (
                  <div className="mt-3 flex flex-col gap-2 rounded-lg border border-charcoal-800 bg-charcoal-950/50 p-3">
                    {/* A picked FILE collapses to a chip (so a keystroke can never
                        unmount a live input); a link is entered inline and stays
                        editable as you type. */}
                    {staged?.file ? (
                      <>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-ink-muted">
                            <span aria-hidden>🖼</span> {staged.file.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => clearEvidence(m.metric_key)}
                            className="shrink-0 rounded border border-charcoal-700 px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
                          >
                            Remove
                          </button>
                        </div>
                        <label className="flex items-center gap-2 text-[11px] text-ink-dim">
                          Type
                          <select
                            value={staged.kind}
                            onChange={(e) => setEvidenceKind(m.metric_key, e.target.value as EvidenceKind)}
                            className="rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-ink focus:border-teal-500 focus:outline-none"
                          >
                            <option value="photo">Photo</option>
                            <option value="screenshot">Screenshot</option>
                            <option value="video">Video</option>
                          </select>
                        </label>
                      </>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="cursor-pointer rounded-lg border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-xs text-ink-muted hover:text-ink">
                            <span aria-hidden>📷</span> Photo / video
                            <input
                              type="file"
                              accept="image/*,video/*"
                              className="hidden"
                              onChange={(e) => setEvidenceFile(m.metric_key, e.target.files?.[0] ?? null)}
                            />
                          </label>
                          <span className="text-[11px] text-ink-dim">or paste a link</span>
                        </div>
                        <input
                          type="url"
                          inputMode="url"
                          placeholder="https://…"
                          value={staged?.sourceUrl ?? ""}
                          onChange={(e) => setEvidenceLink(m.metric_key, e.target.value)}
                          className="w-full rounded-lg border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-teal-500 focus:outline-none"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Save action */}
      {!noDepartment && visibleMetrics.length > 0 && (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-2xl border border-charcoal-700 bg-charcoal-950/90 p-4 backdrop-blur">
          <p className="text-xs text-ink-muted">
            {loadingSaved
              ? "Loading saved values…"
              : enteredCount > 0
                ? `${enteredCount} value${enteredCount === 1 ? "" : "s"} ready to save${
                    attachedCount > 0 ? ` · ${attachedCount} with evidence` : ""
                  }.`
                : "Blank rows are left untouched."}
          </p>
          <button
            type="button"
            onClick={save}
            disabled={saving || enteredCount === 0}
            className="rounded-lg bg-teal-500 px-5 py-3 text-sm font-semibold text-charcoal-950 transition-colors hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save entries"}
          </button>
        </div>
      )}
    </div>
  );
}

// A row's staged evidence counts only if it actually has a file or a real link.
function stagedFor(s: StagedEvidence | undefined): boolean {
  if (!s) return false;
  return Boolean(s.file) || s.sourceUrl.trim() !== "";
}

// Upload one staged attachment against the metric_entry it substantiates. Returns
// whether the evidence was stored + recorded. Never throws to the caller.
async function uploadEvidence(entryId: string, staged: StagedEvidence): Promise<boolean> {
  try {
    const fd = new FormData();
    fd.set("entity_type", "metric_entry");
    fd.set("entity_id", entryId);
    fd.set("kind", staged.kind);
    if (staged.file) fd.set("file", staged.file);
    if (staged.sourceUrl.trim()) fd.set("source_url", staged.sourceUrl.trim());
    const res = await fetch("/api/quick-entry/evidence", { method: "POST", body: fd });
    return res.ok;
  } catch {
    return false;
  }
}
