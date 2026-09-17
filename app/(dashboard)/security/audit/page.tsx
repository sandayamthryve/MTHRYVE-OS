import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, Card, Badge, TableShell, rowClass, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Audit Log — leadership-only (ceo/coo), read-only review of the privileged-
// action trail (public.audit_log). Distinct from Security Events (auth / export
// / policy signal): this is the "who did what to whom" ledger — role and
// employment changes, the governed permanent-delete lifecycle, probation
// decisions, and approval decisions.
//
// Reads run through the RLS-scoped session: the audit_log select policy already
// restricts rows to the caller's org AND leadership, and requireRole enforces
// the same at the page. Writes never happen here — the trail is written only by
// the service role (lib/audit/log.ts), so there is nothing to mutate on screen.

export const dynamic = "force-dynamic";

// audit_log isn't in the generated Database types, so it's reached through the
// app's cast shim, as elsewhere in the OS.
type Shim = { from: (t: string) => any };

type AuditRow = {
  id: string;
  action: string;
  actor_user_id: string | null;
  actor_role: string | null;
  entity_type: string | null;
  entity_id: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
};

// How many rows per page. Honest pagination: we ask for the exact total and only
// offer Next when there genuinely is a next page.
const PER_PAGE = 50;

// Friendly label + badge tone per known action. Destructive / final steps read
// hot; requests and routine decisions read cool. Unknown actions fall back to
// the raw verb with a muted tone.
const ACTION_META: Record<string, { label: string; tone: BadgeTone }> = {
  role_change: { label: "Role change", tone: "violet" },
  employment_change: { label: "Employment change", tone: "teal" },
  probation_decision: { label: "Probation decision", tone: "amber" },
  approval_decision: { label: "Approval decision", tone: "teal" },
  delete_requested: { label: "Delete requested", tone: "amber" },
  delete_coo_approved: { label: "Delete · COO approved", tone: "amber" },
  delete_ceo_approved: { label: "Delete · CEO approved", tone: "amber" },
  delete_executed: { label: "Delete executed", tone: "red" },
  delete_rejected: { label: "Delete rejected", tone: "muted" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Render the detail jsonb compactly: a few key=value pairs, never a raw dump.
function fmtDetail(detail: Record<string, unknown> | null): string {
  if (!detail || typeof detail !== "object") return "—";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined || v === "") continue;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}: ${val.length > 60 ? val.slice(0, 57) + "…" : val}`);
    if (parts.length >= 4) break;
  }
  return parts.length ? parts.join(" · ") : "—";
}

function fmtEntity(row: AuditRow): string {
  if (!row.entity_type && !row.entity_id) return "—";
  const id = row.entity_id ? row.entity_id.slice(0, 8) : "";
  return [row.entity_type, id].filter(Boolean).join(" · ") || "—";
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: { page?: string };
}) {
  const profile = await requireRole(["ceo", "coo"]);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // Clamp the page to a sane 1-based integer.
  const pageNum = Math.max(1, Number.parseInt(searchParams.page ?? "1", 10) || 1);
  const from = (pageNum - 1) * PER_PAGE;
  const to = from + PER_PAGE - 1;

  // The privileged-action trail, most recent first, with an exact total so the
  // pager is honest about how much there is and when to stop.
  const { data, count } = await db
    .from("audit_log")
    .select("id, action, actor_user_id, actor_role, entity_type, entity_id, detail, ip, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(from, to);
  const rows = (data ?? []) as AuditRow[];
  const total = typeof count === "number" ? count : rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const hasPrev = pageNum > 1;
  const hasNext = pageNum < totalPages;

  // Resolve actor names in one round-trip (org-scoped by RLS).
  const actorIds = Array.from(
    new Set(rows.map((r) => r.actor_user_id).filter((id): id is string => !!id))
  );
  const nameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: users } = await db
      .from("users")
      .select("id, full_name, email")
      .in("id", actorIds);
    for (const u of (users ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
      nameById.set(u.id, u.full_name || u.email || u.id);
    }
  }

  return (
    <AppShell breadcrumb={["Mthryve OS", "Audit Log"]} profile={profile}>
      <PageHeader
        title="Audit Log"
        subtitle="Privileged actions across the OS — role and employment changes, governed deletes, probation and approval decisions. Leadership only, RLS-scoped to your org, read-only."
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Total events</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{total}</p>
        </Card>
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Page</p>
          <p className="mt-1 text-2xl font-semibold text-ink">
            {pageNum} <span className="text-base font-normal text-ink-muted">/ {totalPages}</span>
          </p>
        </Card>
      </div>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">
            No privileged actions recorded on this page. Role and employment changes, governed
            deletes, probation decisions, and approval decisions will appear here as they happen.
          </p>
        </Card>
      ) : (
        <>
          <TableShell columns={["When", "Action", "Actor", "Role", "Entity", "Details"]}>
            {rows.map((r) => {
              const meta = ACTION_META[r.action] ?? { label: r.action, tone: "muted" as BadgeTone };
              const actor = r.actor_user_id
                ? nameById.get(r.actor_user_id) ?? r.actor_user_id
                : "System";
              return (
                <tr key={r.id} className={rowClass}>
                  <td className="whitespace-nowrap p-3 font-mono text-xs text-ink-muted">
                    {fmtDate(r.created_at)}
                  </td>
                  <td className="p-3">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </td>
                  <td className="p-3 text-ink">{actor}</td>
                  <td className="p-3 text-ink-muted">{r.actor_role ?? "—"}</td>
                  <td className="whitespace-nowrap p-3 font-mono text-xs text-ink-muted">
                    {fmtEntity(r)}
                  </td>
                  <td className="p-3 text-ink-muted">{fmtDetail(r.detail)}</td>
                </tr>
              );
            })}
          </TableShell>

          <div className="mt-4 flex items-center justify-between text-sm">
            {hasPrev ? (
              <Link
                href={`/security/audit?page=${pageNum - 1}`}
                className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-charcoal-700"
              >
                ← Prev
              </Link>
            ) : (
              <span className="px-3 py-1.5 text-xs text-ink-dim">← Prev</span>
            )}
            <span className="font-mono text-xs text-ink-muted">
              Showing {rows.length === 0 ? 0 : from + 1}–{from + rows.length} of {total}
            </span>
            {hasNext ? (
              <Link
                href={`/security/audit?page=${pageNum + 1}`}
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
