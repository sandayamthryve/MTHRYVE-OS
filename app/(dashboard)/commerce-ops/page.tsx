import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, StatTile, TableShell, Badge, rowClass, HelpHint } from "@/components/ui";
import { requireDepartment } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso } from "@/lib/metrics/format";
import { RecordCalendar, type CalendarRecord } from "@/components/commerce-ops/RecordCalendar";
import {
  DEPARTMENTS,
  DETAIL_FIELDS,
  RECORD_TYPES,
  RECORD_TYPE_LABEL,
  RECORD_TYPE_SINGULAR,
  STATUS_LABEL,
  isLeadership,
  isRecordType,
  statusTone,
  type DetailField,
  type OpStatus,
  type RecordType,
} from "@/lib/commerce-ops/records";
import {
  acknowledgeRouting,
  completeOpRecord,
  createOpRecord,
  decideOpRecord,
  rollDownOpRecord,
  submitOpRecord,
  updateOpRecord,
} from "./actions";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// Commerce Ops → Operational Records. Four operational record types —
// Campaigns, Promotions, Missions, Rewards — on ONE unified table and ONE
// standardized approval workflow that reuses the Action & Approval spine. Each
// tab: create/edit + draft, submit for approval, approve / reject / request
// revision (leadership, DB-guarded), roll-down to connected departments with
// acknowledgement, approval history from action_audit, and (campaign/promotion)
// a calendar + timeline. Money is recorded only — never moved.

export const dynamic = "force-dynamic";

type OpRecord = {
  id: string;
  record_type: RecordType;
  brand_id: string | null;
  title: string;
  details: Record<string, unknown> | null;
  status: OpStatus;
  assigned_team: string | null;
  start_date: string | null;
  end_date: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  archived_at: string | null;
};
type Routing = {
  id: string;
  op_record_id: string;
  department: string;
  routed_at: string;
  routed_by: string | null;
  acknowledged: boolean;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
};
type AuditRow = {
  id: string;
  event: string;
  actor_id: string | null;
  actor_role: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};
type Brand = { id: string; name: string };
type UserRow = { id: string; full_name: string };

type Shim = { from: (t: string) => any };

function detailStr(details: Record<string, unknown> | null, key: string): string {
  const v = details?.[key];
  if (v == null || v === "") return "";
  return String(v);
}
function detailNum(details: Record<string, unknown> | null, key: string): number | null {
  const v = details?.[key];
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

const AUDIT_LABEL: Record<string, string> = {
  "op_record.draft": "Created (draft)",
  "op_record.submitted": "Submitted for approval",
  "op_record.approved": "Approved",
  "op_record.rejected": "Rejected",
  "op_record.revision_requested": "Revision requested",
  "op_record.completed": "Completed",
  "op_record.routed": "Rolled down to department(s)",
  created: "Approval request drafted",
  approved: "Approval decision · approved",
  rejected: "Approval decision · rejected",
};
function auditLabel(ev: string): string {
  return AUDIT_LABEL[ev] ?? ev;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function CommerceOpsPage({
  searchParams,
}: {
  searchParams?: { tab?: string; r?: string; archived?: string };
}) {
  // Commerce operating page — department-scoped (E-Commerce Ops + Warehouse),
  // leadership bypasses. RLS still scopes rows underneath.
  const profile = await requireModule("/commerce-ops");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const tab: RecordType = isRecordType(searchParams?.tab ?? "") ? (searchParams!.tab as RecordType) : "campaign";
  const selectedId = (searchParams?.r ?? "").trim();
  const archived = searchParams?.archived === "1";
  const lead = isLeadership(profile.role);

  // Default list hides archived records; the Archived view shows only them.
  const recQuery = db
    .from("op_records")
    .select(
      "id, record_type, brand_id, title, details, status, assigned_team, start_date, end_date, created_by, approved_by, approved_at, created_at, archived_at"
    )
    .order("created_at", { ascending: false });

  const [recRes, routeRes, auditRes, brandRes, userRes] = await Promise.all([
    archived ? recQuery.not("archived_at", "is", null) : recQuery.is("archived_at", null),
    db.from("op_record_routing").select("*").order("routed_at", { ascending: false }),
    db
      .from("action_audit")
      .select("id, event, actor_id, actor_role, detail, created_at")
      .order("created_at", { ascending: false })
      .limit(500),
    db.from("brands").select("id, name").order("name"),
    db.from("users").select("id, full_name"),
  ]);

  const allRecords = (recRes.data ?? []) as OpRecord[];
  const routing = (routeRes.data ?? []) as Routing[];
  const audit = (auditRes.data ?? []) as AuditRow[];
  const brands = (brandRes.data ?? []) as Brand[];
  const users = (userRes.data ?? []) as UserRow[];

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const userName = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? "—";

  const records = allRecords.filter((r) => r.record_type === tab);
  const selected = allRecords.find((r) => r.id === selectedId) ?? null;

  // Audit + routing indexed by op_record id.
  const auditFor = (id: string) =>
    audit.filter((a) => String(a.detail?.op_record_id ?? "") === id);
  const routingFor = (id: string) => routing.filter((r) => r.op_record_id === id);

  const countBy = (st: OpStatus) => records.filter((r) => r.status === st).length;
  const timelineRecords: CalendarRecord[] = records.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    start_date: r.start_date,
    end_date: r.end_date,
  }));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Commerce Ops", "Operational Records"]} profile={profile}>
      <PageHeader
        title={<>Operational Records <HelpHint id="commerce.marketplace" /></>}
        subtitle="Campaigns, Promotions, Missions & Rewards — one standardized approval workflow with roll-down routing. Budget & reward values are recorded for human action only."
      />

      {/* Tabs */}
      <div className="mb-6 flex flex-wrap gap-2">
        {RECORD_TYPES.map((t) => (
          <a
            key={t}
            href={`/commerce-ops?tab=${t}`}
            className={`rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors ${
              t === tab
                ? "border-teal-500/50 bg-teal-500/10 text-teal-200"
                : "border-charcoal-700 bg-charcoal-900 text-ink-muted hover:text-ink"
            }`}
          >
            {RECORD_TYPE_LABEL[t]}
            <span className="ml-1.5 font-mono text-[10px] text-ink-muted">
              {allRecords.filter((r) => r.record_type === t).length}
            </span>
          </a>
        ))}
      </div>

      {/* KPI tiles */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Total" value={records.length} />
        <StatTile label="Draft" value={countBy("draft")} />
        <StatTile label="Submitted" value={countBy("submitted")} />
        <StatTile label="Approved" value={countBy("approved")} />
        <StatTile label="Revisions" value={countBy("revision_requested")} />
        <StatTile label="Completed" value={countBy("completed")} />
      </div>

      {/* Calendar + timeline for time-bound record types */}
      {(tab === "campaign" || tab === "promotion") && (
        <div className="mb-6">
          <RecordCalendar records={timelineRecords} month={new Date()} />
        </div>
      )}

      <div className="mb-6 flex justify-end">
        <ArchivedToggle basePath="/commerce-ops" archived={archived} params={{ tab }} />
      </div>

      {/* Create form */}
      {!archived && (
      <details className="mb-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900 shadow-elevate">
        <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold text-ink">
          + New {RECORD_TYPE_SINGULAR[tab]}
        </summary>
        <form action={createOpRecord} className="border-t border-charcoal-700/60 p-5">
          <input type="hidden" name="record_type" value={tab} />
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              name="title"
              required
              placeholder={`${RECORD_TYPE_LABEL[tab].slice(0, -1)} title`}
              className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink sm:col-span-2"
            />
            <select name="brand_id" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
              <option value="">Brand (optional)…</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <input
              name="assigned_team"
              placeholder="Assigned team / owner"
              className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            />
            <label className="text-xs text-ink-muted">
              Start date
              <input name="start_date" type="date" className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
            </label>
            <label className="text-xs text-ink-muted">
              End date
              <input name="end_date" type="date" className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
            </label>
            {DETAIL_FIELDS[tab].map((f) => (
              <DetailInput key={f.key} field={f} />
            ))}
          </div>
          <button type="submit" className="mt-4 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
            Save as draft
          </button>
        </form>
      </details>
      )}

      {/* Records table */}
      <TableShell columns={[RECORD_TYPE_LABEL[tab].slice(0, -1), "Brand", "Team", "Key detail", "Dates", "Status", "", "Manage"]}>
        {records.length === 0 && (
          <tr>
            <td colSpan={8} className="p-4 text-ink-muted">
              {archived
                ? `No archived ${RECORD_TYPE_LABEL[tab].toLowerCase()}.`
                : `No ${RECORD_TYPE_LABEL[tab].toLowerCase()} yet — add your first above.`}
            </td>
          </tr>
        )}
        {records.map((r) => {
          const routes = routingFor(r.id);
          const acked = routes.filter((x) => x.acknowledged).length;
          return (
            <tr key={r.id} className={`${rowClass} ${r.id === selectedId ? "bg-charcoal-800/40" : ""}`}>
              <td className="p-3">
                <span className="text-ink">{r.title}</span>
                {routes.length > 0 && (
                  <span className="block font-mono text-[10px] text-ink-muted">
                    routed {acked}/{routes.length} ack
                  </span>
                )}
              </td>
              <td className="p-3 text-ink-muted">{brandName(r.brand_id)}</td>
              <td className="p-3 text-ink-muted">{r.assigned_team ?? "—"}</td>
              <td className="p-3 text-ink-muted">{keyDetail(r)}</td>
              <td className="p-3 font-mono text-xs text-ink-muted">
                {r.start_date ?? "—"}{r.end_date ? ` → ${r.end_date}` : ""}
              </td>
              <td className="p-3">
                <Badge tone={statusTone(r.status)}>{STATUS_LABEL[r.status]}</Badge>
              </td>
              <td className="p-3">
                <a
                  href={`/commerce-ops?tab=${tab}&r=${r.id}`}
                  className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-teal-300 hover:bg-charcoal-800"
                >
                  {r.id === selectedId ? "Open" : "Manage"}
                </a>
              </td>
              <td className="p-3">
                <RowActions {...rowActionProps("op_records", r as unknown as Record<string, unknown>, profile)} />
              </td>
            </tr>
          );
        })}
      </TableShell>

      {selected && selected.record_type === tab && (
        <RecordPanel
          record={selected}
          routes={routingFor(selected.id)}
          history={auditFor(selected.id)}
          brands={brands}
          brandName={brandName}
          userName={userName}
          canApprove={lead}
        />
      )}
    </AppShell>
  );
}

// ── Type-specific detail input ────────────────────────────────────────────────
function DetailInput({ field, value }: { field: DetailField; value?: string }) {
  const name = `d_${field.key}`;
  const common = "mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";
  return (
    <label className="text-xs text-ink-muted sm:col-span-1">
      {field.label}
      {field.kind === "select" ? (
        <select name={name} defaultValue={value ?? ""} className={common}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>{o.replace(/_/g, " ")}</option>
          ))}
        </select>
      ) : field.kind === "textarea" ? (
        <textarea name={name} rows={2} defaultValue={value ?? ""} placeholder={field.placeholder} className={common} />
      ) : (
        <input
          name={name}
          type={field.kind === "money" || field.kind === "number" ? "text" : "text"}
          inputMode={field.kind === "money" || field.kind === "number" ? "numeric" : undefined}
          defaultValue={value ?? ""}
          placeholder={field.placeholder}
          className={common}
        />
      )}
      {field.help && <span className="mt-0.5 block text-[10px] text-ink-muted/80">{field.help}</span>}
    </label>
  );
}

// One-line summary of the most telling type-specific field for the table.
function keyDetail(r: OpRecord): string {
  const d = r.details;
  switch (r.record_type) {
    case "campaign": {
      const b = detailNum(d, "budget");
      return b != null ? `Budget ${peso(b)}` : detailStr(d, "objective") || "—";
    }
    case "promotion": {
      const t = detailStr(d, "promo_type").replace(/_/g, " ");
      const v = detailStr(d, "discount_value");
      return [t, v].filter(Boolean).join(" · ") || "—";
    }
    case "mission": {
      const p = detailNum(d, "progress");
      const c = detailStr(d, "completion").replace(/_/g, " ");
      return [c, p != null ? `${p}%` : ""].filter(Boolean).join(" · ") || "—";
    }
    case "reward": {
      const v = detailNum(d, "value");
      const cs = detailStr(d, "claim_status");
      return [v != null ? peso(v) : "", cs].filter(Boolean).join(" · ") || "—";
    }
    default:
      return "—";
  }
}

// ── Detail management panel ───────────────────────────────────────────────────
function RecordPanel({
  record,
  routes,
  history,
  brands,
  brandName,
  userName,
  canApprove,
}: {
  record: OpRecord;
  routes: Routing[];
  history: AuditRow[];
  brands: Brand[];
  brandName: (id: string | null) => string;
  userName: (id: string | null) => string;
  canApprove: boolean;
}) {
  const st = record.status;
  const label = RECORD_TYPE_SINGULAR[record.record_type];
  const canSubmit = st === "draft" || st === "revision_requested";
  const canDecide = canApprove && st === "submitted";
  const canRoll = canApprove && st === "approved";
  const routedDepts = new Set(routes.map((r) => r.department));

  return (
    <section className="mt-8 space-y-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {record.title} <span className="text-sm font-normal text-ink-muted">· {label}</span>
          </h2>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
            <Badge tone={statusTone(st)}>{STATUS_LABEL[st]}</Badge>
            {record.approved_by && <span>approved by {userName(record.approved_by)}</span>}
          </p>
        </div>
        <a href={`/commerce-ops?tab=${record.record_type}`} className="text-xs text-ink-muted hover:text-ink">
          Close
        </a>
      </div>

      {/* Workflow controls */}
      <div className="flex flex-wrap items-center gap-2">
        {canSubmit && (
          <form action={submitOpRecord}>
            <input type="hidden" name="id" value={record.id} />
            <button className="rounded-md bg-teal-500 px-3.5 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
              Submit for approval
            </button>
          </form>
        )}
        {canDecide && (
          <>
            <form action={decideOpRecord} className="flex items-center gap-2">
              <input type="hidden" name="id" value={record.id} />
              <input type="hidden" name="decision" value="approved" />
              <button className="rounded-md bg-teal-500 px-3.5 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
                Approve
              </button>
            </form>
            <form action={decideOpRecord} className="flex items-center gap-2">
              <input type="hidden" name="id" value={record.id} />
              <input type="hidden" name="decision" value="revision_requested" />
              <input name="note" placeholder="Revision note…" className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-xs text-ink" />
              <button className="rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-sm text-violet-200 hover:bg-violet-500/20">
                Request revision
              </button>
            </form>
            <form action={decideOpRecord} className="flex items-center gap-2">
              <input type="hidden" name="id" value={record.id} />
              <input type="hidden" name="decision" value="rejected" />
              <button className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/20">
                Reject
              </button>
            </form>
          </>
        )}
        {st === "approved" && (
          <form action={completeOpRecord}>
            <input type="hidden" name="id" value={record.id} />
            <button className="rounded-md border border-charcoal-700 px-3.5 py-1.5 text-sm text-ink hover:bg-charcoal-800">
              Mark completed
            </button>
          </form>
        )}
        {!canApprove && st === "submitted" && (
          <span className="text-xs text-ink-muted">Awaiting leadership approval.</span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Edit form */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Details</h3>
          <form action={updateOpRecord} className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-4">
            <input type="hidden" name="id" value={record.id} />
            <input type="hidden" name="record_type" value={record.record_type} />
            <div className="grid gap-3">
              <input name="title" defaultValue={record.title} className="rounded-md border border-charcoal-700 bg-charcoal-900 p-2.5 text-sm text-ink" />
              <select name="brand_id" defaultValue={record.brand_id ?? ""} className="rounded-md border border-charcoal-700 bg-charcoal-900 p-2.5 text-sm text-ink">
                <option value="">Brand (optional)…</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <input name="assigned_team" defaultValue={record.assigned_team ?? ""} placeholder="Assigned team / owner" className="rounded-md border border-charcoal-700 bg-charcoal-900 p-2.5 text-sm text-ink" />
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-ink-muted">
                  Start
                  <input name="start_date" type="date" defaultValue={record.start_date ?? ""} className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-900 p-2.5 text-sm text-ink" />
                </label>
                <label className="text-xs text-ink-muted">
                  End
                  <input name="end_date" type="date" defaultValue={record.end_date ?? ""} className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-900 p-2.5 text-sm text-ink" />
                </label>
              </div>
              {DETAIL_FIELDS[record.record_type].map((f) => (
                <DetailInput key={f.key} field={f} value={detailStr(record.details, f.key)} />
              ))}
            </div>
            <button className="mt-3 rounded-md border border-charcoal-700 px-3.5 py-1.5 text-sm text-teal-300 hover:bg-charcoal-800">
              Save details
            </button>
            {!canSubmit && !canApprove && (
              <p className="mt-2 text-[10px] text-ink-muted">
                Editing after submission requires leadership permission.
              </p>
            )}
          </form>
        </div>

        {/* Approval history */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Approval history</h3>
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-4">
            {history.length === 0 ? (
              <p className="text-sm text-ink-muted">No activity yet.</p>
            ) : (
              <ol className="space-y-3">
                {history
                  .slice()
                  .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                  .map((h) => (
                    <li key={h.id} className="flex gap-3">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-400" />
                      <div>
                        <p className="text-sm text-ink">{auditLabel(h.event)}</p>
                        <p className="font-mono text-[10px] text-ink-muted">
                          {h.actor_role ?? "system"}
                          {h.actor_id ? ` · ${userName(h.actor_id)}` : ""} · {timeAgo(h.created_at)}
                        </p>
                        {typeof h.detail?.note === "string" && h.detail.note && (
                          <p className="mt-0.5 text-xs text-ink-muted">“{String(h.detail.note)}”</p>
                        )}
                        {Array.isArray(h.detail?.departments) && (
                          <p className="mt-0.5 text-xs text-ink-muted">
                            → {(h.detail!.departments as string[]).join(", ")}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
              </ol>
            )}
          </div>
        </div>
      </div>

      {/* Roll-Down panel */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">Roll down to connected department</h3>
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-4">
          {st !== "approved" && routes.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Roll-down unlocks once this {label} is <span className="text-teal-300">approved</span>.
            </p>
          ) : (
            <>
              {canRoll && (
                <form action={rollDownOpRecord} className="mb-4">
                  <input type="hidden" name="id" value={record.id} />
                  <p className="mb-2 text-xs text-ink-muted">
                    Forward this approved {label} to one or more departments. Each generates an in-app
                    notification and logs a departmental acknowledgement.
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {DEPARTMENTS.map((d) => {
                      const done = routedDepts.has(d);
                      return (
                        <label
                          key={d}
                          className={`flex items-center gap-2 rounded-md border p-2 text-xs ${
                            done ? "border-charcoal-700 text-ink-muted" : "border-charcoal-700 text-ink"
                          }`}
                        >
                          <input type="checkbox" name="departments" value={d} disabled={done} className="accent-teal-500" />
                          {d}{done && <span className="text-[10px] text-teal-400">✓</span>}
                        </label>
                      );
                    })}
                  </div>
                  <button className="mt-3 rounded-md bg-teal-500 px-3.5 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
                    Roll down
                  </button>
                </form>
              )}

              {routes.length > 0 ? (
                <ul className="space-y-2">
                  {routes.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 rounded-md border border-charcoal-800 bg-charcoal-900 p-2.5">
                      <div>
                        <p className="text-sm text-ink">{r.department}</p>
                        <p className="font-mono text-[10px] text-ink-muted">
                          routed {timeAgo(r.routed_at)} by {userName(r.routed_by)}
                          {r.acknowledged && ` · ack by ${userName(r.acknowledged_by)}`}
                        </p>
                      </div>
                      {r.acknowledged ? (
                        <Badge tone="teal">Acknowledged</Badge>
                      ) : (
                        <form action={acknowledgeRouting}>
                          <input type="hidden" name="routing_id" value={r.id} />
                          <button className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-500/20">
                            Acknowledge
                          </button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">Not routed to any department yet.</p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
