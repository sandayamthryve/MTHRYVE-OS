import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, Badge, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadLookups } from "@/lib/expenses/data";
import { loadExpenseAudit, type ExpenseAuditRow } from "@/lib/expenses/audit";
import { AUDIT_EVENT_LABEL, type Db, type ExpenseAuditEvent } from "@/lib/expenses/types";

// EXPENSE AUDIT TRAIL — CEO + COO read of the immutable, append-only expense log
// (rows on the shared action_audit table whose event starts with `expense_`).
// Every create / edit / approve / pay / cancel appears here with who did it,
// when, and — for an edit — the exact before/after of each changed field. The
// table is append-only by RLS (no UPDATE/DELETE policy), so nothing shown here
// can be silently altered.
export const dynamic = "force-dynamic";

const EVENT_TONE: Record<ExpenseAuditEvent, BadgeTone> = {
  expense_created: "teal",
  expense_updated: "violet",
  expense_approved: "violet",
  expense_paid: "teal",
  expense_cancelled: "muted",
};

// Render a field value from the before/after diff in a human-readable way — a
// null reads as the honest em-dash, not "null" or a fabricated 0.
function val(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "number") return String(v);
  return String(v);
}

function when(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function AuditEntry({ row, actorName }: { row: ExpenseAuditRow; actorName: string }) {
  return (
    <li className="flex gap-3 border-b border-charcoal-700/60 py-3 last:border-0">
      <div className="mt-0.5 shrink-0">
        <Badge tone={EVENT_TONE[row.event]}>{AUDIT_EVENT_LABEL[row.event]}</Badge>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">
          <span className="font-mono text-xs text-teal-300">{row.expense_code ?? "—"}</span>
          <span className="mx-2 text-ink-dim">·</span>
          <span className="text-ink-muted">
            {actorName}
            {row.actor_role ? ` (${row.actor_role})` : ""}
          </span>
        </p>
        {row.changes && row.changes.length > 0 && (
          <table className="mt-1.5 w-full max-w-2xl text-xs">
            <tbody>
              {row.changes.map((c, i) => (
                <tr key={i}>
                  <td className="py-0.5 pr-3 font-mono text-ink-dim">{c.field}</td>
                  <td className="py-0.5 pr-2 text-red-300 line-through">{val(c.from)}</td>
                  <td className="py-0.5 pr-2 text-ink-dim">→</td>
                  <td className="py-0.5 text-teal-300">{val(c.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {row.note && <p className="mt-1 text-xs text-ink-muted">Note: {row.note}</p>}
        <p className="mt-1 font-mono text-[11px] text-ink-dim">{when(row.created_at)}</p>
      </div>
    </li>
  );
}

export default async function ExpenseAuditPage() {
  const profile = await requireModule("/finance/expenses/audit");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  const [lookups, rows] = await Promise.all([
    loadLookups(db, profile.org_id),
    loadExpenseAudit(db, { limit: 300 }),
  ]);

  return (
    <AppShell breadcrumb={["Finance", "Expenses", "Audit"]} profile={profile}>
      <PageHeader
        title="Expense Audit Trail"
        subtitle="Immutable, append-only log of every ledger change. CEO / COO read-only."
        action={
          <Link
            href="/finance/expenses"
            className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted transition-colors hover:text-ink"
          >
            ← Dashboard
          </Link>
        }
      />

      <SectionCard title={`Recent activity (${rows.length})`}>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No expense activity recorded yet. Encoding, editing, approving or paying an expense will
            each append a row here.
          </p>
        ) : (
          <ul>
            {rows.map((r) => (
              <AuditEntry
                key={r.id}
                row={r}
                actorName={
                  r.actor_id ? lookups.userById.get(r.actor_id) ?? "Unknown user" : "System"
                }
              />
            ))}
          </ul>
        )}
      </SectionCard>

      <p className="mt-3 text-xs text-ink-dim">
        Entries are written to the shared <code className="text-ink-muted">action_audit</code> trail
        and cannot be edited or deleted — the table has no update or delete policy.
      </p>
    </AppShell>
  );
}
