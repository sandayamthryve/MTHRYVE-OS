import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { notify, LEADERSHIP, type Shim } from "@/lib/notifications/notify";

// GET/POST /api/monitor/auth-health — the PRODUCTION SYNTHETIC MONITOR (Phase 0.4).
//
// Auto-promote is ON, so production needs a heartbeat that is INDEPENDENT of CI.
// This route fetches the live /login screen WITHOUT following redirects and
// classifies it:
//   • Healthy   = 200 + the sign-in form marker present.
//   • Unhealthy = any 3xx (redirect-loop signature), any 429 (rate limiter
//                 gating login), any non-200, or a missing form marker.
//
// It writes every result to system_health_checks (per org, RLS-consistent) and,
// on a transition INTO unhealthy, fires a loud leadership notification. A failed
// check is NEVER silently swallowed — that silence is exactly what let production
// /login 307-loop for ~2 weeks with the CEO as the only test suite.
//
// Two ways in, like the other cron routes (anomaly-scan / digest):
//   • The scheduled GitHub Actions heartbeat (.github/workflows/auth-heartbeat.yml,
//     every ~10 min) sends `Authorization: Bearer ${CRON_SECRET}`. (The schedule
//     lives in GitHub Actions, not vercel.json, because */5 Vercel Cron is Pro-only
//     and Hobby rejects the deployment at parse time.)
//   • An operator with AUTOMATION_API_KEY can trigger it manually.
// It is NOT publicly triggerable — the bearer check fails CLOSED when the secret
// is unset.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The production login screen this heartbeat probes. Overridable via env so a
// staging heartbeat can point elsewhere without a code change.
const DEFAULT_TARGET = "https://mthryve-os.vercel.app/login";
const REDIRECT_CODES = [301, 302, 307, 308];

// Constant-time compare, fails CLOSED when the expected secret is unset.
function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  const exp = expected?.trim();
  const prov = provided?.trim();
  if (!exp || !prov) return false;
  const a = Buffer.from(prov);
  const b = Buffer.from(exp);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Accept a Vercel-cron bearer (CRON_SECRET) or the shared AUTOMATION_API_KEY.
function bearerOk(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  const provided = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!provided) return false;
  return (
    secretMatches(provided, process.env.CRON_SECRET) ||
    secretMatches(provided, process.env.AUTOMATION_API_KEY)
  );
}

interface ProbeResult {
  status: "healthy" | "unhealthy";
  httpStatus: number | null;
  latencyMs: number;
  failureReason: string | null;
  targetUrl: string;
}

// The sign-in form marker. The /login route is a client component that Next still
// server-renders, so the initial HTML carries the form: an email field, a
// password field, and the "Sign in" affordance. All three must be present for a
// screen to count as healthy — a 200 shell with no form is still an outage.
function hasSignInMarker(html: string): boolean {
  return (
    html.includes('id="email"') &&
    html.includes('type="password"') &&
    html.includes("Sign in")
  );
}

// Fetch /login with redirects NOT followed and classify the response.
async function probeAuthHealth(targetUrl: string): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const res = await fetch(targetUrl, {
      method: "GET",
      redirect: "manual",
      // A synthetic, cookie-less probe — the exact condition that took prod down.
      headers: { "user-agent": "mthryve-os-auth-health-monitor" },
      cache: "no-store",
    });
    const latencyMs = Date.now() - startedAt;
    const httpStatus = res.status;

    if (REDIRECT_CODES.includes(httpStatus)) {
      const location = res.headers.get("location") ?? "";
      return {
        status: "unhealthy",
        httpStatus,
        latencyMs,
        failureReason: `redirect (${httpStatus}) — loop signature${location ? ` → ${location}` : ""}`,
        targetUrl,
      };
    }
    if (httpStatus === 429) {
      return {
        status: "unhealthy",
        httpStatus,
        latencyMs,
        failureReason: "429 rate-limited on GET /login",
        targetUrl,
      };
    }
    if (httpStatus !== 200) {
      return {
        status: "unhealthy",
        httpStatus,
        latencyMs,
        failureReason: `unexpected status ${httpStatus}`,
        targetUrl,
      };
    }

    const body = await res.text();
    if (!hasSignInMarker(body)) {
      return {
        status: "unhealthy",
        httpStatus,
        latencyMs,
        failureReason: "200 but missing sign-in form marker",
        targetUrl,
      };
    }

    return { status: "healthy", httpStatus, latencyMs, failureReason: null, targetUrl };
  } catch (err) {
    return {
      status: "unhealthy",
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      failureReason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      targetUrl,
    };
  }
}

async function allOrgIds(db: Shim): Promise<string[]> {
  try {
    const { data } = await db.from("organizations").select("id");
    return ((data as Array<{ id: string }> | null) ?? []).map((o) => o.id);
  } catch {
    return [];
  }
}

// Record the probe for one org, and — only on a transition INTO unhealthy — fire
// a loud leadership alert. Edge-triggered so a sustained outage doesn't re-spam
// every 5 minutes, but a fresh break always alerts.
async function recordForOrg(db: Shim, orgId: string, probe: ProbeResult): Promise<void> {
  let priorWasHealthy = true;
  try {
    const { data } = await db
      .from("system_health_checks")
      .select("status")
      .eq("org_id", orgId)
      .eq("check_type", "auth_login")
      .order("created_at", { ascending: false })
      .limit(1);
    const prior = (data as Array<{ status: string }> | null)?.[0];
    if (prior) priorWasHealthy = prior.status === "healthy";
  } catch {
    // If we can't read the prior state, err toward alerting on unhealthy.
    priorWasHealthy = true;
  }

  let insertedId: string | null = null;
  try {
    const { data } = await db
      .from("system_health_checks")
      .insert({
        org_id: orgId,
        check_type: "auth_login",
        status: probe.status,
        http_status: probe.httpStatus,
        latency_ms: probe.latencyMs,
        failure_reason: probe.failureReason,
        target_url: probe.targetUrl,
        detail: { source: "github_actions_heartbeat", monitor: "auth-health" },
      })
      .select("id")
      .single();
    insertedId = (data as { id: string } | null)?.id ?? null;
  } catch {
    // A failed write must not swallow the alert — we still notify below.
  }

  if (probe.status === "unhealthy" && priorWasHealthy) {
    await notify(
      {
        orgId,
        type: "auth_health_alert",
        title: "Production login screen is UNHEALTHY",
        body: `The auth heartbeat could not verify ${probe.targetUrl}: ${probe.failureReason}. This is the /login regression class that took production down for ~2 weeks — treat as a P0.`,
        severity: "critical",
        entityType: "system_health_checks",
        entityId: insertedId,
        roles: LEADERSHIP,
      },
      db
    );
  }
}

async function handle(req: NextRequest) {
  if (!bearerOk(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const targetUrl = process.env.MONITOR_AUTH_HEALTH_URL?.trim() || DEFAULT_TARGET;
  const probe = await probeAuthHealth(targetUrl);

  const db = createServiceRoleClient() as unknown as Shim;
  const orgs = await allOrgIds(db);
  for (const orgId of orgs) {
    await recordForOrg(db, orgId, probe);
  }

  // The probe result is the source of truth even if there are no orgs to record
  // into. A red heartbeat returns HTTP 200 from THIS route (the cron ran fine);
  // `status: "unhealthy"` in the body is the signal, surfaced in the OS UI +
  // leadership alert — never a silently-swallowed failure.
  return NextResponse.json({
    ok: true,
    status: probe.status,
    httpStatus: probe.httpStatus,
    latencyMs: probe.latencyMs,
    failureReason: probe.failureReason,
    targetUrl: probe.targetUrl,
    orgsRecorded: orgs.length,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
