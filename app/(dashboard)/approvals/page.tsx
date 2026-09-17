import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { ActionCard } from "@/components/approvals/ActionCard";
import { GovernedDeleteCard } from "@/components/approvals/GovernedDeleteCard";
import { ProposeApprovalForm } from "@/components/approvals/ProposeApprovalForm";
import { ApprovalActions } from "@/components/approvals/ApprovalActions";
import { PageHeader, Badge, type BadgeTone, HelpHint } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isEmailConfigured } from "@/lib/outreach/email";
import type { ActionRequestRow, ActionAuditRow } from "@/lib/actions/types";
import type { ApprovalStatus } from "@/types/database";

// The Action & Approval Queue — the OS's hybrid AI/human safety spine.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then
// the OS EXECUTES. Every action_request is born pending and needs an approval
// tap; nothing auto-executes. This page lists the org's action_requests, grouped
// Pending (first) vs History, sorted by risk tier then age, each card carrying
// Tony's full reasoning. RLS decides who may approve — we only render live
// buttons where the policy would accept the decision.
//
// The pre-existing AI-platform / task proposals (approval_requests) keep their
// own section below, so that flow — linked from the home page, notifications and
// AI Platform — isn't orphaned.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };
type UserRow = { id: string; full_name: string };

// Legacy approval_requests card shape (unchanged).
type ApprovalLite = {
  id: string;
  action_type: string;
  title: string;
  payload: { title?: string; priority?: string; tier?: string; reason?: string } | null;
  status: ApprovalStatus;
  requested_by: string | null;
  requested_by_agent: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
};
const LEGACY_TONE: Record<ApprovalStatus, BadgeTone> = {
  pending: "amber",
  approved: "teal",
  rejected: "red",
};

export default async function ApprovalsPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;
  const tab = searchParams?.tab === "history" ? "history" : "pending";

  const [reqRes, auditRes, usersRes, legacyRes] = await Promise.all([
    db.from("action_requests").select("*"),
    db
      .from("action_audit")
      .select("id, org_id, action_request_id, event, actor_id, actor_role, detail, created_at")
      .order("created_at", { ascending: true }),
    supabase.from("users").select("id, full_name"),
    supabase
      .from("approval_requests")
      .select(
        "id, action_type, title, payload, status, requested_by, requested_by_agent, reviewed_by, reviewed_at, review_note, created_at"
      )
      .order("created_at", { ascending: false }),
  ]);

  const requests = (reqRes.data ?? []) as unknown as ActionRequestRow[];
  const auditRows = (auditRes.data ?? []) as unknown as ActionAuditRow[];
  const users = (usersRes.data ?? []) as unknown as UserRow[];
  const legacy = (legacyRes.data ?? []) as unknown as ApprovalLite[];
  const userName = new Map(users.map((u) => [u.id, u.full_name]));

  // Audit rows grouped by their request, chronological (fetched ascending).
  const auditByRequest = new Map<string, ActionAuditRow[]>();
  for (const a of auditRows) {
    if (!a.action_request_id) continue;
    const arr = auditByRequest.get(a.action_request_id) ?? [];
    arr.push(a);
    auditByRequest.set(a.action_request_id, arr);
  }

  // Governed permanent-delete requests (source_module='governance') walk their
  // own sequential COO → CEO chain and render on a dedicated card, so they're
  // held out of the single-step queue entirely.
  const isGovernance = (r: ActionRequestRow) => r.source_module === "governance";
  const standard = requests.filter((r) => !isGovernance(r));
  const governance = requests.filter(isGovernance);

  // Pending first — highest risk tier first, then oldest (longest-waiting) first.
  const pending = standard
    .filter((r) => r.status === "pending")
    .sort((a, b) => b.risk_tier - a.risk_tier || a.created_at.localeCompare(b.created_at));
  // History — decided/executed/rejected/failed, most recent decision first.
  const history = standard
    .filter((r) => r.status !== "pending")
    .sort((a, b) =>
      (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at)
    );

  const shown = tab === "history" ? history : pending;

  // Governed-delete buckets: still-in-flight (pending_coo / pending_ceo) first,
  // then decided (approved / executed / rejected / failed), newest first.
  const govPending = governance
    .filter((r) => r.status === "pending_coo" || r.status === "pending_ceo")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const govHistory = governance
    .filter((r) => r.status !== "pending_coo" && r.status !== "pending_ceo")
    .sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at));
  const govShown = tab === "history" ? govHistory : govPending;

  // Whether an email provider is configured — passed to Vesper's email drafts so
  // the card warns honestly before approval (read once per render).
  const emailConfigured = isEmailConfigured();

  // Legacy queue buckets.
  const legacyPending = legacy.filter((r) => r.status === "pending");
  const legacyDecided = legacy.filter((r) => r.status !== "pending").slice(0, 10);
  const canReviewLegacy = ["ceo", "coo", "department_head"].includes(profile.role);

  const TabLink = ({ id, label, count }: { id: "pending" | "history"; label: string; count: number }) => (
    <Link
      href={id === "pending" ? "/approvals" : "/approvals?tab=history"}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        tab === id
          ? "bg-teal-500/10 text-teal-300"
          : "text-ink-muted hover:bg-charcoal-800 hover:text-ink"
      }`}
    >
      {label} <span className="font-mono text-[11px] text-ink-dim">{count}</span>
    </Link>
  );

  return (
    <AppShell breadcrumb={["Mthryve OS", "Approvals"]} profile={profile}>
      <PageHeader
        title={<>Action &amp; Approval Queue <HelpHint id="work.approvals" /></>}
        subtitle={
          <>
            {pending.length + govPending.length} awaiting decision. Tony drafts, a human approves, then the OS
            executes — nothing runs on its own (DECISIONS.md D-005).
          </>
        }
      />

      {/* Tabs */}
      <div className="mb-4 flex items-center gap-1 rounded-lg border border-charcoal-700/60 bg-charcoal-900 p-1">
        <TabLink id="pending" label="Pending" count={pending.length + govPending.length} />
        <TabLink id="history" label="History" count={history.length + govHistory.length} />
      </div>

      {/* Action queue */}
      <section className="mb-10">
        {shown.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
            {tab === "history"
              ? "No decisions yet. Approved, executed and rejected actions will appear here with their audit trail."
              : "Nothing awaiting a decision. When a proactive loop (e.g. delivery-risk) spots something, Tony's drafted action lands here for you to approve."}
          </div>
        ) : (
          <ul className="space-y-3">
            {shown.map((r) => (
              <ActionCard
                key={r.id}
                request={r}
                role={profile.role}
                userName={userName}
                audit={auditByRequest.get(r.id) ?? []}
                emailConfigured={emailConfigured}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── Governed permanent deletes (COO → CEO, 2-step) ────────────────────── */}
      <section className="mb-10 border-t border-charcoal-700/60 pt-6">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-ink">Permanent deletes</h2>
          <p className="text-xs text-ink-muted">
            Every permanent delete needs the COO's approval, then the CEO's final sign-off — only then is
            anything removed. {govPending.length} in flight.
          </p>
        </div>
        {govShown.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
            {tab === "history"
              ? "No permanent deletes have been decided yet."
              : "No delete requests in flight. When someone requests a permanent delete, it lands here for the COO, then the CEO."}
          </div>
        ) : (
          <ul className="space-y-3">
            {govShown.map((r) => (
              <GovernedDeleteCard
                key={r.id}
                request={r}
                role={profile.role}
                userName={userName}
                audit={auditByRequest.get(r.id) ?? []}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── Legacy: AI platform & task proposals (approval_requests) ──────────── */}
      <section className="border-t border-charcoal-700/60 pt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-ink">AI platform & task proposals</h2>
            <p className="text-xs text-ink-muted">
              Model-access and task proposals awaiting review ({legacyPending.length}).
            </p>
          </div>
          <ProposeApprovalForm orgId={profile.org_id} userId={profile.id} />
        </div>

        {legacyPending.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
            Nothing awaiting review.
          </div>
        ) : (
          <ul className="space-y-3">
            {legacyPending.map((r) => (
              <li key={r.id} className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink">{r.title}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {r.action_type} · proposed by{" "}
                      {r.requested_by_agent
                        ? "AI assistant"
                        : r.requested_by
                        ? userName.get(r.requested_by) ?? "Someone"
                        : "Someone"}
                      {r.payload?.priority ? ` · ${r.payload.priority} priority` : ""}
                    </p>
                    {r.action_type === "model_access" && r.payload?.reason && (
                      <p className="mt-1.5 text-xs italic text-ink-muted">“{r.payload.reason}”</p>
                    )}
                  </div>
                  <Badge tone={LEGACY_TONE[r.status]}>{r.status}</Badge>
                </div>
                {canReviewLegacy ? (
                  <ApprovalActions requestId={r.id} />
                ) : (
                  <p className="mt-2 text-xs text-ink-muted">Awaiting a manager’s review.</p>
                )}
              </li>
            ))}
          </ul>
        )}

        {legacyDecided.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-2 text-xs font-semibold text-ink">Recent decisions</h3>
            <ul className="divide-y divide-charcoal-700/70 overflow-hidden rounded-lg border border-charcoal-700">
              {legacyDecided.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between bg-charcoal-950 px-4 py-2.5"
                >
                  <div>
                    <p className="text-sm text-ink">{r.title}</p>
                    <p className="text-xs text-ink-muted">
                      {r.reviewed_by ? `by ${userName.get(r.reviewed_by) ?? "a reviewer"}` : ""}
                      {r.review_note ? ` — “${r.review_note}”` : ""}
                    </p>
                  </div>
                  <Badge tone={LEGACY_TONE[r.status]}>{r.status}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </AppShell>
  );
}
