import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, StatTile, Card, TableShell, rowClass, Badge } from "@/components/ui";
import { ScanAdOpsButton } from "@/components/ad-ops/ScanAdOpsButton";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readAdPerformance } from "@/lib/ad-ops/performance";
import { PLATFORM_LABEL, type AdCampaignPerformance } from "@/lib/ad-ops/types";
import { peso, EMPTY } from "@/lib/metrics/format";
import { isWindsorConfigured } from "@/lib/windsor/client";
import { last7 } from "@/lib/metrics/windows";

// Vesper Ad Ops (V3) — READS real TikTok + Meta ad performance via Windsor.ai
// and lets ceo/coo scan it into gated pause/scale/budget proposals. Nothing on
// this page moves money: every spend change goes through the Action & Approval
// Queue and is executed only on approval (DECISIONS.md D-005).
//
// Honest states: when Windsor isn't configured the page shows a calm "ad
// connector not configured" panel (no fabricated numbers); a per-platform read
// error is surfaced inline while the other platform's real data still shows.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

function money(n: number | null, currency: string): string {
  return n == null ? EMPTY : peso(n, currency);
}
function pct(n: number | null): string {
  return n == null ? EMPTY : `${n}%`;
}
function ratio(n: number | null): string {
  return n == null ? EMPTY : `${n}×`;
}
function intOr(n: number | null): string {
  return n == null ? EMPTY : new Intl.NumberFormat("en-US").format(n);
}

export default async function AdOpsPage() {
  const profile = await requireModule("/ad-ops");
  const canAct = profile.role === "ceo" || profile.role === "coo";
  const configured = isWindsorConfigured();
  const window = last7();

  const db = createServerSupabaseClient() as unknown as Shim;

  // Brands back the env brand→account map; also count open ad_ops proposals.
  const [brandsRes, openRes] = await Promise.all([
    db.from("brands").select("id, name"),
    db
      .from("action_requests")
      .select("id, status")
      .eq("source_module", "ad_ops")
      .in("status", ["pending"]),
  ]);
  const brands = ((brandsRes.data ?? []) as Array<{ id: string; name: string }>).map((b) => ({
    id: b.id,
    name: b.name,
  }));
  const pendingCount = (openRes.data ?? []).length;

  const perf = configured
    ? await readAdPerformance(brands, { datePreset: "last_7d" })
    : { configured: false as const, rows: [] as AdCampaignPerformance[], errors: [] };

  const rows = perf.rows;
  const totalSpend = rows.reduce((s, r) => s + (r.spend ?? 0), 0);
  const currency = rows[0]?.currency ?? "PHP";
  const mappedBrands = new Set(rows.filter((r) => r.brandId).map((r) => r.brandId)).size;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Ad Ops"]} profile={profile}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Vesper · Ad Ops"
          subtitle={
            <>
              Real TikTok &amp; Meta ad performance via Windsor.ai. Vesper reads and proposes; every
              pause / scale / budget change is approval-gated (ceo/coo) and executed only on approval —
              money never moves on its own.
            </>
          }
        />
        {canAct && configured && <ScanAdOpsButton />}
      </div>

      {/* ── Not configured: honest state, no fabricated data ───────────────── */}
      {!configured ? (
        <Card className="mt-6 border-amber-500/30">
          <p className="text-sm font-semibold text-amber-300">Ad connector not configured</p>
          <p className="mt-1 text-sm text-ink-muted">
            Vesper reads ad performance and writes approved changes through Windsor.ai. Set{" "}
            <code className="rounded bg-charcoal-800 px-1 py-0.5 font-mono text-xs">WINDSOR_API_KEY</code>{" "}
            (and, to attribute campaigns to brands,{" "}
            <code className="rounded bg-charcoal-800 px-1 py-0.5 font-mono text-xs">WINDSOR_BRAND_MAP</code>){" "}
            in the environment, then reload. Until then no ad data is shown — nothing here is estimated
            or mocked.
          </p>
          <p className="mt-2 text-xs text-ink-dim">
            Diagnostics:{" "}
            <code className="font-mono">/api/integrations/ad-ops/diag</code> reports whether the key is
            set (booleans only — the key is never returned).
          </p>
        </Card>
      ) : (
        <>
          {/* KPI row */}
          <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="Campaigns" value={intOr(rows.length)} hint={window.label} />
            <StatTile label="Spend (window)" value={money(totalSpend, currency)} hint={window.label} />
            <StatTile label="Brands mapped" value={intOr(mappedBrands)} hint="via WINDSOR_BRAND_MAP" />
            <StatTile
              label="Pending proposals"
              value={intOr(pendingCount)}
              hint={pendingCount > 0 ? "awaiting ceo/coo" : "none open"}
            />
          </div>

          {/* Per-platform read errors — surfaced, never hidden. */}
          {perf.errors.length > 0 && (
            <Card className="mt-4 border-red-500/30">
              <p className="text-sm font-semibold text-red-400">Some platforms could not be read</p>
              <ul className="mt-1 space-y-0.5">
                {perf.errors.map((e, i) => (
                  <li key={i} className="text-xs text-ink-muted">
                    <span className="font-medium text-ink">
                      {PLATFORM_LABEL[e.platform as keyof typeof PLATFORM_LABEL] ?? e.platform}
                    </span>{" "}
                    — {e.message}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Performance table */}
          <section className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Campaign performance · {window.label}</h2>
              {pendingCount > 0 && (
                <Link href="/approvals" className="text-xs text-teal-300 underline hover:text-teal-200">
                  {pendingCount} proposal{pendingCount === 1 ? "" : "s"} in the approval queue →
                </Link>
              )}
            </div>

            {rows.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-muted">
                  No campaign data returned for {window.label}. This is a real empty result from Windsor
                  — nothing is fabricated. If you expect data, confirm the connectors are authed and the
                  accounts have spend in the window.
                </p>
              </Card>
            ) : (
              <TableShell
                columns={["Platform", "Brand", "Campaign", "Spend", "ROAS", "Conv.", "CTR", "CPC"]}
              >
                {rows.map((r) => (
                  <tr key={`${r.connector}-${r.accountId}-${r.campaignId}`} className={rowClass}>
                    <td className="p-3">
                      <Badge tone={r.platform === "tiktok_ads" ? "violet" : "teal"}>
                        {PLATFORM_LABEL[r.platform]}
                      </Badge>
                    </td>
                    <td className="p-3 text-ink-muted">
                      {r.brandName ?? <span className="text-ink-dim">Unmapped</span>}
                    </td>
                    <td className="p-3">
                      <span className="text-ink">{r.campaignName}</span>
                      <span className="block font-mono text-[10px] text-ink-dim">
                        {r.accountName ?? r.accountId}
                      </span>
                    </td>
                    <td className="p-3 text-ink">{money(r.spend, r.currency)}</td>
                    <td className="p-3 text-ink-muted">{ratio(r.roas)}</td>
                    <td className="p-3 text-ink-muted">{intOr(r.conversions)}</td>
                    <td className="p-3 text-ink-muted">{pct(r.ctr)}</td>
                    <td className="p-3 text-ink-muted">{money(r.cpc, r.currency)}</td>
                  </tr>
                ))}
              </TableShell>
            )}

            <p className="mt-3 text-xs text-ink-dim">
              ROAS / Conversions show{" "}
              <span className="font-mono">{EMPTY}</span> where the connected account doesn't expose that
              metric — Vesper shows only what Windsor actually returns and never invents a figure. Rules
              degrade to the strongest available signal (ROAS → CPA → clicks/CTR) when proposing a
              change.
            </p>
          </section>
        </>
      )}
    </AppShell>
  );
}
