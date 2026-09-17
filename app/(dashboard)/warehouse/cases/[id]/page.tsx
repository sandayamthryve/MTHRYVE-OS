import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso } from "@/lib/metrics/format";
import { safeUrl } from "@/lib/security/sanitize";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABEL,
  CASE_STATUSES,
  CASE_STATUS_LABEL,
  CASE_LEADERSHIP_ONLY,
  RTS_REASON_LABEL,
  caseStatusTone,
  priorityTone,
  type CasePriority,
  type CaseStatus,
} from "@/lib/warehouse/rts";
import { addCaseRemark, assignCase, updateCaseStatus } from "../actions";

// Warehouse — a single case. Assign (reuses tasks + notifies + records history),
// drive the status workflow (Resolved/Closed leadership-only), and post remarks
// to the chronological timeline. The timeline merges the case_updates remarks
// with the case's action_audit rows (status transitions + assignment), so it is
// the one honest record of everything that happened.

export const dynamic = "force-dynamic";

type Brand = { id: string; name: string };
type User = { id: string; full_name: string };
type CaseRow = {
  id: string;
  case_number: string | null;
  rts_id: string | null;
  brand_id: string | null;
  product: string | null;
  sku: string | null;
  customer: string | null;
  reason: string | null;
  shipping_details: string | null;
  assigned_to: string | null;
  priority: string | null;
  due_date: string | null;
  status: string | null;
  created_at: string;
};
type UpdateRow = {
  id: string;
  user_id: string | null;
  remarks: string | null;
  attachments: { url?: string }[] | null;
  created_at: string;
};
type AuditRow = {
  id: string;
  event: string;
  actor_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export default async function CaseDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireModule("/warehouse/cases");
  const isLeadership =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const supabase = createServerSupabaseClient();

  const { data: caseData } = await supabase
    .from("cases")
    .select(
      "id, case_number, rts_id, brand_id, product, sku, customer, reason, shipping_details, assigned_to, priority, due_date, status, created_at"
    )
    .eq("id", params.id)
    .maybeSingle();
  const c = caseData as unknown as CaseRow | null;
  if (!c) notFound();

  const [brandRes, userRes, updatesRes, auditRes, rtsRes] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
    supabase
      .from("case_updates")
      .select("id, user_id, remarks, attachments, created_at")
      .eq("case_id", c.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("action_audit")
      .select("id, event, actor_id, detail, created_at")
      .eq("detail->>case_id", c.id)
      .order("created_at", { ascending: false }),
    c.rts_id
      ? supabase
          .from("return_cases")
          .select("rts_number, shipping_fee, courier, order_number")
          .eq("id", c.rts_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const users = (userRes.data ?? []) as unknown as User[];
  const updates = (updatesRes.data ?? []) as unknown as UpdateRow[];
  const audits = (auditRes.data ?? []) as unknown as AuditRow[];
  const rts = (rtsRes.data ?? null) as unknown as {
    rts_number: string | null;
    shipping_fee: number | null;
    courier: string | null;
    order_number: string | null;
  } | null;

  const userName = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? "—";
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const st = (c.status ?? "new") as CaseStatus;

  // Merge remarks + audit events into one chronological timeline (newest first).
  type Entry = { at: string; kind: "remark" | "audit"; who: string; text: string; url?: string };
  const timeline: Entry[] = [
    ...updates.map((u) => ({
      at: u.created_at,
      kind: "remark" as const,
      who: userName(u.user_id),
      text: u.remarks ?? "",
      url: u.attachments?.[0]?.url,
    })),
    ...audits.map((a) => {
      const d = a.detail ?? {};
      let text = a.event;
      if (a.event === "case.assigned") {
        text = `Assigned to ${userName((d.to as string) ?? null)}${
          d.due_date ? ` · due ${d.due_date}` : ""
        }${d.priority ? ` · ${d.priority}` : ""}`;
      } else if (a.event.startsWith("case.")) {
        const to = a.event.slice("case.".length) as CaseStatus;
        text = `Status → ${CASE_STATUS_LABEL[to] ?? to}`;
      }
      return { at: a.created_at, kind: "audit" as const, who: userName(a.actor_id), text };
    }),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Warehouse", "Case Monitoring", c.case_number ?? "Case"]} profile={profile}>
      <PageHeader
        title={`Case ${c.case_number ?? c.id.slice(0, 8)}`}
        subtitle={c.product ?? "—"}
        action={
          <Link href="/warehouse/cases" className="text-xs text-teal-400 hover:text-teal-300">
            ← All cases
          </Link>
        }
      />

      <div className="mb-8 grid gap-4 lg:grid-cols-3">
        {/* Case details — inherited from the RTS record, not re-typed */}
        <SectionCard title="Case details" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Field label="Status">
              <Badge tone={caseStatusTone(st)}>{CASE_STATUS_LABEL[st]}</Badge>
            </Field>
            <Field label="Priority">
              <Badge tone={priorityTone(c.priority)}>
                {CASE_PRIORITY_LABEL[(c.priority ?? "medium") as CasePriority] ?? c.priority}
              </Badge>
            </Field>
            <Field label="Assigned">{userName(c.assigned_to)}</Field>
            <Field label="Brand">{brandName(c.brand_id)}</Field>
            <Field label="SKU">{c.sku ?? "—"}</Field>
            <Field label="Customer">{c.customer ?? "—"}</Field>
            <Field label="Reason">{RTS_REASON_LABEL.get(c.reason ?? "") ?? c.reason ?? "—"}</Field>
            <Field label="Due date">{c.due_date ?? "—"}</Field>
            <Field label="Opened">{c.created_at.slice(0, 10)}</Field>
            <Field label="RTS number">
              {c.rts_id ? (
                <Link href="/warehouse/rts" className="text-teal-300 hover:text-teal-200">
                  {rts?.rts_number ?? "linked"}
                </Link>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Shipping fee">
              {rts?.shipping_fee != null ? peso(Number(rts.shipping_fee)) : "—"}
            </Field>
            <Field label="Shipping details">{c.shipping_details ?? "—"}</Field>
          </dl>
        </SectionCard>

        {/* Assign + status workflow */}
        <div className="space-y-4">
          <SectionCard title="Assign case">
            <form action={assignCase} className="space-y-2">
              <input type="hidden" name="case_id" value={c.id} />
              <label className="block text-[11px] text-ink-muted">
                Assignee
                <select name="assigned_to" defaultValue={c.assigned_to ?? ""} required className={inputCls}>
                  <option value="">Select…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-ink-muted">
                  Priority
                  <select name="priority" defaultValue={c.priority ?? "medium"} className={inputCls}>
                    {CASE_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {CASE_PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[11px] text-ink-muted">
                  Due date
                  <input name="due_date" type="date" defaultValue={c.due_date ?? ""} className={inputCls} />
                </label>
              </div>
              <button
                type="submit"
                className="w-full rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
              >
                Assign & create task
              </button>
              <p className="text-[11px] text-ink-muted">
                Creates a task in the assignee&apos;s task center, notifies them, and records the
                assignment in the audit trail.
              </p>
            </form>
          </SectionCard>

          <SectionCard title="Move status">
            <form action={updateCaseStatus} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="case_id" value={c.id} />
              <label className="flex-1 text-[11px] text-ink-muted">
                New status
                <select name="status" defaultValue={st} className={inputCls}>
                  {CASE_STATUSES.map((s) => {
                    const locked = CASE_LEADERSHIP_ONLY.has(s) && !isLeadership;
                    return (
                      <option key={s} value={s} disabled={locked}>
                        {CASE_STATUS_LABEL[s]}
                        {locked ? " (leadership)" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-md bg-charcoal-800 px-4 py-2 text-sm font-semibold text-teal-300 hover:bg-charcoal-700"
              >
                Update
              </button>
            </form>
            {!isLeadership && (
              <p className="mt-2 text-[11px] text-ink-muted">
                Resolved and Closed are leadership-only.
              </p>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Remarks + timeline */}
      <SectionCard title="Add remark / progress update" className="mb-6">
        <form action={addCaseRemark} className="space-y-2">
          <input type="hidden" name="case_id" value={c.id} />
          <textarea
            name="remarks"
            required
            rows={2}
            placeholder="What happened / what's next…"
            className={inputCls}
          />
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 text-[11px] text-ink-muted">
              Attachment URL (optional)
              <input name="attachment_url" className={inputCls} />
            </label>
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Post update
            </button>
          </div>
        </form>
      </SectionCard>

      <SectionCard title="Timeline">
        {timeline.length === 0 ? (
          <p className="text-sm text-ink-muted">No activity yet.</p>
        ) : (
          <ol className="space-y-3">
            {timeline.map((e, i) => (
              <li key={i} className="flex gap-3">
                <div
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    e.kind === "remark" ? "bg-teal-500" : "bg-violet-500"
                  }`}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <span className="text-ink">{e.who}</span>
                    <span>·</span>
                    <span>{fmtDateTime(e.at)}</span>
                    {e.kind === "audit" && <Badge tone="muted">event</Badge>}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink">{e.text}</p>
                  {safeUrl(e.url) && (
                    <a
                      href={safeUrl(e.url)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-teal-300 hover:text-teal-200"
                    >
                      Attachment ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </SectionCard>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className="mt-1 text-ink">{children}</dd>
    </div>
  );
}
