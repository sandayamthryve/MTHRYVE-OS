// components/outreach/bridge/OutreachBridge.tsx — the whole Lean Outreach Bridge,
// dropped into an existing page (Leads or Affiliate/Engage) with one line:
//   <OutreachBridge recipientType="lead"    profile={profile} />
//   <OutreachBridge recipientType="creator" profile={profile} />
//
// It is a SERVER component: it fetches the audience's contacts, messages and
// timeline (all RLS/org-scoped), gates itself to the function that owns the
// audience (bizdev on leads, partnerships on creators — NOT all-org), and renders
// the four steps — Draft → Approve → Export → Import — plus status chips and a
// per-contact activity timeline. The draft/export/import steps are client islands;
// the approval + tracking + timeline are server-rendered, wiring the server
// actions directly.

import { SectionCard, Badge, TableShell, rowClass } from "@/components/ui";
import type { SessionProfile } from "@/lib/auth/session";
import {
  canRunBridge,
  isOutreachLeadership,
  deliveryStatusTone,
  DELIVERY_STATUS_LABEL,
  RECIPIENT_LABEL,
  type RecipientType,
  type DeliveryStatus,
} from "@/lib/outreach/bridge";
import {
  draftBridgeOutreach,
  editBridgeDraft,
  approveBridgeMessage,
  exportApprovedBatch,
  importBridgeResults,
} from "@/lib/outreach/bridge-actions";
import { DraftOutreachForm, type ContactOption } from "./DraftOutreachForm";
import { ExportBatchButton } from "./ExportBatchButton";
import { ImportResultsForm } from "./ImportResultsForm";

type Db = { from: (t: string) => any };

const EMPTY = "—";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  return iso.slice(0, 10);
}

function deliveryLabel(s: string): string {
  return DELIVERY_STATUS_LABEL[s as DeliveryStatus] ?? s;
}

export async function OutreachBridge({
  recipientType,
  profile,
  supabase,
}: {
  recipientType: RecipientType;
  profile: SessionProfile;
  supabase: Db;
}) {
  // Gate: only the function that owns this audience (+ head + leadership).
  if (!canRunBridge(profile, recipientType)) return null;
  const iAmApprover = isOutreachLeadership(profile.role);

  const contactTable = recipientType === "lead" ? "leads" : "creators";
  const contactSelect =
    recipientType === "lead"
      ? "id, name, company, email, do_not_contact"
      : "id, name, handle, email";

  const [contactsRes, messagesRes, activitiesRes] = await Promise.all([
    supabase.from(contactTable).select(contactSelect).is("archived_at", null).order("name"),
    supabase
      .from("outreach_messages")
      .select("id, recipient_id, body, status, delivery_status, batch_label, approved_at, exported_at, created_at")
      .eq("recipient_type", recipientType)
      .is("archived_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("outreach_activities")
      .select("id, lead_id, creator_id, activity_type, note, occurred_at")
      .not(recipientType === "lead" ? "lead_id" : "creator_id", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(25),
  ]);

  const contacts = (contactsRes.data ?? []) as {
    id: string;
    name: string | null;
    company?: string | null;
    handle?: string | null;
    email: string | null;
    do_not_contact?: boolean | null;
  }[];
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const contactName = (id: string | null) => (id ? contactById.get(id)?.name ?? "Unknown" : EMPTY);

  // Draft dropdown: skip contacts already flagged do_not_contact (leads only) and
  // those with no email (an email bridge needs an address).
  const contactOptions: ContactOption[] = contacts
    .filter((c) => !c.do_not_contact && (c.email ?? "").trim())
    .map((c) => {
      const tag = recipientType === "lead" ? c.company : c.handle;
      return { value: c.id, label: tag ? `${c.name ?? "Unknown"} (${tag})` : c.name ?? "Unknown" };
    });

  const messages = (messagesRes.data ?? []) as {
    id: string;
    recipient_id: string | null;
    body: string | null;
    status: string;
    delivery_status: string;
    batch_label: string | null;
    approved_at: string | null;
    exported_at: string | null;
    created_at: string | null;
  }[];

  const pending = messages.filter((m) => m.delivery_status === "draft" || m.delivery_status === "approved");
  const approvedCount = messages.filter((m) => m.delivery_status === "approved").length;
  const tracked = messages.filter(
    (m) => !["draft", "approved"].includes(m.delivery_status)
  );

  const activities = (activitiesRes.data ?? []) as {
    id: string;
    lead_id: string | null;
    creator_id: string | null;
    activity_type: string;
    note: string | null;
    occurred_at: string;
  }[];

  const label = RECIPIENT_LABEL[recipientType].toLowerCase();
  const btnApprove =
    "rounded-md bg-violet-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500";
  const btnGhost =
    "rounded-md border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-xs font-medium text-ink hover:bg-charcoal-800";

  return (
    <SectionCard
      title="Lean Outreach Bridge"
      className="mb-6"
    >
      <p className="mb-4 text-xs text-ink-muted">
        Draft → approve → <strong>export a Gmail-merge CSV</strong> → run your free merge by hand → import the results.
        No ESP, no subscription, no auto-send. The OS is the brain; your existing Gmail merge is the hands.
      </p>

      {/* 1 — DRAFT */}
      <div className="mb-6">
        <h3 className="mb-2 text-sm font-semibold text-ink">1 · Draft outreach</h3>
        {contactOptions.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No contactable {label}s yet — add a {label} with an email first.
          </p>
        ) : (
          <DraftOutreachForm action={draftBridgeOutreach} recipientType={recipientType} contacts={contactOptions} />
        )}
      </div>

      {/* 2 — APPROVE */}
      <div className="mb-6">
        <h3 className="mb-2 text-sm font-semibold text-ink">2 · Approve</h3>
        {pending.length === 0 ? (
          <p className="text-sm text-ink-muted">No drafts awaiting approval.</p>
        ) : (
          <TableShell columns={["Contact", "Status", "Message & action"]}>
            {pending.map((m) => {
              const isDraft = m.delivery_status === "draft";
              return (
                <tr key={m.id} className={rowClass}>
                  <td className="p-3 align-top font-medium text-ink">{contactName(m.recipient_id)}</td>
                  <td className="p-3 align-top">
                    <Badge tone={deliveryStatusTone(m.delivery_status)}>{deliveryLabel(m.delivery_status)}</Badge>
                  </td>
                  <td className="p-3 align-top">
                    {isDraft ? (
                      <div className="flex flex-col gap-2">
                        <form action={editBridgeDraft} className="flex flex-col gap-1.5">
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="recipient_type" value={recipientType} />
                          <textarea
                            name="body"
                            rows={5}
                            defaultValue={m.body ?? ""}
                            className="w-full min-w-[18rem] rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-xs text-ink"
                          />
                          <div className="flex items-center gap-2">
                            <button type="submit" className={btnGhost}>
                              Save edits
                            </button>
                            <span className="text-[10px] text-ink-dim">Edit first, then approve — nothing sends.</span>
                          </div>
                        </form>
                        {iAmApprover ? (
                          <form action={approveBridgeMessage}>
                            <input type="hidden" name="id" value={m.id} />
                            <input type="hidden" name="recipient_type" value={recipientType} />
                            <button type="submit" className={btnApprove}>
                              Approve
                            </button>
                          </form>
                        ) : (
                          <span className="text-[11px] text-ink-dim">Awaiting leadership approval.</span>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <p className="max-w-md whitespace-pre-wrap text-xs text-ink-muted">{m.body ?? EMPTY}</p>
                        <span className="text-[11px] text-violet-300">
                          Approved {fmtDate(m.approved_at)} — included in the next export.
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </div>

      {/* 3 — EXPORT */}
      <div className="mb-6">
        <h3 className="mb-2 text-sm font-semibold text-ink">3 · Export approved batch</h3>
        <ExportBatchButton action={exportApprovedBatch} recipientType={recipientType} approvedCount={approvedCount} />
      </div>

      {/* 4 — IMPORT RESULTS */}
      <div className="mb-6">
        <h3 className="mb-2 text-sm font-semibold text-ink">4 · Import results</h3>
        <ImportResultsForm action={importBridgeResults} recipientType={recipientType} />
      </div>

      {/* Tracking — the sent/opened/replied/bounced loop state */}
      <div className="mb-6">
        <h3 className="mb-2 text-sm font-semibold text-ink">Delivery tracking</h3>
        {tracked.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing exported yet.</p>
        ) : (
          <TableShell columns={["Contact", "Batch", "Delivery", "Exported"]}>
            {tracked.map((m) => (
              <tr key={m.id} className={rowClass}>
                <td className="p-3 font-medium text-ink">{contactName(m.recipient_id)}</td>
                <td className="p-3 font-mono text-[11px] text-ink-muted">{m.batch_label ?? EMPTY}</td>
                <td className="p-3">
                  <Badge tone={deliveryStatusTone(m.delivery_status)}>{deliveryLabel(m.delivery_status)}</Badge>
                </td>
                <td className="p-3 text-ink-muted">{fmtDate(m.exported_at)}</td>
              </tr>
            ))}
          </TableShell>
        )}
      </div>

      {/* Per-contact activity timeline */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">Activity timeline</h3>
        {activities.length === 0 ? (
          <p className="text-sm text-ink-muted">No outreach activity yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {activities.map((a) => {
              const cid = recipientType === "lead" ? a.lead_id : a.creator_id;
              return (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="text-ink-dim">{fmtDate(a.occurred_at)}</span>
                  <span className="font-medium text-ink">{contactName(cid)}</span>
                  <Badge tone="muted">{a.activity_type.replace(/^outreach_/, "").replace(/_/g, " ")}</Badge>
                  {a.note && <span className="text-ink-muted">{a.note}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
