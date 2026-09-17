import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, rowClass, Badge } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso, pesoOrDash } from "@/lib/metrics/format";
import { todayManila, currentMonth } from "@/lib/metrics/windows";
import {
  OUTREACH_ROLES,
  STAGES,
  STAGE_LABEL,
  CLOSED_STAGES,
  canEditLead,
  normalizeStage,
  type OutreachLead,
} from "@/lib/outreach/leads";
import { LeadsCsvButton } from "../leads/LeadsCsvButton";
import { ImportLeadsControl } from "../leads/ImportLeadsControl";
import { PipelineBoard, type BoardCard } from "./PipelineBoard";
import { createLead, importLeads, moveLeadStage } from "./actions";
import { ScanFollowUpsButton } from "@/components/outreach/ScanFollowUpsButton";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// BizDev Outreach — the pipeline board, follow-ups due, and pipeline tiles over
// the shared `leads` table plus the `outreach_activities` timeline. Org/RLS
// scoped: only the caller's org's leads load. Leadership (CEO/COO) can move any
// lead; everyone else can move only leads they own — the board renders
// non-editable cards read-only, and the server actions re-check on write.
// Nothing is fabricated: an unknown value reads as an em-dash, never a zero.

export const dynamic = "force-dynamic";

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

// ISO timestamp → YYYY-MM-DD in Asia/Manila, so "won this month" and freshness
// compare on the company's calendar day rather than UTC.
function manilaDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

export default async function OutreachPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const profile = await requireModule("/outreach");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };
  const archived = searchParams?.archived === "1";

  // Default board hides archived leads; the Archived view shows only them.
  const leadsQuery = u
    .from("leads")
    .select(
      "id, name, company, email, phone, source, department, stage, value, notes, owner_id, next_action, next_action_date, last_contacted_at, created_at, updated_at, archived_at"
    )
    .order("created_at", { ascending: false });

  const [leadsRes, usersRes] = await Promise.all([
    archived ? leadsQuery.not("archived_at", "is", null) : leadsQuery.is("archived_at", null),
    supabase.from("users").select("id, full_name").order("full_name"),
  ]);

  const leads = (leadsRes.data ?? []) as OutreachLead[];
  const users = (usersRes.data ?? []) as unknown as { id: string; full_name: string }[];
  const ownerName = (id: string | null) =>
    id ? users.find((x) => x.id === id)?.full_name ?? "Unknown" : "Unassigned";

  const today = todayManila();
  const monthStart = currentMonth().start;

  // Only roles RLS lets draft an action_request may run the follow-up scan.
  const canScan = ["ceo", "coo", "department_head"].includes(profile.role);

  // ── Tiles ──────────────────────────────────────────────────────────────
  // Pipeline value by stage: sum of value grouped by canonical stage.
  const stageStats = STAGES.map((stage) => {
    const inStage = leads.filter((l) => normalizeStage(l.stage) === stage);
    const value = inStage.reduce((a, l) => a + Number(l.value ?? 0), 0);
    return { stage, count: inStage.length, value };
  });
  const openValue = leads
    .filter((l) => !CLOSED_STAGES.includes(normalizeStage(l.stage)))
    .reduce((a, l) => a + Number(l.value ?? 0), 0);

  // Follow-ups due today: next_action_date on or before today.
  const followUps = leads
    .filter((l) => l.next_action_date != null && l.next_action_date <= today)
    .sort((a, b) => (a.next_action_date! < b.next_action_date! ? -1 : 1));

  // Won this month: moved to "won" with a last change in the current Manila month.
  const wonThisMonth = leads.filter((l) => {
    if (normalizeStage(l.stage) !== "won") return false;
    const d = manilaDate(l.updated_at) ?? manilaDate(l.created_at);
    return d != null && d >= monthStart && d <= today;
  });
  const wonValue = wonThisMonth.reduce((a, l) => a + Number(l.value ?? 0), 0);

  // ── Board cards ────────────────────────────────────────────────────────
  const cards: BoardCard[] = leads.map((l) => ({
    id: l.id,
    name: l.name,
    company: l.company,
    valueLabel: l.value != null ? peso(Number(l.value)) : "—",
    owner: ownerName(l.owner_id),
    nextActionDate: l.next_action_date,
    nextActionOverdue: l.next_action_date != null && l.next_action_date <= today,
    stage: normalizeStage(l.stage),
    canEdit: canEditLead({ id: profile.id, role: profile.role }, l),
  }));

  // CSV export rows — every org lead (RLS-scoped), shared leads format.
  const exportRows = leads.map((l) => ({
    name: l.name,
    company: l.company ?? "",
    email: l.email ?? "",
    phone: l.phone ?? "",
    source: l.source ?? "",
    department: l.department ?? "",
    stage: l.stage,
    value: l.value != null ? String(l.value) : "",
    notes: l.notes ?? "",
  }));

  return (
    <AppShell breadcrumb={["Mthryve OS", "BizDev Outreach"]} profile={profile}>
      <PageHeader
        title="BizDev Outreach"
        subtitle="Work the pipeline from first touch to close — drag leads across stages, log every outreach, and stay on top of follow-ups."
        action={
          <div className="flex items-start gap-2">
            {canScan && <ScanFollowUpsButton />}
            <LeadsCsvButton rows={exportRows} filename="outreach-leads.csv" />
          </div>
        }
      />

      {/* Pipeline value by stage */}
      <div className="mb-3 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {stageStats.map((s) => (
          <StatTile
            key={s.stage}
            label={STAGE_LABEL[s.stage]}
            value={s.value > 0 ? peso(s.value) : "—"}
            hint={`${s.count} lead${s.count === 1 ? "" : "s"}`}
          />
        ))}
      </div>

      {/* Summary tiles */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Open pipeline value"
          value={openValue > 0 ? peso(openValue) : "—"}
          hint="Excludes won & lost"
        />
        <StatTile
          label="Follow-ups due today"
          value={followUps.length}
          valueClassName={followUps.length > 0 ? "text-amber-300" : "text-ink"}
          hint="Next action on or before today"
        />
        <StatTile
          label="Won this month"
          value={wonThisMonth.length}
          hint={wonValue > 0 ? peso(wonValue) : "No wins yet"}
          valueClassName={wonThisMonth.length > 0 ? "text-teal-300" : "text-ink"}
        />
      </div>

      <div className="mb-4 flex justify-end">
        <ArchivedToggle basePath="/outreach" archived={archived} />
      </div>

      {!archived && (
      <SectionCard title="Pipeline" className="mb-6" bodyClassName="-mx-1">
        {leads.length === 0 ? (
          <p className="px-1 py-6 text-sm text-ink-muted">
            No leads yet — add one below or import a CSV to build the pipeline.
          </p>
        ) : (
          <PipelineBoard cards={cards} move={moveLeadStage} />
        )}
      </SectionCard>
      )}

      {/* Manage leads — edit / archive (or restore) each lead. */}
      <SectionCard title={archived ? "Archived leads" : "Manage leads"} className="mb-6">
        {leads.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {archived ? "No archived leads." : "No leads yet."}
          </p>
        ) : (
          <TableShell columns={["Lead", "Owner", "Stage", "Manage"]}>
            {leads.map((l) => (
              <tr key={l.id} className={rowClass}>
                <td className="p-3">
                  <Link href={`/outreach/${l.id}`} className="text-ink hover:text-teal-300">
                    {l.name}
                  </Link>
                  {l.company ? <span className="text-ink-muted"> · {l.company}</span> : ""}
                </td>
                <td className="p-3 text-ink-muted">{ownerName(l.owner_id)}</td>
                <td className="p-3">
                  <Badge tone="muted">{STAGE_LABEL[normalizeStage(l.stage)]}</Badge>
                </td>
                <td className="p-3">
                  <RowActions {...rowActionProps("leads", l as unknown as Record<string, unknown>, profile)} />
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </SectionCard>

      {/* Follow-ups due */}
      {!archived && (
      <SectionCard title="Follow-ups due" className="mb-6">
        {followUps.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing due — every lead's next action is in the future.</p>
        ) : (
          <TableShell columns={["Lead", "Next action", "Due", "Owner", "Stage"]}>
            {followUps.map((l) => {
              const overdue = l.next_action_date! < today;
              return (
                <tr key={l.id} className={rowClass}>
                  <td className="p-3">
                    <Link href={`/outreach/${l.id}`} className="text-ink hover:text-teal-300">
                      {l.name}
                    </Link>
                    {l.company ? <span className="text-ink-muted"> · {l.company}</span> : ""}
                  </td>
                  <td className="p-3 text-ink-muted">{l.next_action ?? "—"}</td>
                  <td className="p-3">
                    <span className={`font-mono text-xs ${overdue ? "text-red-300" : "text-amber-300"}`}>
                      {l.next_action_date}
                    </span>
                    {overdue && (
                      <Badge tone="red" className="ml-2">
                        Overdue
                      </Badge>
                    )}
                  </td>
                  <td className="p-3 text-ink-muted">{ownerName(l.owner_id)}</td>
                  <td className="p-3">
                    <Badge tone="muted">{STAGE_LABEL[normalizeStage(l.stage)]}</Badge>
                  </td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </SectionCard>
      )}

      {/* Add lead */}
      {!archived && (
      <SectionCard title="Add lead" className="mb-6">
        <form action={createLead}>
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="name" required placeholder="Lead / contact name" className={inputCls} />
            <input name="company" placeholder="Company / brand" className={inputCls} />
            <input name="email" placeholder="Email / handle" className={inputCls} />
            <input name="phone" placeholder="Phone" className={inputCls} />
            <input name="source" placeholder="Source (e.g. TikTok, referral)" className={inputCls} />
            <select name="department" defaultValue="Business Development" className={inputCls}>
              <option value="Business Development">Business Development</option>
              <option value="Affiliate">Affiliate</option>
            </select>
            <input name="value" type="number" step="any" placeholder="Est. value (PHP)" className={inputCls} />
            <input name="next_action" placeholder="Next action (e.g. Send deck)" className={inputCls} />
            <input name="next_action_date" type="date" className={inputCls} aria-label="Next action date" />
          </div>
          <button
            type="submit"
            className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
          >
            Add lead
          </button>
        </form>
      </SectionCard>
      )}

      {/* Import CSV — shared leads importer */}
      {!archived && (
      <SectionCard title="Import Leads (CSV)">
        <p className="mb-3 text-xs text-ink-muted">
          Bulk-add leads from a spreadsheet, using the same format as the Leads/CRM import. Rows
          missing a name are skipped and reported — nothing is fabricated.
        </p>
        <ImportLeadsControl action={importLeads} />
      </SectionCard>
      )}
    </AppShell>
  );
}
