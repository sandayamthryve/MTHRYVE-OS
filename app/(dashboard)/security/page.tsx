import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, Card, Badge, TableShell, rowClass, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { SECURITY_EVENTS, type SecurityEvent } from "@/lib/security/audit";

// Security Events — leadership-only review of the security slice of the shared
// action_audit trail (PASTE 3.2, Part C). No DB view is needed: this is an
// app-side query filtered to the security event types, read through the same
// RLS-scoped session as every other dashboard (leadership only, both here via
// requireRole AND at the row level via the action_audit select policy).
//
// The events surfaced here (matches SECURITY_EVENTS):
//   • login / failed_login / password_change — auth activity
//   • data_export                            — who exported what
//   • policy_change                          — governance edits

export const dynamic = "force-dynamic";

// action_audit isn't in the generated Database types, so it's reached through
// the app's cast shim, as elsewhere in the OS.
type Shim = { from: (t: string) => any };

type AuditRow = {
  id: string;
  event: SecurityEvent;
  actor_id: string | null;
  actor_role: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

// Friendly label + badge tone per security event. Auth failures and policy
// edits read hot; routine logins read cool.
const EVENT_META: Record<SecurityEvent, { label: string; tone: BadgeTone }> = {
  login: { label: "Login", tone: "teal" },
  failed_login: { label: "Failed login", tone: "red" },
  password_change: { label: "Password change", tone: "amber" },
  data_export: { label: "Data export", tone: "violet" },
  policy_change: { label: "Policy change", tone: "amber" },
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

export default async function SecurityEventsPage() {
  const profile = await requireRole(["ceo", "coo"]);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // The security slice of the audit trail, most recent first.
  const { data } = await db
    .from("action_audit")
    .select("id, event, actor_id, actor_role, detail, created_at")
    .in("event", [...SECURITY_EVENTS])
    .order("created_at", { ascending: false })
    .limit(250);
  const rows = (data ?? []) as AuditRow[];

  // Resolve actor names in one round-trip (org-scoped by RLS).
  const actorIds = Array.from(
    new Set(rows.map((r) => r.actor_id).filter((id): id is string => !!id))
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

  // A couple of at-a-glance counts for the header.
  const failedLogins = rows.filter((r) => r.event === "failed_login").length;
  const exports = rows.filter((r) => r.event === "data_export").length;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Security Events"]} profile={profile}>
      <PageHeader
        title="Security Events"
        subtitle="Auth activity, data exports, and governance changes across the OS — the security slice of the audit trail. Leadership only, RLS-scoped to your org."
      />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Events shown</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{rows.length}</p>
        </Card>
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Failed logins</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{failedLogins}</p>
        </Card>
        <Card>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Data exports</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{exports}</p>
        </Card>
      </div>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">
            No security events recorded yet. Logins, failed logins, password changes, data
            exports, and policy changes will appear here as they happen.
          </p>
        </Card>
      ) : (
        <TableShell columns={["When", "Event", "Actor", "Role", "Details"]}>
          {rows.map((r) => {
            const meta = EVENT_META[r.event] ?? { label: r.event, tone: "muted" as BadgeTone };
            const actor = r.actor_id
              ? nameById.get(r.actor_id) ?? r.actor_id
              : // Failed logins have no user; surface the attempted email if present.
                (typeof r.detail?.email === "string" && r.detail.email) || "—";
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
                <td className="p-3 text-ink-muted">{fmtDetail(r.detail)}</td>
              </tr>
            );
          })}
        </TableShell>
      )}
    </AppShell>
  );
}
