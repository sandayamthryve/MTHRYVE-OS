import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, Badge, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { listNotifications } from "@/lib/notifications/read";
import { NotificationCentre } from "./NotificationCentre";

// Notifications — the per-user Notification Centre (public.notifications) plus,
// underneath, the org-level context it's built on: the live pending-approvals
// queue and recent warning/critical org events. The centre is what needs YOUR
// attention (RLS: a person sees only their own, leadership sees all); the two
// context rails below are the org-wide feeds that produce those notifications.
//
// Reads run on the caller's RLS client, so every list reflects exactly what the
// signed-in user is allowed to see.

export const dynamic = "force-dynamic";

type ApprovalRow = {
  id: string;
  title: string;
  action_type: string | null;
  risk_tier: string | null;
  requested_by_agent: boolean | null;
  created_at: string;
};
type EventRow = {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  severity: string | null;
  event_date: string | null;
  created_at: string;
};

const SEV_TONE: Record<string, BadgeTone> = {
  critical: "red",
  warning: "amber",
  info: "teal",
};

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function NotificationsPage() {
  const profile = await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const db = createServerSupabaseClient();
  const shim = db as unknown as { from: (t: string) => any };

  const [notifications, approvalsRes, eventsRes] = await Promise.all([
    listNotifications(shim, profile.id, 60),
    db
      .from("approval_requests")
      .select("id, title, action_type, risk_tier, requested_by_agent, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(15),
    db
      .from("events")
      .select("id, title, body, kind, severity, event_date, created_at")
      .in("severity", ["warning", "critical"])
      .order("created_at", { ascending: false })
      .limit(15),
  ]);

  const approvals = (approvalsRes.data ?? []) as unknown as ApprovalRow[];
  const events = (eventsRes.data ?? []) as unknown as EventRow[];

  return (
    <AppShell breadcrumb={["Mthryve OS", "Notifications"]} profile={profile}>
      <PageHeader
        title="Notifications"
        subtitle="What needs your attention — proactively surfaced, grounded in real events."
      />

      {/* The per-user centre. */}
      <section className="mb-8">
        <NotificationCentre initial={notifications} />
      </section>

      {/* Org-level context rails: the feeds these notifications are produced from. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              Pending approvals
            </h2>
            <Link href="/approvals" className="text-xs text-teal-400 hover:text-teal-300">
              View all →
            </Link>
          </div>
          <div className="overflow-hidden rounded-lg border border-charcoal-700 bg-charcoal-900">
            {approvals.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-muted">Nothing waiting on you. You&rsquo;re clear.</p>
            ) : (
              approvals.map((a) => (
                <Link
                  key={a.id}
                  href="/approvals"
                  className="flex items-center justify-between gap-3 border-b border-charcoal-700/60 px-4 py-3 last:border-0 hover:bg-charcoal-800"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{a.title}</span>
                    <span className="text-xs text-ink-muted">
                      {a.action_type ?? "action"}
                      {a.requested_by_agent ? " · requested by agent" : ""}
                    </span>
                  </span>
                  {a.risk_tier && (
                    <Badge tone="amber" className="shrink-0">
                      {a.risk_tier}
                    </Badge>
                  )}
                </Link>
              ))
            )}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Alerts</h2>
            <Link href="/updates" className="text-xs text-teal-400 hover:text-teal-300">
              All updates →
            </Link>
          </div>
          <div className="overflow-hidden rounded-lg border border-charcoal-700 bg-charcoal-900">
            {events.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-muted">No warnings or critical alerts. All calm.</p>
            ) : (
              events.map((e) => (
                <Link
                  key={e.id}
                  href="/updates"
                  className="flex items-start justify-between gap-3 border-b border-charcoal-700/60 px-4 py-3 last:border-0 hover:bg-charcoal-800"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{e.title}</span>
                    {e.body && <span className="block truncate text-xs text-ink-muted">{e.body}</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={SEV_TONE[e.severity ?? "info"] ?? "teal"}>{e.severity}</Badge>
                    <span className="font-mono text-[10px] text-ink-muted">{timeAgo(e.created_at)}</span>
                  </span>
                </Link>
              ))
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
