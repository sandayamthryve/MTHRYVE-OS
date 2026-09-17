import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, Badge, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso } from "@/lib/metrics/format";
import { manilaStamp, todayManila } from "@/lib/metrics/windows";
import {
  OUTREACH_ROLES,
  STAGES,
  STAGE_LABEL,
  ACTIVITY_TYPES,
  ACTIVITY_LABEL,
  canEditLead,
  normalizeStage,
  isActivityType,
  type OutreachLead,
  type OutreachActivity,
  type ActivityType,
} from "@/lib/outreach/leads";
import { updateLead, logActivity } from "../actions";
import { VesperReachPanel } from "@/components/outreach/VesperReachPanel";

// Lead detail — the full contact/company/pipeline record for one lead, the
// activity timeline from outreach_activities, a "Log activity" form that also
// advances last_contacted_at, and (for leadership or the owner) the lead editor.
// Org/RLS scoped: the row only loads if it belongs to the caller's org. Every
// unrecorded field reads as an em-dash — nothing is fabricated.

export const dynamic = "force-dynamic";

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";
const EMPTY = "—";

const STAGE_TONE: Record<string, BadgeTone> = {
  new: "muted",
  contacted: "violet",
  replied: "violet",
  meeting: "amber",
  proposal: "amber",
  won: "teal",
  lost: "red",
};

const ACTIVITY_TONE: Record<ActivityType, BadgeTone> = {
  call: "violet",
  email: "teal",
  message: "violet",
  meeting: "amber",
  note: "muted",
  proposal: "amber",
};

// ISO → "YYYY-MM-DDTHH:mm" in Asia/Manila for a datetime-local default.
function toManilaInput(iso: string | null): string {
  if (!iso) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hh = get("hour") === "24" ? "00" : get("hour");
    return `${get("year")}-${get("month")}-${get("day")}T${hh}:${get("minute")}`;
  } catch {
    return "";
  }
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className="mt-1 text-sm text-ink">{value}</p>
    </div>
  );
}

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireModule("/outreach");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  const [leadRes, usersRes, activitiesRes] = await Promise.all([
    u
      .from("leads")
      .select(
        "id, name, company, email, phone, source, department, stage, value, notes, owner_id, next_action, next_action_date, last_contacted_at, created_at, updated_at"
      )
      .eq("id", params.id)
      .maybeSingle(),
    supabase.from("users").select("id, full_name").order("full_name"),
    u
      .from("outreach_activities")
      .select("id, lead_id, activity_type, note, occurred_at, created_by, created_at")
      .eq("lead_id", params.id)
      .order("occurred_at", { ascending: false }),
  ]);

  const lead = leadRes.data as OutreachLead | null;
  if (!lead) notFound();

  const users = (usersRes.data ?? []) as unknown as { id: string; full_name: string }[];
  const userName = (id: string | null) =>
    id ? users.find((x) => x.id === id)?.full_name ?? "Unknown" : "Unassigned";
  const activities = (activitiesRes.data ?? []) as OutreachActivity[];

  const canEdit = canEditLead({ id: profile.id, role: profile.role }, lead);
  const stage = normalizeStage(lead.stage);
  const today = todayManila();
  const followupOverdue =
    lead.next_action_date != null && lead.next_action_date <= today && stage !== "won" && stage !== "lost";

  return (
    <AppShell breadcrumb={["Mthryve OS", "BizDev Outreach", lead.name]} profile={profile}>
      <div className="mb-4">
        <Link href="/outreach" className="text-xs text-ink-muted hover:text-teal-300">
          ← Back to BizDev Outreach
        </Link>
      </div>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {lead.name}
            <Badge tone={STAGE_TONE[stage] ?? "muted"}>{STAGE_LABEL[stage]}</Badge>
          </span>
        }
        subtitle={lead.company ?? undefined}
      />

      {/* Record */}
      <SectionCard title="Lead" className="mb-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Contact" value={lead.name} />
          <Field label="Company" value={lead.company ?? EMPTY} />
          <Field label="Email" value={lead.email ?? EMPTY} />
          <Field label="Phone" value={lead.phone ?? EMPTY} />
          <Field label="Source" value={lead.source ?? EMPTY} />
          <Field label="Department" value={lead.department ?? EMPTY} />
          <Field label="Owner" value={userName(lead.owner_id)} />
          <Field label="Value" value={lead.value != null ? peso(Number(lead.value)) : EMPTY} />
          <Field
            label="Next action"
            value={
              lead.next_action || lead.next_action_date ? (
                <span>
                  {lead.next_action ?? "—"}
                  {lead.next_action_date && (
                    <span className={`ml-1 font-mono text-xs ${followupOverdue ? "text-amber-300" : "text-ink-muted"}`}>
                      ({lead.next_action_date})
                    </span>
                  )}
                </span>
              ) : (
                EMPTY
              )
            }
          />
          <Field label="Last contacted" value={manilaStamp(lead.last_contacted_at) ?? EMPTY} />
        </div>
        {lead.notes && (
          <div className="mt-4 border-t border-charcoal-700/60 pt-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Notes</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-muted">{lead.notes}</p>
          </div>
        )}
      </SectionCard>

      {/* Vesper Reach — gated outreach drafting */}
      {["ceo", "coo", "department_head"].includes(profile.role) && (
        <SectionCard title="Vesper Reach — draft outreach" className="mb-6">
          <VesperReachPanel targetType="lead" targetId={lead.id} hasEmail={Boolean(lead.email)} />
        </SectionCard>
      )}

      {/* Log activity */}
      {canEdit && (
        <SectionCard title="Log activity" className="mb-6">
          <p className="mb-3 text-xs text-ink-muted">
            Records an outreach touch on the timeline and updates this lead&apos;s “last contacted”
            to the activity time.
          </p>
          <form action={logActivity} className="grid gap-3 sm:grid-cols-4">
            <input type="hidden" name="lead_id" value={lead.id} />
            <select name="activity_type" defaultValue="call" className={inputCls} aria-label="Activity type">
              {ACTIVITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACTIVITY_LABEL[t]}
                </option>
              ))}
            </select>
            <input
              name="occurred_at"
              type="datetime-local"
              className={inputCls}
              aria-label="Occurred at (defaults to now)"
            />
            <input name="note" placeholder="What happened?" className={`${inputCls} sm:col-span-2`} />
            <div className="sm:col-span-4">
              <button
                type="submit"
                className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
              >
                Log activity
              </button>
            </div>
          </form>
        </SectionCard>
      )}

      {/* Activity timeline */}
      <SectionCard title="Activity timeline" className="mb-6">
        {activities.length === 0 ? (
          <p className="text-sm text-ink-muted">No activity logged yet.</p>
        ) : (
          <ol className="relative space-y-4 border-l border-charcoal-700/60 pl-5">
            {activities.map((a) => {
              const type = isActivityType(a.activity_type) ? a.activity_type : null;
              return (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[1.42rem] top-1.5 h-2.5 w-2.5 rounded-full bg-teal-500/70 ring-4 ring-charcoal-900" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={type ? ACTIVITY_TONE[type] : "muted"}>
                      {type ? ACTIVITY_LABEL[type] : a.activity_type}
                    </Badge>
                    <span className="font-mono text-[11px] text-ink-dim">
                      {manilaStamp(a.occurred_at) ?? a.occurred_at}
                    </span>
                    <span className="text-[11px] text-ink-dim">· {userName(a.created_by)}</span>
                  </div>
                  {a.note && <p className="mt-1 whitespace-pre-wrap text-sm text-ink-muted">{a.note}</p>}
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>

      {/* Edit */}
      {canEdit ? (
        <SectionCard title="Edit lead">
          <form action={updateLead}>
            <input type="hidden" name="id" value={lead.id} />
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Name
                <input name="name" required defaultValue={lead.name} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Company
                <input name="company" defaultValue={lead.company ?? ""} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Stage
                <select name="stage" defaultValue={stage} className={inputCls}>
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Email
                <input name="email" defaultValue={lead.email ?? ""} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Phone
                <input name="phone" defaultValue={lead.phone ?? ""} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Source
                <input name="source" defaultValue={lead.source ?? ""} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Department
                <input name="department" defaultValue={lead.department ?? ""} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Value (PHP)
                <input
                  name="value"
                  type="number"
                  step="any"
                  defaultValue={lead.value != null ? String(lead.value) : ""}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Next action
                <input name="next_action" defaultValue={lead.next_action ?? ""} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Next action date
                <input
                  name="next_action_date"
                  type="date"
                  defaultValue={lead.next_action_date ?? ""}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
                Last contacted
                <input
                  name="last_contacted_at"
                  type="datetime-local"
                  defaultValue={toManilaInput(lead.last_contacted_at)}
                  className={inputCls}
                />
              </label>
            </div>
            <label className="mt-3 flex flex-col gap-1 text-[11px] text-ink-muted">
              Notes
              <textarea name="notes" rows={3} defaultValue={lead.notes ?? ""} className={inputCls} />
            </label>
            <button
              type="submit"
              className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Save changes
            </button>
          </form>
        </SectionCard>
      ) : (
        <SectionCard title="Edit lead">
          <p className="text-sm text-ink-muted">
            Only this lead&apos;s owner ({userName(lead.owner_id)}) or leadership can edit it.
          </p>
        </SectionCard>
      )}
    </AppShell>
  );
}
