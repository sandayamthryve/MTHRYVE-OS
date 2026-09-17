import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, rowClass, Badge } from "@/components/ui";
import { AffiliateTabs } from "@/components/affiliate/AffiliateTabs";
import { ComposeOutreachForm, type TemplateLite } from "@/components/affiliate/ComposeOutreachForm";
import { OnboardingForm, type OnboardingRecord } from "@/components/affiliate/OnboardingForm";
import { DraftWithVesperPanel } from "@/components/affiliate/vesper/DraftWithVesperPanel";
import { VesperReplyForm } from "@/components/affiliate/vesper/VesperReplyForm";
import { VesperReviewQueue, type ReviewMessage } from "@/components/affiliate/vesper/VesperReviewQueue";
import { OutreachBridge } from "@/components/outreach/bridge/OutreachBridge";
import { ONBOARDING_STEPS } from "@/lib/affiliate/vocabulary";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isEmailConfigured } from "@/lib/outreach/email";
import { EMPTY } from "@/lib/metrics/format";
import { MANAGE_ROLES, canApprove } from "@/lib/affiliate/domain";
import { createOutreachMessage, saveOnboarding } from "../actions";
import { draftWithVesper, draftVesperReply } from "../vesper-actions";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// SECTION 2 — Engage: Vesper Reach (AI-drafted outbound + replies) → a human
// review/approve gate → a channel-aware send, plus creator onboarding intake.
// GATED SEND is the load-bearing rule: nothing auto-sends. Every draft (Vesper or
// hand-composed) needs a leadership approval; email then sends via the app, and
// copy channels (TikTok DM / Viber / …) stage as 'ready_to_send' for a human to
// copy-and-send by hand. We never fake a send.
export const dynamic = "force-dynamic";

type Db = { from: (t: string) => any };

export default async function AffiliateEngagePage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const profile = await requireModule("/affiliate");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;
  const iAmApprover = canApprove(profile.role);
  const emailConfigured = isEmailConfigured();

  // The default queue shows active messages; the Archived view shows only
  // archived ones. (A sent message can't be archived — enforced server-side.)
  const archived = searchParams?.archived === "1";
  const messageQuery = db
    .from("outreach_messages")
    .select("id, recipient_id, channel, body, status, approved_by, approved_at, sent_at, created_at, archived_at")
    .eq("recipient_type", "creator")
    .order("created_at", { ascending: false });

  const [creatorsRes, templatesRes, messagesRes, onboardingRes, campaignsRes] = await Promise.all([
    db.from("creators").select("id, name, handle, email").order("name"),
    db
      .from("outreach_templates")
      .select("id, name, channel, subject, body")
      .order("created_at", { ascending: false }),
    archived ? messageQuery.not("archived_at", "is", null) : messageQuery.is("archived_at", null),
    db
      .from("creator_onboarding")
      .select("creator_id, email, phone, address, platform_links, preferred_schedule, shipping_details, complete"),
    // An affiliate campaign is an op_record of record_type 'campaign' — the same
    // thing the fulfillment page loads, so both agree on what a campaign is.
    db
      .from("op_records")
      .select("id, title")
      .eq("record_type", "campaign")
      .order("created_at", { ascending: false }),
  ]);

  const creators = (creatorsRes.data ?? []) as {
    id: string;
    name: string | null;
    handle: string | null;
    email: string | null;
  }[];
  const creatorById = new Map(creators.map((c) => [c.id, c]));
  const creatorName = (id: string | null) => (id ? creatorById.get(id)?.name ?? "Unknown" : EMPTY);
  const creatorOptions = creators.map((c) => ({
    value: c.id,
    label: c.handle ? `${c.name ?? "Unknown"} (${c.handle})` : c.name ?? "Unknown",
  }));

  const campaignOptions = ((campaignsRes.data ?? []) as { id: string; title: string | null }[]).map(
    (c) => ({ value: c.id, label: c.title ?? "Untitled campaign" })
  );

  const templates = (templatesRes.data ?? []) as TemplateLite[];
  const rawMessages = (messagesRes.data ?? []) as {
    id: string;
    recipient_id: string | null;
    channel: string;
    body: string | null;
    status: string;
    approved_at: string | null;
    sent_at: string | null;
    created_at: string | null;
    archived_at: string | null;
  }[];
  const messages: ReviewMessage[] = rawMessages.map((m) => ({
    id: m.id,
    creatorName: creatorName(m.recipient_id),
    channel: m.channel,
    body: m.body,
    status: m.status,
    approved_at: m.approved_at,
    sent_at: m.sent_at,
    created_at: m.created_at,
    recipientHasEmail: Boolean(m.recipient_id && (creatorById.get(m.recipient_id)?.email ?? "").trim()),
  }));
  const onboarding = (onboardingRes.data ?? []) as OnboardingRecord[];

  const noCreators = creators.length === 0;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Affiliate", "Engage"]} profile={profile}>
      <PageHeader
        title="Engage"
        subtitle="Vesper drafts outreach and replies; a human approves before anything sends."
      />
      <AffiliateTabs />

      <div className="mb-6 flex justify-end">
        <ArchivedToggle basePath="/affiliate/engage" archived={archived} />
      </div>

      {/* Vesper Reach — OUTBOUND */}
      <SectionCard title="Draft with Vesper" className="mb-6">
        {noCreators ? (
          <p className="text-sm text-ink-muted">No creators yet — source creators under Campaigns first.</p>
        ) : (
          <DraftWithVesperPanel action={draftWithVesper} creators={creatorOptions} templates={templates} />
        )}
      </SectionCard>

      {/* Vesper Reach — INBOUND REPLY */}
      <SectionCard title="Reply with Vesper" className="mb-6">
        {noCreators ? (
          <p className="text-sm text-ink-muted">No creators to reply to yet.</p>
        ) : (
          <VesperReplyForm action={draftVesperReply} creators={creatorOptions} />
        )}
      </SectionCard>

      {/* Manual compose — still feeds the same review queue */}
      <SectionCard title="Compose by hand" className="mb-6">
        {noCreators ? (
          <p className="text-sm text-ink-muted">No creators yet.</p>
        ) : (
          <ComposeOutreachForm
            action={createOutreachMessage}
            creators={creatorOptions}
            templates={templates}
            campaigns={campaignOptions}
          />
        )}
      </SectionCard>

      {/* Review → approve → send (the gate) */}
      <SectionCard title="Review & send" className="mb-6" bodyClassName="p-0">
        <VesperReviewQueue messages={messages} iAmApprover={iAmApprover} emailConfigured={emailConfigured} />
        <p className="border-t border-charcoal-700/60 p-3 text-[11px] text-ink-dim">
          Nothing auto-sends. Email is approved then sent by the app (only when EMAIL_* / SMTP is configured). TikTok DM,
          Viber and other channels stage as “ready to send” — copy the approved text and send it by hand, then mark it sent.
        </p>
      </SectionCard>

      {/* Manage — edit / archive / restore each message. A sent message can't be
          archived; that guard is enforced server-side by the shared action. */}
      <SectionCard title={archived ? "Archived messages" : "Manage messages"} className="mb-6" bodyClassName="p-0">
        {rawMessages.length === 0 ? (
          <p className="p-5 text-sm text-ink-muted">
            {archived ? "No archived messages." : "No messages yet."}
          </p>
        ) : (
          <TableShell columns={["Creator", "Channel", "Status", "Manage"]}>
            {rawMessages.map((m) => (
              <tr key={m.id} className={rowClass}>
                <td className="p-3 font-medium text-ink">{creatorName(m.recipient_id)}</td>
                <td className="p-3">
                  <Badge tone="muted">{m.channel}</Badge>
                </td>
                <td className="p-3 text-ink-muted">{m.status}</td>
                <td className="p-3">
                  <RowActions {...rowActionProps("outreach_messages", m as unknown as Record<string, unknown>, profile)} />
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </SectionCard>

      {/* Lean Outreach Bridge — draft → approve → export a Gmail-merge CSV →
          import results, for creators. Gated to Partnerships / Affiliate (+ head
          + leadership); renders nothing for anyone else. */}
      <OutreachBridge recipientType="creator" profile={profile} supabase={db} />

      {/* Onboarding intake */}
      <SectionCard title="Onboarding intake">
        {/* The deck's Onboarding stage, in the team's own words. Only the last
            step has a field on this form — the other three happen in the
            platform and the chat, and this is where the operator is looking
            when they need reminding. Listing them here is not a claim that the
            app stores a brief or a deck; it does not. */}
        <ol className="mb-4 space-y-1 text-[11px] text-ink-dim">
          {ONBOARDING_STEPS.map((step, index) => (
            <li key={step}>
              <span className="font-mono text-ink-muted">{index + 1}.</span> {step}
            </li>
          ))}
        </ol>
        {noCreators ? (
          <p className="text-sm text-ink-muted">No creators to onboard yet.</p>
        ) : (
          <OnboardingForm action={saveOnboarding} creators={creatorOptions} existing={onboarding} />
        )}
      </SectionCard>
    </AppShell>
  );
}
