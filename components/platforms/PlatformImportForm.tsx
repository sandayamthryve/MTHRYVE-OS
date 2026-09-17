"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { BrandPlatformMetricsInsert, PlatformChannel } from "@/types/database";

type Brand = { id: string; name: string };

const PLATFORMS = [
  "tiktok_shop",
  "shopee",
  "lazada",
  "meta_ads",
  "tiktok_ads",
  "google_ads",
  "other",
];

// Bulk import of the canonical brand × platform template
// (templates/brand_platform_import_template.csv). A manager pastes rows; each is
// upserted into brand_platform_metrics with source='import' (RLS: managers only,
// so re-pasting a week updates it rather than duplicating). This is the Track A
// path for Shopee and anything not yet auto-connected via Windsor.
//
// NOTE (PR 3): brand_platform_metrics is DEPRECATED for reads — no commerce surface
// reads these imported rows for its figures anymore (the OS reads live
// tiktok_shop_performance). This write path is kept so import history survives and
// so a future clean pipe can supersede it, but imported numbers no longer feed any
// headline figure. See docs/INTEGRATION_PLAN.md.
export function PlatformImportForm({
  orgId,
  userId,
  brands,
}: {
  orgId: string;
  userId: string;
  brands: Brand[];
}) {
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okCount, setOkCount] = useState<number | null>(null);

  const brandByName = new Map(brands.map((b) => [b.name.trim().toLowerCase(), b.id]));

  function normPlatform(v: string): PlatformChannel | null {
    const s = (v ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    return (PLATFORMS as readonly string[]).includes(s) ? (s as PlatformChannel) : null;
  }
  function toNum(v: string): number | null {
    const t = (v ?? "").trim();
    if (t === "") return null;
    const n = Number(t.replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  async function handleImport() {
    setBusy(true);
    setError(null);
    setOkCount(null);

    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setError("Paste at least one row.");
      setBusy(false);
      return;
    }
    if (lines[0].toLowerCase().startsWith("brand,")) lines.shift();

    const rows: BrandPlatformMetricsInsert[] = [];
    const problems: string[] = [];

    lines.forEach((line, idx) => {
      const f = line.split(",");
      const brandRaw = (f[0] ?? "").trim();
      const brandId = brandByName.get(brandRaw.toLowerCase());
      const platform = normPlatform(f[1] ?? "");
      const periodStart = (f[2] ?? "").trim();
      const periodEnd = (f[3] ?? "").trim();

      if (!brandId) {
        problems.push(`Row ${idx + 1}: unknown brand “${brandRaw}”`);
        return;
      }
      if (!platform) {
        problems.push(`Row ${idx + 1}: unknown platform “${(f[1] ?? "").trim()}”`);
        return;
      }
      if (!periodStart || !periodEnd) {
        problems.push(`Row ${idx + 1}: period_start and period_end are required`);
        return;
      }

      rows.push({
        org_id: orgId,
        brand_id: brandId,
        platform,
        period_start: periodStart,
        period_end: periodEnd,
        gmv: toNum(f[4] ?? ""),
        orders: toNum(f[5] ?? ""),
        units: toNum(f[6] ?? ""),
        returns: toNum(f[7] ?? ""),
        fulfillment_errors: toNum(f[8] ?? ""),
        currency: ((f[9] ?? "").trim() || "PHP").toUpperCase(),
        source: "import",
        imported_by: userId,
      });
    });

    if (problems.length) {
      setError(
        problems.slice(0, 6).join(" · ") +
          (problems.length > 6 ? ` · +${problems.length - 6} more` : "")
      );
      setBusy(false);
      return;
    }

    // The @supabase/ssr typed client resolves write payloads to `never`
    // (see CHANGELOG 2026-07-06). `rows` is still type-checked as
    // BrandPlatformMetricsInsert[] at construction; we cast only at the call.
    const { error: upErr } = await supabase
      .from("brand_platform_metrics")
      .upsert(rows as never, {
        onConflict: "org_id,brand_id,platform,period_start,period_end,source",
      });

    setBusy(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setOkCount(rows.length);
    setText("");
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink"
      >
        + Import platform data
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
      <p className="mb-2 text-xs text-ink-muted">
        Paste rows from the template —{" "}
        <span className="font-mono text-[11px]">
          brand,platform,period_start,period_end,gmv,orders,units,returns,fulfillment_errors,currency
        </span>
        . Platform is one of: tiktok_shop, shopee, lazada, meta_ads, tiktok_ads, google_ads. Dates are
        YYYY-MM-DD. Re-pasting a week updates it.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        spellCheck={false}
        placeholder="FML,shopee,2026-06-29,2026-07-05,125000,340,512,18,4,PHP"
        className="w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-2 font-mono text-xs text-ink placeholder:text-ink-muted focus:border-teal-500"
      />
      {error && <p className="mt-2 text-sm text-gold-400">{error}</p>}
      {okCount != null && (
        <p className="mt-2 text-sm text-green-400">
          Imported {okCount} row{okCount === 1 ? "" : "s"}.
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={handleImport}
          disabled={busy}
          className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {busy ? "Importing…" : "Import"}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
        >
          Close
        </button>
      </div>
    </div>
  );
}
