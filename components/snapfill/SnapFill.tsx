"use client";

// components/snapfill/SnapFill.tsx — the ONE reusable "snap to fill" input layer.
//
// A fill-ONLY widget: a mount hands it a `schema` (its cluster's FIELD WHITELIST)
// and an `onFill` callback, and SnapFill returns { key: value } for only the
// whitelisted keys via one of two modes:
//   • PASTE  — drop / paste structured text (a copied spreadsheet row, CSV/TSV, or
//              "Label: value" lines); parsed inline against the whitelist.
//   • PHOTO  — snap / drop / pick an image; the existing vision reader extracts only
//              the whitelisted fields off it.
// Anything not on the whitelist is ignored; a field it can't read is omitted
// (honest nulls — never a fabricated value).
//
// It NEVER writes. The host merges the result into its own form state and commits
// through its existing, already-role-gated write path — so on a metric cluster the
// values still travel the sanctioned manual lane (manual_value / origin='vision')
// and can never overwrite an API-synced value. Same role-gate as editing that
// cluster, because it's the host's own form doing the write.

import { useRef, useState } from "react";
import { parseStructuredText } from "@/lib/snapfill/parse";
import type { SnapFillResult, SnapSchema } from "@/lib/snapfill/schema";

export type SnapMode = "paste" | "photo";

export function SnapFill({
  target,
  schema,
  onFill,
  modes = ["paste", "photo"],
  retainVision = false,
  title = "Snap to fill",
  className = "",
}: {
  /** Short context label shown to the vision model + in the UI (e.g. "Affiliate creator"). */
  target: string;
  /** This cluster's field whitelist — the ONLY keys SnapFill may fill. */
  schema: SnapSchema;
  /** Called with the filled values (+ provenance). The host applies them to its form. */
  onFill: (result: SnapFillResult) => void;
  /** Which modes to offer. Defaults to both. */
  modes?: SnapMode[];
  /** Keep the snapped image as an evidence object (metric grid) vs read-and-discard. */
  retainVision?: boolean;
  title?: string;
  className?: string;
}) {
  const hasPaste = modes.includes("paste");
  const hasPhoto = modes.includes("photo");
  const [mode, setMode] = useState<SnapMode>(hasPhoto && !hasPaste ? "photo" : "paste");

  const [pasteText, setPasteText] = useState("");
  const [snapping, setSnapping] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [msg, setMsg] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const pickInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Paste mode ────────────────────────────────────────────────────────────
  function runPaste(text: string) {
    const { values, filledKeys, ignored } = parseStructuredText(text, schema);
    if (filledKeys.length === 0) {
      setMsg({
        kind: "error",
        text: "Couldn't match any fields. Paste a row with headers, or “Label: value” lines.",
      });
      return;
    }
    onFill({ values, filledKeys, source: "paste", ignored });
    setMsg({
      kind: "info",
      text:
        `Filled ${filledKeys.length} field${filledKeys.length === 1 ? "" : "s"} — review before saving.` +
        (ignored.length ? ` Ignored: ${ignored.slice(0, 4).join(", ")}${ignored.length > 4 ? "…" : ""}.` : ""),
    });
  }

  // The mount's whitelist, serialized once for the server routes (vision + import).
  const schemaJson = () =>
    JSON.stringify(schema.map((f) => ({ key: f.key, label: f.label, type: f.type ?? "text", unit: f.unit ?? null })));

  // A file dropped on the paste zone routes by KIND — never read a spreadsheet as
  // text (that dumps its raw "PK…" ZIP bytes into the fields):
  //   • image        → Photo/vision path;
  //   • .xlsx/.xlsm/.xls (or an Excel MIME) → SERVER xlsx parser (the same exceljs
  //     path bulk import uses), then fill from the first row;
  //   • .csv/.txt/other text → read as text → text parser.
  async function onDropFile(file: File) {
    const name = file.name.toLowerCase();
    const isImage = file.type.startsWith("image/");
    const isSpreadsheet =
      name.endsWith(".xlsx") ||
      name.endsWith(".xlsm") ||
      name.endsWith(".xls") ||
      file.type.includes("spreadsheet") ||
      file.type === "application/vnd.ms-excel";

    if (isImage) {
      setMode("photo");
      await onSnap(file);
      return;
    }
    if (isSpreadsheet) {
      await onSpreadsheet(file);
      return;
    }
    try {
      const text = await file.text();
      setPasteText(text);
      runPaste(text);
    } catch {
      setMsg({ kind: "error", text: "Couldn't read that file — paste the rows instead." });
    }
  }

  // Send a dropped spreadsheet to the SERVER parser (ArrayBuffer over the wire, never
  // readAsText) and fill from the FIRST parsed row. Records are already sanitized +
  // whitelist-mapped server-side; we clamp again on the client for safety.
  async function onSpreadsheet(file: File) {
    if (parsing || snapping) return;
    setParsing(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("schema", schemaJson());
      const res = await fetch("/api/snapfill/import", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        records?: Record<string, string>[];
        ignoredHeaders?: string[];
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setMsg({ kind: "error", text: data.error || "Couldn't read that spreadsheet — export a .csv and try again." });
        return;
      }
      const record = data.records?.[0] ?? null;
      const allowed = new Set(schema.map((f) => f.key));
      const values: Record<string, string> = {};
      if (record) {
        for (const [k, v] of Object.entries(record)) {
          if (allowed.has(k) && v != null && String(v) !== "") values[k] = String(v);
        }
      }
      const filledKeys = Object.keys(values);
      if (filledKeys.length === 0) {
        setMsg({ kind: "error", text: "No readable rows in that spreadsheet — check the header row." });
        return;
      }
      const ignored = data.ignoredHeaders ?? [];
      onFill({ values, filledKeys, source: "paste", ignored });
      setMsg({
        kind: "info",
        text:
          `Filled ${filledKeys.length} field${filledKeys.length === 1 ? "" : "s"} from the spreadsheet — review before saving.` +
          (ignored.length ? ` Ignored: ${ignored.slice(0, 4).join(", ")}${ignored.length > 4 ? "…" : ""}.` : ""),
      });
    } catch {
      setMsg({ kind: "error", text: "Couldn't read that spreadsheet — export a .csv and try again." });
    } finally {
      setParsing(false);
    }
  }

  // ── Photo mode ────────────────────────────────────────────────────────────
  function resetSnapInputs() {
    if (pickInputRef.current) pickInputRef.current.value = "";
    if (cameraInputRef.current) cameraInputRef.current.value = "";
  }

  async function onSnap(file: File | null) {
    if (!file || snapping) return;
    setSnapping(true);
    setMsg(null);

    let normalized: File | null;
    try {
      normalized = await normalizeForVision(file);
    } catch {
      normalized = null;
    }
    if (!normalized) {
      setMsg({ kind: "error", text: "Couldn't read that image — try a PNG/JPG, or enter the details manually." });
      setSnapping(false);
      resetSnapInputs();
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const fd = new FormData();
      fd.set("image", normalized);
      fd.set("target", target);
      fd.set("schema", schemaJson());
      fd.set("retain", retainVision ? "1" : "0");
      const res = await fetch("/api/snapfill/vision", { method: "POST", body: fd, signal: controller.signal });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        values?: Record<string, string | number>;
        extract?: Record<string, unknown>;
        model?: string;
        storage_path?: string | null;
        reason?: string;
      };
      if (!res.ok || !data.ok) {
        setMsg({ kind: "error", text: data.reason || "Couldn't read it — enter the details manually." });
        return;
      }

      // Clamp to the whitelist again on the client and stringify for the form.
      const allowed = new Set(schema.map((f) => f.key));
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.values ?? {})) {
        if (!allowed.has(k)) continue;
        if (v === null || v === undefined) continue;
        values[k] = String(v);
      }
      const filledKeys = Object.keys(values);
      if (filledKeys.length === 0) {
        setMsg({ kind: "error", text: "Nothing legible to read — enter the details manually." });
        return;
      }
      onFill({
        values,
        filledKeys,
        source: "photo",
        vision: {
          storagePath: data.storage_path ?? null,
          extract: data.extract ?? {},
          model: data.model ?? "",
        },
      });
      setMsg({
        kind: "info",
        text: `AI read ${filledKeys.length} field${filledKeys.length === 1 ? "" : "s"}. Review and edit each before saving — nothing is saved yet.`,
      });
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      setMsg({
        kind: "error",
        text: aborted ? "Reading took too long — enter manually for now." : "Couldn't read it — enter the details manually.",
      });
    } finally {
      clearTimeout(timer);
      setSnapping(false);
      resetSnapInputs();
    }
  }

  const onlyOneMode = modes.length === 1;

  return (
    <div className={`flex flex-col gap-2 rounded-2xl border border-charcoal-700 bg-charcoal-900/50 p-3 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-dim">{title}</span>
        {!onlyOneMode && (
          <div className="flex rounded-lg border border-charcoal-700 bg-charcoal-950 p-0.5 text-xs">
            {hasPaste && (
              <button
                type="button"
                onClick={() => { setMode("paste"); setMsg(null); }}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${mode === "paste" ? "bg-teal-500 text-charcoal-950" : "text-ink-muted hover:text-ink"}`}
              >
                Paste / drop
              </button>
            )}
            {hasPhoto && (
              <button
                type="button"
                onClick={() => { setMode("photo"); setMsg(null); }}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${mode === "photo" ? "bg-teal-500 text-charcoal-950" : "text-ink-muted hover:text-ink"}`}
              >
                Photo
              </button>
            )}
          </div>
        )}
      </div>

      {mode === "paste" && hasPaste && (
        <div className="flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv,.txt,.xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onDropFile(f);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <div
            onDragOver={(e) => { if (parsing) return; e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (parsing) return;
              const f = e.dataTransfer.files?.[0];
              if (f) { void onDropFile(f); return; }
              const t = e.dataTransfer.getData("text");
              if (t) { setPasteText(t); runPaste(t); }
            }}
            className={`relative rounded-xl border-2 border-dashed p-2 transition-colors ${dragOver ? "border-teal-400 bg-teal-500/10" : "border-charcoal-700"}`}
          >
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              onPaste={(e) => {
                const t = e.clipboardData.getData("text");
                if (t) { setPasteText(t); setTimeout(() => runPaste(t), 0); }
              }}
              rows={3}
              disabled={parsing}
              placeholder={`Paste a row (with headers) or "Label: value" lines, or drop a .csv / .xlsx here. Maps to: ${schema.map((f) => f.label).slice(0, 6).join(", ")}${schema.length > 6 ? "…" : ""}`}
              className="w-full resize-y rounded-lg border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink placeholder:text-ink-dim focus:border-teal-500 focus:outline-none disabled:opacity-50"
            />
            {parsing && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-charcoal-950/70 text-sm font-semibold text-teal-300">
                Parsing spreadsheet…
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={parsing}
              className="text-[11px] font-medium text-teal-300 hover:text-teal-200 disabled:opacity-50"
            >
              or choose a .csv / .xlsx file
            </button>
            <button
              type="button"
              onClick={() => runPaste(pasteText)}
              disabled={!pasteText.trim() || parsing}
              className="rounded-lg bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 transition-colors hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Fill fields
            </button>
          </div>
        </div>
      )}

      {mode === "photo" && hasPhoto && (
        <div className="flex flex-col gap-2">
          <input ref={pickInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onSnap(e.target.files?.[0] ?? null)} />
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onSnap(e.target.files?.[0] ?? null)} />
          <div
            role="button"
            tabIndex={snapping ? -1 : 0}
            aria-disabled={snapping}
            aria-label="Snap to fill — drag a photo here or click to choose a file"
            onClick={() => { if (!snapping) pickInputRef.current?.click(); }}
            onKeyDown={(e) => { if (!snapping && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pickInputRef.current?.click(); } }}
            onDragOver={(e) => { if (snapping) return; e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (snapping) return; const f = e.dataTransfer.files?.[0]; if (f) void onSnap(f); }}
            className={`flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors ${dragOver ? "border-teal-400 bg-teal-500/15" : "border-charcoal-700 bg-charcoal-900/40 hover:border-teal-500/50"} ${snapping ? "pointer-events-none opacity-60" : ""}`}
          >
            <span className="text-xl" aria-hidden>📸</span>
            <p className="text-sm font-semibold text-ink">{snapping ? "Reading photo…" : "Snap a photo"}</p>
            <p className="text-[11px] text-ink-dim">
              Drop an image or <span className="font-medium text-teal-300">click to choose</span>. The AI fills what it can read — you review before saving.
            </p>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); if (!snapping) cameraInputRef.current?.click(); }}
              disabled={snapping}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-teal-500/50 bg-teal-500/10 px-2.5 py-1 text-[11px] font-semibold text-teal-300 transition-colors hover:bg-teal-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden>📷</span> Use camera
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className={`rounded-lg border px-3 py-2 text-xs ${msg.kind === "error" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-teal-500/40 bg-teal-500/10 text-ink"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ── Client-side image normalization (shared by every photo snap) ──────────────
// Longest edge 1024px, JPEG quality 0.72 — a dashboard/profile stays legible while
// the payload drops to tens of KB, keeping the vision function well clear of the
// timeout/OOM that 502-s raw uploads. The ORIGINAL bytes never leave the browser:
// odd formats (.jfif / HEIC / transparent PNG) are decoded, drawn to a canvas, and
// re-encoded as a small JPEG. Returns null if the image can't be decoded/drawn.
const VISION_MAX_EDGE = 1024;
const VISION_JPEG_QUALITY = 0.72;

async function normalizeForVision(file: File): Promise<File | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge === 0) return null;
    const scale = longEdge > VISION_MAX_EDGE ? VISION_MAX_EDGE / longEdge : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", VISION_JPEG_QUALITY));
    if (!blob || blob.size === 0) return null;

    const base = file.name.replace(/\.[^.]+$/, "") || "snap";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
