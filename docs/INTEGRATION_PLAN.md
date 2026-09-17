# Mthryve OS — Platform Data Unification Plan (1.5-week sprint)

**Created:** 2026-07-07 (overnight, unattended) · **Owner:** Wolfie · **Author:** CTO agent
**Goal:** get *true, unified* commerce + ad data (TikTok Shop, Shopee, Meta/TikTok/Google Ads) into the OS on a daily/weekly cadence so decisions run on one system — within ~1.5 weeks.

---

## The reframe (read this first)

You asked to "integrate the platforms in 1.5 weeks." Full real-time API integration for four platforms is **not** honestly achievable in that window — but it's also **not what you need to save the business.** What you need is *unified true data for decisions*. That is achievable now, through a **data pipeline**, not real-time integrations. We separate the two:

- **Track A — manual-but-structured** for platforms we can't auto-connect fast (Shopee).
- **Track B — automated** for everything Windsor.ai already covers (Meta/TikTok/Google Ads, **and TikTok Shop**).

Real-time sync, write-back to platforms, and the full Warehouse/Finance/CRM modules are the *follow-on*, not this sprint.

---

## What I verified tonight (real, live)

**Windsor.ai coverage — better than expected:**

| Platform | Windsor connector? | Status | Track |
|---|---|---|---|
| Meta Ads | `facebook` | **Already connected** (1 account: "John Morales") | B (auto) |
| TikTok Ads | `tiktok` | Available, not connected | B (auto) |
| Google Ads | `google_ads` | Available, not connected | B (auto) |
| **TikTok Shop** | `tiktok_shop` | Available, not connected | B (auto) ← upgrade! |
| Shopee | *(none)* | Not covered by Windsor | A (manual template) |
| Meta organic | `facebook_organic` | 5 brand pages already connected (MPire, MThryve Digital, Keep It Em, M-fluence, MThryve Digital Marketing) | — |

**Key upgrade:** TikTok Shop has a Windsor connector, so your biggest commerce channel can be **automated**, not hand-keyed. Only **Shopee** stays on the manual template.

**Live Meta pull (last 90 days, the one connected account "John Morales"):**

| Campaign | Spend | Clicks | Impressions | Purchase value |
|---|---|---|---|---|
| TSHIRT WHOLESALE LEADS BROAD | ₱2,330 | 1,026 | 27,812 | none tracked |
| AFFILIATE 18\|35\|FEMALE 6/22 | ₱1,169 | 271 | 5,881 | none tracked |
| Post: BIG COSMETIC BRAND ELITE AFFILIATE | ₱3,090 | 732 | 15,465 | none tracked |
| **Total** | **≈₱6,590** | 2,029 | 49,158 | — |

**Two insights from this — worth your attention:**

1. **This account runs lead/affiliate-recruitment campaigns, not sales campaigns** — that's why there's no purchase ROAS (no purchase-conversion events tracked). For an affiliate agency that's sensible, but it means Meta ROAS won't attribute to GMV directly; your real sales attribution lives on TikTok Shop/Shopee.
2. **Only ONE Meta ad account is connected to Windsor.** Your brands almost certainly run ads on their own ad accounts that aren't linked yet. To see the true paid picture, every brand's ad account needs connecting (tomorrow).

---

## The revised pipeline

```
TikTok Shop  ─┐
Meta Ads     ─┤→  Windsor.ai  ─→  scheduled pull  ─→  Supabase (brand_platform_metrics, source='windsor')
TikTok Ads   ─┤
Google Ads   ─┘

Shopee       ──→  canonical CSV template (VAs)  ─→  OS import  ─→  Supabase (source='import')

                        └────────────→  CEO Command Center + brand×platform dashboards
```

---

## `brand_platform_metrics` — DEPRECATED for reads (PR 3, 2026-07-28)

**Do not source any figure from `brand_platform_metrics`.** Every GMV/commerce
surface now reads `public.tiktok_shop_performance` through
`lib/metrics/tiktok-live.ts` (the range-aware `orgWindow` / `sumBrandWindow`
helpers). That is the ONE source of truth: per-brand, per-client and company
figures reconcile by construction (company == Σ brands, both sides summing the
same per-(brand, day) rows).

Why it was retired (verified against the live DB on 2026-07-28, Asia/Manila):
`brand_platform_metrics` disagreed with `tiktok_shop_performance` on **every**
brand, in **both** directions — over-counting (e.g. Namiroseus, Basic City),
under-counting (e.g. FML), and **phantom revenue** for a brand with zero real GMV
(Amazing Pharma). `bpm max(updated_at) = 2026-07-22` while
`tiktok_shop_performance max(stat_date) = 2026-07-27`: its writer
(`lib/tiktok/reconcile.ts`) trails the live landing table by days, and FML /
Alianna were never reconciled into it at all (they read as 0).

What this means for engineers:
- **Reads:** none. If you need commerce/GMV, call `lib/metrics/tiktok-live.ts`.
  For a sales platform with no clean live pipe yet (Shopee, Lazada), render an
  honest null ("—" / "not connected") — never a `bpm` number, never a `0`.
- **Writes:** the reconcile/import path still lands rows (the table is NOT
  dropped — it keeps a historical/audit trail and the ad-metric columns TikTok
  Shop does not carry). Keeping the writer is deliberate; adding a new READER is
  not — don't.
- Marked deprecated in `database/migrations/0015_brand_platform_metrics.sql` and
  `lib/metrics/tiktok-live.ts`.

---

## Automation drivers — GitHub Actions is the scheduler (2026-07-29)

> **GitHub Actions is DECOMMISSIONED.** The GitHub Actions cloud workspace was deleted ("No active
> workspace"). It was the ONLY scheduler driving every automation route, so when
> it went dark the OS lost its heartbeat silently — the last successful sync
> wrote `2026-07-28 22:04Z` and nothing fired after it. Prior text in this doc
> saying *"GitHub Actions is NOT decommissioned … must stay running"* is **OBSOLETE**.
> **The scheduler is now `.github/workflows/automation-schedule.yml`** (GitHub
> Actions), for the same plan-independence reason the auth heartbeat already
> lives there: Vercel **Hobby** rejects sub-daily cron at deploy-parse time, so
> **no `crons` block is ever added to `vercel.json`**.

The routes themselves are **unchanged** — same paths, same constant-time bearer
auth. Only the *driver* changed: instead of GitHub Actions's Schedule nodes sending the
`AUTOMATION_API_KEY` bearer, a scheduled GitHub Actions workflow does.

### The workflow — `.github/workflows/automation-schedule.yml`

Four jobs. The three sync jobs POST to their route with
`Authorization: Bearer ${{ secrets.AUTOMATION_API_KEY }}`, staggered so the
rollup reads freshly-landed rows and products syncs after the shop tokens are
warm (times in UTC; Manila is UTC+8):

| Job | Cron (UTC) | Manila | Route (POST) |
|---|---|---|---|
| `tiktok-sync` | `0 22 * * *` | 06:00 | `/api/integrations/tiktok/sync` |
| `metrics-rollup` | `20 22 * * *` | 06:20 | `/api/automation/metrics-rollup` |
| `products-sync` | `40 22 * * *` | 06:40 | `/api/automation/products` |
| `staleness` | `50 22 * * *` | 06:50 | *(reads Supabase directly — see below)* |

**Fail loudly.** Each sync job captures the HTTP status and the body: a non-2xx
turns the run **RED** and echoes the response body into the job log. Curl is not
allowed to swallow the failure — a silent green check on a failed sync is the
exact failure mode this replaces (GitHub Actions saw a 200-from-a-`/login`-bounce and
reported "success" while 0 rows landed).

`metrics-rollup` still folds live signals into one `metrics_snapshots` row per
`(org_id, department_id, period)` — idempotent upsert on the natural key, Manila
"period ending yesterday" window, `source='rollup'` + `synced_at` stamped like
the TikTok landing tables. **`gmv_impact` reads `tiktok_shop_performance` through
`lib/metrics/tiktok-live`, never `metric_entries`** — so department health
reconciles with the Command Center by construction (the standing GMV rule). It
accepts `CRON_SECRET` **or** `AUTOMATION_API_KEY` and exports both `GET`/`POST`.
Optional query `?days=N` overrides the 30-day span.

### The `staleness` job — a dead scheduler becomes a RED check, not silence

A dead or auto-disabled scheduler is otherwise **invisible**: the last good rows
sit there and every GMV surface quietly goes stale. The `staleness` job reads
`max(stat_date)` from `tiktok_shop_performance` (via the Supabase REST API) and
**fails if the data is more than 2 days behind today (Asia/Manila)**. So a
scheduler that stops firing surfaces as a red check within ~2 days instead of
never. On manual dispatch the threshold is an input — set it to `0` to force a
RED drill and prove the tripwire works.

### KNOWN GitHub Actions limitations (documented, not ignored)

1. **Scheduled workflows auto-disable after 60 days of no repo commits.** GitHub
   turns off `schedule` triggers in a repository with no commit activity for 60
   days; if that happens NONE of these jobs fire — including `staleness` — and
   the only symptom is silence. This repo is committed to regularly, but do not
   rely on that alone: the app's own in-product watchdog
   (`/api/automation/sync-health-check`, still bearer-authed) alerts leadership
   independently, and if runs stop appearing, re-enable via **Actions →
   automation-schedule → "Enable workflow"** or push any commit.
2. **Scheduled runs are best-effort and can be delayed.** Under GitHub load a
   tick can drift several minutes or, rarely, be skipped. These are daily jobs
   with generous windows; the `staleness` job's 2-day tolerance absorbs a single
   missed tick without a false alarm.

### Manual runs (no terminal required)

Two ways to run on demand:
- **`workflow_dispatch`** — GitHub → **Actions → automation-schedule → "Run
  workflow"**. Pick a single job or leave it on **`all`** to run the whole daily
  sequence. This is the CEO's no-terminal button.
- The admin **"Run now"** panel in the app (separate PR, in flight) hits the same
  bearer routes.

### Secrets the workflow needs (GitHub → Settings → Secrets → Actions)

| Secret | Used by | Purpose |
|---|---|---|
| `AUTOMATION_API_KEY` | the three sync jobs | Bearer the automation routes accept — the same key GitHub Actions held. |
| `SUPABASE_URL` | `staleness` only | Project URL (`https://<ref>.supabase.co`; same value as `NEXT_PUBLIC_SUPABASE_URL`). |
| `SUPABASE_SERVICE_ROLE_KEY` | `staleness` only | `tiktok_shop_performance` is org-scoped RLS, so reading `max(stat_date)` across all orgs needs the service-role key. The sync jobs never receive it — they only send the bearer, exactly as GitHub Actions did. |

---

## What I built tonight (staged in your repo, NOT yet applied to live)

1. **`database/migrations/0015_brand_platform_metrics.sql`** — a per-brand × platform × period fact table (GMV, orders, units, returns, fulfillment_errors, ad_spend, ad_revenue, roas), org-scoped RLS, manager-only writes, `source` tracks import vs windsor. **PENDING — apply + commit together tomorrow** (it is in the repo but not yet in the live DB; that is the safe direction).
2. **`templates/brand_platform_import_template.csv`** — the canonical columns your VAs fill for Shopee (and any not-yet-connected platform): `brand, platform, period_start, period_end, gmv, orders, units, returns, fulfillment_errors, currency, notes`.
3. **This plan.**

I deliberately did **not**: apply 0015 to live, build the import UI, or connect any accounts — those need either your authorization or a review + preview-deploy, per the discipline we set today (never let live drift from the repo).

---

## Tomorrow's action list

### You (Wolfie) — the things only you can do
- [ ] **Authorize Windsor connections** for: TikTok Shop, TikTok Ads, Google Ads (I'll hand you one-click links). This is the unlock for Track B.
- [ ] **Connect every brand's Meta ad account** (not just "John Morales") so paid data is complete.
- [ ] **Decide the Shopee cadence** — daily or weekly VA export into the template.
- [ ] **Confirm your official-partner API status** for TikTok Shop / Shopee — partner credentials may let us replace even the manual Shopee path sooner.
- [ ] Sanity-check the Meta finding above — is "John Morales" really your only/primary Meta ad account?

### Me (CTO agent) — what I'll build once you're back
- [ ] Apply migration 0015 to live + commit it to the repo (together, no drift).
- [ ] Build the import route + a simple upload screen for the canonical template.
- [ ] Wire the Windsor → Supabase sync (a scheduled daily pull for connected ad accounts + TikTok Shop) writing `source='windsor'` rows.
- [ ] Build the brand × platform performance view and fold it into the CEO Command Center.
- [ ] Load real data, validate totals against numbers you trust, fix mapping gaps.

---

## Open decisions for you

1. **Ingestion mechanism for Track A:** in-app CSV upload, or point the OS at a shared Google Sheet the VAs already keep? (Windsor has a `googlesheets` connector, so the sheet path is viable and may fit your team's habits better.)
2. **Currency:** confirm PHP across the board (Windsor spend came back unlabeled — likely PHP; the schema defaults to PHP).
3. **Granularity:** weekly is assumed (matches your existing `metrics_snapshots` cadence). Say if you need daily.

---

## Honest boundaries (what this sprint does NOT deliver)

Real-time sync · pushing actions back to platforms · full Warehouse/Finance/CRM modules · automated Shopee (until partner API). Those are the follow-on weeks — but you'll be *operating on unified true data* well before then.
