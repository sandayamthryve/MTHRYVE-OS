import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, Card, TableShell, rowClass, Badge, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { sendTelegram, escapeHtml } from "@/lib/telegram";
import type { UserRole } from "@/types/database";

// AI Governance (DECISIONS.md D-012). Model tier follows role by default; a
// time-boxed upgrade is requested through the approval queue and, once a CEO/COO
// approves it, produces a model_grant the Content Studio route honours until it
// expires. This page is the request desk, the approval queue, and the CEO's
// usage-visibility panel in one.

type Tier = "lite" | "standard" | "premium";

const TIER_ORDER: Record<Tier, number> = { lite: 0, standard: 1, premium: 2 };
const TIER_LABEL: Record<Tier, string> = { lite: "Lite", standard: "Standard", premium: "Premium" };
const MODEL_BY_TIER: Record<Tier, string> = {
  lite: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  premium: "claude-opus-4-8",
};
const DEFAULT_TIER_BY_ROLE: Record<UserRole, Tier> = {
  ceo: "premium",
  coo: "premium",
  department_head: "standard",
  team_member: "lite",
};
const DURATIONS = [7, 14, 30] as const;

function defaultTierFor(role: UserRole): Tier {
  return DEFAULT_TIER_BY_ROLE[role] ?? "lite";
}

// Tiers strictly above the caller's default — what they are allowed to request.
function tiersAbove(role: UserRole): Tier[] {
  const floor = TIER_ORDER[defaultTierFor(role)];
  return (Object.keys(TIER_ORDER) as Tier[]).filter((t) => TIER_ORDER[t] > floor);
}

type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<{ error: unknown }>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

type ApprovalRow = {
  id: string;
  requested_by: string | null;
  action_type: string;
  title: string;
  payload: { requested_tier?: Tier; reason?: string; duration_days?: number } | null;
  status: "pending" | "approved" | "rejected";
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
};
type GrantRow = {
  id: string;
  user_id: string;
  tier: Tier;
  granted_by: string | null;
  expires_at: string | null;
  created_at: string;
};
type UserRow = { id: string; full_name: string; role: UserRole };
type GenerationRow = { created_by: string | null; model: string | null; created_at: string };

async function requestUpgrade(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
    role: UserRole;
    full_name: string;
  };
  const allowed = tiersAbove(profile.role);
  const requested_tier = String(formData.get("requested_tier") ?? "") as Tier;
  const reason = String(formData.get("reason") ?? "").trim();
  const duration_days = Number(formData.get("duration_days") ?? 0);
  if (!allowed.includes(requested_tier)) return;
  if (!reason) return;
  if (!DURATIONS.includes(duration_days as (typeof DURATIONS)[number])) return;

  const supabase = createServerSupabaseClient();
  const title = `Model upgrade to ${TIER_LABEL[requested_tier]}`;
  const { error: insertError } = await (supabase as unknown as DbShim)
    .from("approval_requests")
    .insert({
      org_id: profile.org_id,
      requested_by: profile.id,
      action_type: "model_upgrade",
      title,
      risk_tier: "LOW",
      status: "pending",
      payload: { requested_tier, reason, duration_days },
    });

  // Ping the team group so a reviewer sees the request without polling the
  // queue. Best-effort: awaited but swallowed — the approval must land even if
  // Telegram is down (sendTelegram never throws).
  if (!insertError) {
    const summary = `Requested by ${profile.full_name} — ${reason}`;
    await sendTelegram(
      `🔔 <b>Approval needed</b>\n${escapeHtml(title)}\n${escapeHtml(summary)}\nReview: https://mthryve-os.vercel.app/approvals`,
    );
  }
  revalidatePath("/ai-governance");
}

async function approveUpgrade(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as { id: string; org_id: string };
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("approval_requests")
    .select("id, org_id, requested_by, payload, status, action_type")
    .eq("id", id)
    .single();
  const req = data as unknown as
    | { id: string; org_id: string; requested_by: string | null; payload: ApprovalRow["payload"]; status: string; action_type: string }
    | null;
  if (!req || req.status !== "pending" || req.action_type !== "model_upgrade" || !req.requested_by) return;

  const tier = (req.payload?.requested_tier ?? "standard") as Tier;
  const durationDays = Number(req.payload?.duration_days ?? 7) || 7;
  const now = new Date();
  const expires = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  await (supabase as unknown as DbShim)
    .from("approval_requests")
    .update({ status: "approved", reviewed_by: profile.id, reviewed_at: now.toISOString() })
    .eq("id", id);

  await (supabase as unknown as DbShim).from("model_grants").insert({
    org_id: req.org_id,
    user_id: req.requested_by,
    tier,
    reason: req.payload?.reason ?? null,
    request_id: req.id,
    granted_by: profile.id,
    expires_at: expires.toISOString(),
  });
  revalidatePath("/ai-governance");
}

async function rejectUpgrade(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as { id: string };
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("approval_requests")
    .update({ status: "rejected", reviewed_by: profile.id, reviewed_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/ai-governance");
}

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "teal",
  approved: "teal",
  rejected: "muted",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

export default async function AIGovernancePage() {
  const profile = await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const canManage = profile.role === "ceo" || profile.role === "coo";
  const myTier = defaultTierFor(profile.role);
  const upgradeOptions = tiersAbove(profile.role);
  const nowIso = new Date().toISOString();
  const supabase = createServerSupabaseClient();

  const [grantsRes, myReqRes, usersRes, pendingRes, gensRes] = await Promise.all([
    // Active grants — CEO/COO see all in the org, everyone else only their own.
    (() => {
      let q = supabase
        .from("model_grants")
        .select("id, user_id, tier, granted_by, expires_at, created_at")
        .gt("expires_at", nowIso)
        .order("expires_at", { ascending: true });
      if (!canManage) q = q.eq("user_id", profile.id);
      return q;
    })(),
    // The caller's own upgrade requests.
    supabase
      .from("approval_requests")
      .select("id, requested_by, action_type, title, payload, status, reviewed_by, reviewed_at, created_at")
      .eq("action_type", "model_upgrade")
      .eq("requested_by", profile.id)
      .order("created_at", { ascending: false }),
    supabase.from("users").select("id, full_name, role"),
    // Pending queue (only used by CEO/COO).
    canManage
      ? supabase
          .from("approval_requests")
          .select("id, requested_by, action_type, title, payload, status, reviewed_by, reviewed_at, created_at")
          .eq("action_type", "model_upgrade")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
    // Usage aggregation (only used by CEO/COO) — org-scoped SELECT.
    canManage
      ? supabase.from("content_generations").select("created_by, model, created_at")
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const grants = (grantsRes.data ?? []) as unknown as GrantRow[];
  const myRequests = (myReqRes.data ?? []) as unknown as ApprovalRow[];
  const users = (usersRes.data ?? []) as unknown as UserRow[];
  const pending = (pendingRes.data ?? []) as unknown as ApprovalRow[];
  const generations = (gensRes.data ?? []) as unknown as GenerationRow[];

  const userById = new Map(users.map((u) => [u.id, u]));
  const userName = (id: string | null) => (id ? userById.get(id)?.full_name ?? "—" : "—");

  const myActiveGrant = grants
    .filter((g) => g.user_id === profile.id)
    .sort((a, b) => (a.expires_at ?? "").localeCompare(b.expires_at ?? ""))
    .at(-1);

  // Usage rollup by author — count, most-recent model, last-used date.
  type Usage = { user_id: string; count: number; lastAt: string; lastModel: string | null };
  const usageMap = new Map<string, Usage>();
  for (const g of generations) {
    if (!g.created_by) continue;
    const cur = usageMap.get(g.created_by);
    if (!cur) {
      usageMap.set(g.created_by, { user_id: g.created_by, count: 1, lastAt: g.created_at, lastModel: g.model });
    } else {
      cur.count += 1;
      if (g.created_at > cur.lastAt) {
        cur.lastAt = g.created_at;
        cur.lastModel = g.model;
      }
    }
  }
  const usage = Array.from(usageMap.values()).sort((a, b) => b.count - a.count);

  return (
    <AppShell breadcrumb={["Mthryve OS", "AI Governance"]} profile={profile}>
      <PageHeader
        title="AI Governance"
        subtitle="AI model tier is governed by role (D-012). See usage, and grant time-boxed upgrades when someone needs more horsepower."
      />

      {/* Your tier */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">Your tier</h2>
        <Card>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Role</p>
              <p className="text-sm text-ink">{profile.role}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Default tier</p>
              <p className="text-sm text-ink">{TIER_LABEL[myTier]}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Model</p>
              <p className="font-mono text-sm text-teal-300">{MODEL_BY_TIER[myTier]}</p>
            </div>
          </div>
          {myActiveGrant ? (
            <p className="mt-4 rounded-md border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs text-teal-300">
              Active grant: {TIER_LABEL[myActiveGrant.tier]} ({MODEL_BY_TIER[myActiveGrant.tier]}) — expires{" "}
              {fmtDate(myActiveGrant.expires_at)}
            </p>
          ) : (
            <p className="mt-4 text-xs text-ink-muted">No active upgrade grant.</p>
          )}
        </Card>
      </section>

      {/* Request higher model — only below premium */}
      {upgradeOptions.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">Request a higher model</h2>
          <form action={requestUpgrade} className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-ink-muted">
                Tier
                <select
                  name="requested_tier"
                  required
                  className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                >
                  {upgradeOptions.map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABEL[t]} · {MODEL_BY_TIER[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted">
                Duration
                <select
                  name="duration_days"
                  className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                >
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-ink-muted sm:col-span-2">
                Reason
                <textarea
                  name="reason"
                  required
                  rows={3}
                  placeholder="Why do you need more horsepower for this?"
                  className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                />
              </label>
            </div>
            <button
              type="submit"
              className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Request upgrade
            </button>
          </form>

          {myRequests.length > 0 && (
            <TableShell className="mt-4" columns={["Requested", "Tier", "Duration", "Status"]}>
              {myRequests.map((r) => (
                <tr key={r.id} className={rowClass}>
                  <td className="p-3 font-mono text-xs text-ink-muted">{fmtDate(r.created_at)}</td>
                  <td className="p-3 text-ink">
                    {r.payload?.requested_tier ? TIER_LABEL[r.payload.requested_tier] : "—"}
                  </td>
                  <td className="p-3 text-ink-muted">{r.payload?.duration_days ?? "—"} days</td>
                  <td className="p-3">
                    <Badge tone={STATUS_TONE[r.status] ?? "muted"}>{r.status}</Badge>
                  </td>
                </tr>
              ))}
            </TableShell>
          )}
        </section>
      )}

      {/* Pending approvals — CEO/COO only */}
      {canManage && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">Pending approvals</h2>
          {pending.length === 0 ? (
            <Card className="text-sm text-ink-muted">
              No model-upgrade requests awaiting review.
            </Card>
          ) : (
            <ul className="space-y-3">
              {pending.map((r) => (
                <li key={r.id} className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 shadow-elevate">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-ink">
                        {userName(r.requested_by)} →{" "}
                        <span className="text-teal-300">
                          {r.payload?.requested_tier ? TIER_LABEL[r.payload.requested_tier] : "—"}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {r.payload?.duration_days ?? "—"} days · requested {fmtDate(r.created_at)}
                      </p>
                      {r.payload?.reason && (
                        <p className="mt-1.5 text-xs italic text-ink-muted">“{r.payload.reason}”</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <form action={approveUpgrade}>
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400"
                        >
                          Approve
                        </button>
                      </form>
                      <form action={rejectUpgrade}>
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs text-ink-muted hover:bg-charcoal-700"
                        >
                          Reject
                        </button>
                      </form>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Active grants */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">Active grants</h2>
        <TableShell columns={["User", "Tier", "Expires", "Granted by"]}>
          {grants.length === 0 && (
            <tr>
              <td colSpan={4} className="p-4 text-ink-muted">
                No active grants.
              </td>
            </tr>
          )}
          {grants.map((g) => (
            <tr key={g.id} className={rowClass}>
              <td className="p-3 text-ink">{userName(g.user_id)}</td>
              <td className="p-3 text-ink">{TIER_LABEL[g.tier]}</td>
              <td className="p-3 font-mono text-xs text-ink-muted">{fmtDate(g.expires_at)}</td>
              <td className="p-3 text-ink-muted">{userName(g.granted_by)}</td>
            </tr>
          ))}
        </TableShell>
      </section>

      {/* Usage — CEO/COO only */}
      {canManage && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">Usage</h2>
          <p className="mb-3 text-xs text-ink-muted">Who is using AI, how much, and on which model.</p>
          <TableShell
            columns={["User", "Role", "Default tier", "Generations", "Last model", "Last used"]}
          >
            {usage.length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-ink-muted">
                  No generations recorded yet.
                </td>
              </tr>
            )}
            {usage.map((u) => {
              const row = userById.get(u.user_id);
              const role = row?.role;
              return (
                <tr key={u.user_id} className={rowClass}>
                  <td className="p-3 text-ink">{row?.full_name ?? "—"}</td>
                  <td className="p-3 text-ink-muted">{role ?? "—"}</td>
                  <td className="p-3 text-ink-muted">{role ? TIER_LABEL[defaultTierFor(role)] : "—"}</td>
                  <td className="p-3 font-mono text-ink">{u.count}</td>
                  <td className="p-3 font-mono text-xs text-ink-muted">{u.lastModel ?? "—"}</td>
                  <td className="p-3 font-mono text-xs text-ink-muted">{fmtDate(u.lastAt)}</td>
                </tr>
              );
            })}
          </TableShell>
        </section>
      )}
    </AppShell>
  );
}
