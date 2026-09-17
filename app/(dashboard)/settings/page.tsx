import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, Badge } from "@/components/ui";
import { requireProfile, isLeadership } from "@/lib/auth/session";
import { tiktokMissingConfig } from "@/lib/tiktok/config";
import { getConnection, listShops } from "@/lib/tiktok/vault";
import { getConnectionSyncStatus } from "@/lib/tiktok/sync";
import { SyncNowButton } from "@/components/tiktok/SyncNowButton";
import { JOB_LIST } from "@/lib/automation/manual-jobs";
import { AutomationPanel, type AutomationJobView } from "@/components/settings/AutomationPanel";

// A run-row timestamp → "Jul 11, 2026, 4:02 AM" in Asia/Manila (the org's TZ).
function formatManila(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}

// Settings → Integrations. Leadership + department heads connect the org's
// external accounts here; everyone else sees the connection status read-only.
//
// TikTok Shop is the first integration on this page. It mirrors the Canva
// pattern: the OAuth round-trip reports back via ?tiktok_connected=1 (success),
// ?tiktok_error=<reason> (named failure), or ?tiktok_warn=shops_fetch_failed
// (connected, but the shop list didn't load) — so the flow is never silent.
//
// Force per-request (runtime) rendering on the Node.js runtime so server env
// vars — including Vercel "Sensitive" (runtime-only) vars like TIKTOK_APP_KEY /
// TIKTOK_APP_SECRET / TIKTOK_SERVICE_ID — are read fresh on every request rather
// than inlined at build time. This matches the /api/integrations/tiktok/* routes so the whole
// flow reads env the same way.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

// Named, human reasons for each ?tiktok_error flag the flow can produce.
const TIKTOK_ERROR_REASON: Record<string, string> = {
  missing_service_id:
    "the TikTok service ID isn’t configured (TIKTOK_SERVICE_ID). Add it and try again.",
  bad_state:
    "the security check failed (state mismatch or expired) — please start the connection again.",
  exchange_failed:
    "the token exchange with TikTok failed. Confirm the app key/secret and the redirect URI registered in Partner Center match this deployment (see /api/integrations/tiktok/diag).",
  save_failed: "the token couldn’t be saved to the vault (service-role / database issue).",
  exception: "something unexpected went wrong. Check the server logs for “[tiktok] callback exception”.",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: {
    tiktok_connected?: string;
    tiktok_error?: string;
    tiktok_warn?: string;
  };
}) {
  const profile = await requireProfile();

  const canManage =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";

  // The Automation panel is a leadership-only manual override for the scheduled
  // jobs (ceo/coo — the SAME leadership floor the admin route enforces). Only
  // read each job's real last-run timestamp when the panel will actually render.
  const showAutomation = isLeadership(profile.role);
  const automationJobs: AutomationJobView[] = showAutomation
    ? await Promise.all(
        JOB_LIST.map(async (job): Promise<AutomationJobView> => {
          const last = await job.lastRun(profile.org_id);
          return {
            key: job.key,
            name: job.name,
            description: job.description,
            lastRunLabel: last ? formatManila(last) : "never",
          };
        })
      )
    : [];

  // Read env INSIDE the request scope (not module-level) so runtime-only
  // "Sensitive" Vercel vars are visible per request. tiktokMissingConfig() names
  // the exact missing piece so the "not set up yet" copy is actionable.
  const missing = tiktokMissingConfig();
  const tiktokConfigured = missing === null;

  // Connection + shops read via the locked vault (service role). Never returns
  // tokens; safe to render. Both no-throw → calm empty states on any error.
  const connection = tiktokConfigured ? await getConnection(profile.org_id) : null;
  const shops = tiktokConfigured && connection ? await listShops(profile.org_id) : [];
  const connected = Boolean(connection);

  // Honest connection sync status (no tokens/PII): the CLASSIFIED commerce verdict
  // (orders/settlements), plus whether analytics is scope-denied. A run where GMV/
  // orders landed but the analytics endpoints skipped for a missing scope is a SYNCED
  // connection with an optional scope missing — it must never render as a red error.
  const syncStatus = connected ? await getConnectionSyncStatus(profile.org_id) : null;
  // Map the run-summary verdict to the badge label + tone. A missing verdict (no
  // run yet) shows nothing beyond the timestamp; a scope-only gap reads "synced".
  const verdict = syncStatus?.verdict ?? null;
  const isRed = verdict === "failed" || verdict === "auth_failed";
  const isAmber = verdict === "partial";
  const verdictLabel =
    verdict === "success"
      ? "synced"
      : verdict === "partial"
        ? "partial"
        : verdict === "auth_failed"
          ? "auth failed"
          : verdict === "failed"
            ? "failed"
            : null;

  // Post-flow banner. Success/warn/error flags from the callback round-trip.
  const errorFlag = (searchParams.tiktok_error ?? "").trim();
  const banner: { tone: "ok" | "warn" | "error"; text: string } | null =
    searchParams.tiktok_connected === "1"
      ? { tone: "ok", text: "TikTok Shop connected ✓ — your authorized shops are listed below." }
      : searchParams.tiktok_warn === "shops_fetch_failed"
        ? {
            tone: "warn",
            text: "TikTok Shop connected, but the shop list couldn’t be loaded. The connection is saved — reconnect to try fetching shops again.",
          }
        : errorFlag
          ? {
              tone: "error",
              text: `TikTok connection failed: ${
                TIKTOK_ERROR_REASON[errorFlag] ?? `TikTok reported “${errorFlag}”.`
              }`,
            }
          : null;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Settings"]} profile={profile}>
      <PageHeader
        title="Settings"
        subtitle="Connect the org’s external accounts. Tokens are stored server-side only and never exposed to the browser."
      />

      {banner && (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            banner.tone === "ok"
              ? "border-green-500/40 bg-green-500/10 text-green-300"
              : banner.tone === "error"
                ? "border-red-500/40 bg-red-500/10 text-red-300"
                : "border-gold-500/40 bg-gold-500/10 text-gold-300"
          }`}
        >
          {banner.text}
        </div>
      )}

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            🛍️ TikTok Shop
            {tiktokConfigured && connected && (
              <span className="inline-flex items-center gap-1 rounded-md border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-400">
                Connected ✓
              </span>
            )}
          </span>
        }
        action={
          tiktokConfigured && canManage ? (
            <div className="flex items-center gap-2">
              {connected && <SyncNowButton />}
              <a
                href="/api/integrations/tiktok/connect"
                className="inline-flex items-center gap-1.5 rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-2 text-xs font-medium text-teal-300 hover:bg-teal-500/20"
              >
                {connected ? "Reconnect TikTok Shop" : "Connect TikTok Shop"}
              </a>
            </div>
          ) : undefined
        }
      >
        {!tiktokConfigured ? (
          <p className="text-sm text-ink-muted">
            🛍️ TikTok Shop not set up yet
            {missing ? (
              <>
                {" "}
                — missing <span className="font-mono text-ink">{missing}</span>. Set the TikTok
                Partner env vars to enable the connection.
              </>
            ) : (
              "."
            )}
          </p>
        ) : !connected ? (
          <p className="text-sm text-ink-muted">
            No TikTok Shop connected yet.{" "}
            {canManage
              ? "Use “Connect TikTok Shop” above to authorize the org’s seller account."
              : "Ask a leadership member or your department head to connect the org’s seller account."}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Seller (connection) summary */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink">
                {connection?.seller_name || "TikTok seller"}
              </span>
              {connection?.region && <Badge tone="muted">{connection.region}</Badge>}
              {connection?.status && connection.status !== "active" && (
                <Badge tone="amber">{connection.status}</Badge>
              )}
            </div>

            {/* Last synced status — the CLASSIFIED commerce verdict, so an
                analytics-only scope gap never reddens a connection whose GMV synced. */}
            <p className="text-xs text-ink-muted">
              Last synced:{" "}
              <span className="text-ink">
                {syncStatus?.lastSyncedAt ? formatManila(syncStatus.lastSyncedAt) : "never"}
              </span>
              {verdictLabel && (
                <>
                  {" "}
                  <span
                    className={
                      isRed ? "text-red-300" : isAmber ? "text-gold-300" : "text-green-400"
                    }
                  >
                    ({verdictLabel})
                  </span>
                </>
              )}
              {" · runs daily at 04:00 Manila"}
            </p>

            {/* Analytics scope note — GMV/orders synced fine; only the optional
                Data/Analytics scope is missing, so traffic & conversion are blank.
                This is the fix for the "Reconnect forever" loop: not an error. */}
            {syncStatus?.analyticsScopeMissing && (
              <p className="rounded-md border border-gold-500/30 bg-gold-500/5 px-3 py-2 text-xs text-gold-300">
                Analytics unavailable (scope not granted) — GMV &amp; orders are
                syncing normally. Grant the Data/Analytics scope in TikTok to enable
                traffic &amp; conversion metrics; reconnecting without it won’t help.
              </p>
            )}

            {/* Authorized shops */}
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                Authorized shops
              </p>
              {shops.length === 0 ? (
                <p className="text-sm text-ink-dim">
                  No shops loaded yet. Reconnect to fetch the authorized shop list.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {shops.map((s) => (
                    <li
                      key={s.shop_id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-charcoal-700/60 bg-charcoal-950 px-3 py-2 text-sm"
                    >
                      <span className="text-ink">{s.shop_name || s.shop_id}</span>
                      {s.region && <Badge tone="muted">{s.region}</Badge>}
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-green-400">
                        Connected ✓
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SectionCard>

      {/* Automation — leadership-only manual override for the scheduled jobs.
          GitHub Actions stays the daily driver on the (unrevealable) automation key; this
          lets a leader fire the same work by hand, gated + audited + rate-limited
          server-side. The key is never exposed to the browser. */}
      {showAutomation && (
        <SectionCard
          title={<span className="flex items-center gap-2">⚙️ Automation</span>}
        >
          <p className="mb-4 text-sm text-ink-muted">
            Manually run a scheduled job now. GitHub Actions still drives these daily on its
            own schedule — this is the on-demand override for leadership. Each run
            is recorded in the{" "}
            <a href="/audit" className="text-teal-300 hover:underline">
              audit trail
            </a>
            .
          </p>
          <AutomationPanel jobs={automationJobs} />
        </SectionCard>
      )}
    </AppShell>
  );
}
