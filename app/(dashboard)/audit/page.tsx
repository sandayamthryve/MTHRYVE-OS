import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, Card, Badge, TableShell, rowClass, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// AUDIT FEED — the one place the OS reads its own record back. It MERGES the two
// live trails into a single chronological story without ever blending them:
//   • action_audit — the Review Gate / lifecycle SPINE (created → approved /
//     rejected → executed / failed, plus policy, security, expense and
//     edit/archive events). Org-scoped by RLS: every member sees it.
//   • audit_log    — the PRIVILEGED ledger (role/employment changes, governed
//     deletes, probation + approval decisions). Leadership-only by RLS.
// Every row is stamped with which `trail` it came from, so the two are always
// distinguishable. Reads run through the RLS-scoped session against the
// public.audit_feed view (security_invoker) — a role that cannot see a row never
// sees it here, not blank. audit_log stays leadership-only; this never widens it.
//
// Nothing is cached: every count and timestamp resolves live from the view on
// each request.

export const dynamic = "force-dynamic";

// audit_feed isn't in the generated Database types, so it's reached through the
// app's cast shim, as elsewhere in the OS.
type Shim = { from: (t: string) => any };

type FeedRow = {
  id: string;
  trail: "action_audit" | "audit_log";
  created_at: string;
  event: string;
  actor_user_id: string | null;
  actor_role: string | null;
  action_request_id: string | null;
  action_class: string | null;
  target_title: string | null;
  entity_type: string | null;
  entity_id: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
};

const PER_PAGE = 50;

// Event → friendly label + tone. Requests / arrivals read cool-informative;
// approvals + successful executions read positive; rejections, failures and
// destructive finals read hot; anything needing a human reads warn. Unknown
// events fall back to a humanised verb with a neutral tone — never a raw crash.
const EVENT_META: Record<string, { label: string; tone: BadgeTone }> = {
  // action_audit — the spine
  created: { label: "Created", tone: "violet" },
  approved: { label: "Approved", tone: "teal" },
  rejected: { label: "Rejected", tone: "red" },
  executed: { label: "Executed", tone: "teal" },
  failed: { label: "Failed", tone: "red" },
  opportunity_received: { label: "Opportunity received", tone: "violet" },
  policy_denied: { label: "Policy · denied", tone: "red" },
  policy_needs_approval: { label: "Policy · needs approval", tone: "amber" },
  policy_allowed: { label: "Policy · allowed", tone: "teal" },
  login: { label: "Login", tone: "muted" },
  failed_login: { label: "Failed login", tone: "amber" },
  password_change: { label: "Password change", tone: "violet" },
  data_export: { label: "Data export", tone: "amber" },
  policy_change: { label: "Policy change", tone: "amber" },
  expense_created: { label: "Expense created", tone: "violet" },
  expense_updated: { label: "Expense updated", tone: "violet" },
  expense_approved: { label: "Expense approved", tone: "teal" },
  expense_paid: { label: "Expense paid", tone: "teal" },
  expense_cancelled: { label: "Expense cancelled", tone: "muted" },
  record_edited: { label: "Record edited", tone: "violet" },
  record_archived: { label: "Record archived", tone: "amber" },
  record_restored: { label: "Record restored", tone: "teal" },
  record_hard_deleted: { label: "Record hard-deleted", tone: "red" },
  // Manual automation override (Settings → Automation, leadership-only).
  automation_run: { label: "Automation · manual run", tone: "violet" },
  // audit_log — the privileged ledger
  role_change: { label: "Role change", tone: "violet" },
  employment_change: { label: "Employment change", tone: "teal" },
  probation_decision: { label: "Probation decision", tone: "amber" },
  approval_decision: { label: "Approval decision", tone: "teal" },
  delete_requested: { label: "Delete requested", tone: "amber" },
  delete_coo_approved: { label: "Delete · COO approved", tone: "amber" },
  delete_ceo_approved: { label: "Delete · CEO approved", tone: "amber" },
  delete_executed: { label: "Delete executed", tone: "red" },
  delete_rejected: { label: "Delete rejected", tone: "muted" },
  sync: { label: "Sync", tone: "muted" },
};

function eventMeta(event: string): { label: string; tone: BadgeTone } {
  const hit = EVENT_META[event];
  if (hit) return hit;
  // Humanise unmapped events (e.g. 'case.assigned', 'op_record.draft') rather
  // than crash or dump the raw token.
  const label = event
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { label, tone: "muted" };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// What the event acted on: the action_request title when there is one, else the
// audit_log entity (type · short id), else a hint pulled from the detail, else
// the em-dash. Never fabricated.
function actedOn(row: FeedRow): string {
  if (row.target_title) return row.target_title;
  if (row.entity_type || row.entity_id) {
    const id = row.entity_id ? row.entity_id.slice(0, 8) : "";
    return [row.entity_type, id].filter(Boolean).join(" · ") || "—";
  }
  const d = row.detail;
  if (d && typeof d === "object") {
    const hint = d.title ?? d.name ?? d.entity ?? d.target ?? d.email;
    if (hint) return String(hint);
  }
  if (row.action_request_id) return `request · ${row.action_request_id.slice(0, 8)}`;
  return "—";
}

// Render the detail jsonb compactly: a few key=value pairs, never a raw dump.
function fmtDetail(detail: Record<string, unknown> | null): string {
  if (!detail || typeof detail !== "object") return "—";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined || v === "") continue;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}: ${val.length > 48 ? val.slice(0, 45) + "…" : val}`);
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(" · ") : "—";
}

const inputCls =
  "w-full rounded-md border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs text-ink focus:border-teal-500/50 focus:outline-none";

type SearchParams = {
  page?: string;
  trail?: string;
  event?: string;
  actor?: string;
  class?: string;
  from?: string;
  to?: string;
};

// Preserve the active filters when building page / reset links.
function withParams(base: SearchParams, over: Partial<SearchParams>): string {
  const merged: Record<string, string | undefined> = { ...base, ...over };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v && v !== "all" && v !== "") q.set(k, v);
  }
  const s = q.toString();
  return s ? `/audit?${s}` : "/audit";
}

export default async function AuditFeedPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Oversight roles reach the page; RLS on the view does the real per-row work
  // (a department_head sees the action spine but none of the leadership ledger).
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const pageNum = Math.max(1, Number.parseInt(searchParams.page ?? "1", 10) || 1);
  const trail = searchParams.trail && searchParams.trail !== "all" ? searchParams.trail : null;
  const event = searchParams.event && searchParams.event !== "all" ? searchParams.event : null;
  const actor = searchParams.actor && searchParams.actor !== "all" ? searchParams.actor : null;
  const actionClass =
    searchParams.class && searchParams.class !== "all" ? searchParams.class : null;
  const fromDate = searchParams.from || null;
  const toDate = searchParams.to || null;

  const from = (pageNum - 1) * PER_PAGE;
  const to = from + PER_PAGE - 1;

  // Build the main query with every active filter applied AT THE DB, an exact
  // count so the pager is honest, and newest-first ordering.
  let q = db
    .from("audit_feed")
    .select(
      "id, trail, created_at, event, actor_user_id, actor_role, action_request_id, action_class, target_title, entity_type, entity_id, ip, detail",
      { count: "exact" }
    );
  if (trail) q = q.eq("trail", trail);
  if (event) q = q.eq("event", event);
  if (actionClass) q = q.eq("action_class", actionClass);
  if (actor === "system") q = q.is("actor_user_id", null);
  else if (actor) q = q.eq("actor_user_id", actor);
  if (fromDate) q = q.gte("created_at", `${fromDate}T00:00:00Z`);
  if (toDate) q = q.lte("created_at", `${toDate}T23:59:59.999Z`);

  const { data, count } = await q
    .order("created_at", { ascending: false })
    .range(from, to);
  const rows = (data ?? []) as FeedRow[];
  const total = typeof count === "number" ? count : rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const hasPrev = pageNum > 1;
  const hasNext = pageNum < totalPages;

  // Filter option lists, built from the SAME RLS-scoped view so a caller is only
  // ever offered filters for rows they can actually see (a department_head is
  // never offered a leadership-only event). Bounded read — the org's audit
  // volume is small and this only feeds two dropdowns.
  const { data: optData } = await db
    .from("audit_feed")
    .select("event, actor_user_id")
    .order("created_at", { ascending: false })
    .limit(2000);
  const optRows = (optData ?? []) as { event: string; actor_user_id: string | null }[];
  const eventOptions = Array.from(new Set(optRows.map((r) => r.event))).sort();
  const actorIdsAll = Array.from(
    new Set(optRows.map((r) => r.actor_user_id).filter((id): id is string => !!id))
  );
  const hasSystemActor = optRows.some((r) => r.actor_user_id === null);

  // Resolve actor names — both for the visible rows and for the actor dropdown —
  // in one org-scoped round-trip.
  const idsToName = Array.from(
    new Set([
      ...rows.map((r) => r.actor_user_id).filter((id): id is string => !!id),
      ...actorIdsAll,
    ])
  );
  const nameById = new Map<string, string>();
  if (idsToName.length > 0) {
    const { data: users } = await db
      .from("users")
      .select("id, full_name, email")
      .in("id", idsToName);
    for (const u of (users ?? []) as {
      id: string;
      full_name: string | null;
      email: string | null;
    }[]) {
      nameById.set(u.id, u.full_name || u.email || u.id);
    }
  }
  const actorOptions = actorIdsAll
    .map((id) => ({ id, name: nameById.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const anyFilter = Boolean(trail || event || actor || actionClass || fromDate || toDate);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Audit Feed"]} profile={profile}>
      <PageHeader
        title="Audit Feed"
        subtitle="The system reads itself back. One chronological record merged from both trails — the action spine (action_audit) and the privileged ledger (audit_log) — newest first, each row labelled by trail. RLS-scoped to what you may see; every figure resolves live."
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            {anyFilter ? "Matching events" : "Total events"}
          </p>
          <p className="mt-1 text-2xl font-semibold text-ink">{total}</p>
        </Card>
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Action spine</p>
          <p className="mt-1 text-2xl font-semibold text-ink">
            {rows.filter((r) => r.trail === "action_audit").length}
            <span className="text-base font-normal text-ink-muted"> / page</span>
          </p>
        </Card>
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Privileged ledger
          </p>
          <p className="mt-1 text-2xl font-semibold text-ink">
            {rows.filter((r) => r.trail === "audit_log").length}
            <span className="text-base font-normal text-ink-muted"> / page</span>
          </p>
        </Card>
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Page</p>
          <p className="mt-1 text-2xl font-semibold text-ink">
            {pageNum} <span className="text-base font-normal text-ink-muted">/ {totalPages}</span>
          </p>
        </Card>
      </div>

      {/* Filters — a plain GET form so every filter lives in the URL, is
          shareable, and resets pagination to page 1 (no hidden page field). */}
      <form method="get" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Trail
          </span>
          <select name="trail" defaultValue={searchParams.trail ?? "all"} className={inputCls}>
            <option value="all">All trails</option>
            <option value="action_audit">Action spine</option>
            <option value="audit_log">Privileged ledger</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Event
          </span>
          <select name="event" defaultValue={searchParams.event ?? "all"} className={inputCls}>
            <option value="all">All events</option>
            {eventOptions.map((e) => (
              <option key={e} value={e}>
                {eventMeta(e).label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Actor
          </span>
          <select name="actor" defaultValue={searchParams.actor ?? "all"} className={inputCls}>
            <option value="all">All actors</option>
            {hasSystemActor && <option value="system">System / Agent</option>}
            {actorOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Action class
          </span>
          <select name="class" defaultValue={searchParams.class ?? "all"} className={inputCls}>
            <option value="all">All classes</option>
            <option value="general">General</option>
            <option value="deletion">Deletion</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            From
          </span>
          <input type="date" name="from" defaultValue={searchParams.from ?? ""} className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            To
          </span>
          <input type="date" name="to" defaultValue={searchParams.to ?? ""} className={inputCls} />
        </label>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-3 lg:col-span-6">
          <button
            type="submit"
            className="rounded-md bg-teal-500/20 px-3 py-1.5 text-xs font-semibold text-teal-200 hover:bg-teal-500/30"
          >
            Apply filters
          </button>
          {anyFilter && (
            <Link
              href="/audit"
              className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-ink-muted hover:bg-charcoal-700"
            >
              Clear
            </Link>
          )}
        </div>
      </form>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">
            No audit events match {anyFilter ? "these filters" : "on this page"}. As decisions,
            executions and privileged actions happen — and that you are permitted to see — they
            appear here, newest first.
          </p>
        </Card>
      ) : (
        <>
          <TableShell columns={["When", "Trail", "Event", "Actor", "Acted on", "Detail"]}>
            {rows.map((r) => {
              const meta = eventMeta(r.event);
              const actorName = r.actor_user_id
                ? nameById.get(r.actor_user_id) ?? r.actor_user_id
                : "System / Agent";
              const isAgent = !r.actor_user_id;
              return (
                <tr key={`${r.trail}-${r.id}`} className={rowClass}>
                  <td className="whitespace-nowrap p-3 font-mono text-xs text-ink-muted">
                    {fmtDate(r.created_at)}
                  </td>
                  <td className="p-3">
                    <Badge tone={r.trail === "audit_log" ? "violet" : "muted"}>
                      {r.trail === "audit_log" ? "Privileged" : "Spine"}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {r.action_class && (
                      <span className="ml-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                        {r.action_class}
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <span className="text-ink">{actorName}</span>
                    <span className="ml-1 text-xs text-ink-muted">
                      {isAgent ? "(agent)" : r.actor_role ? `(${r.actor_role})` : ""}
                    </span>
                  </td>
                  <td className="p-3 text-ink-muted">{actedOn(r)}</td>
                  <td className="p-3 text-ink-muted">{fmtDetail(r.detail)}</td>
                </tr>
              );
            })}
          </TableShell>

          <div className="mt-4 flex items-center justify-between text-sm">
            {hasPrev ? (
              <Link
                href={withParams(searchParams, { page: String(pageNum - 1) })}
                className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-charcoal-700"
              >
                ← Prev
              </Link>
            ) : (
              <span className="px-3 py-1.5 text-xs text-ink-dim">← Prev</span>
            )}
            <span className="font-mono text-xs text-ink-muted">
              Showing {from + 1}–{from + rows.length} of {total}
            </span>
            {hasNext ? (
              <Link
                href={withParams(searchParams, { page: String(pageNum + 1) })}
                className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-charcoal-700"
              >
                Next →
              </Link>
            ) : (
              <span className="px-3 py-1.5 text-xs text-ink-dim">Next →</span>
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}
