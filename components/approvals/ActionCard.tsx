import Link from "next/link";
import { Badge } from "@/components/ui";
import { ActionDecision } from "./ActionDecision";
import { CognitionOptions } from "./CognitionOptions";
import type { CognitionOption } from "@/lib/cognition/types";
import {
  isOutreachChannel,
  isAutoSendChannel,
  CHANNEL_LABEL,
  type OutreachChannel,
} from "@/lib/outreach/channels";
import {
  riskTierLabel,
  riskTierTone,
  statusTone,
  STATUS_LABEL,
  sourceModuleLabel,
  auditEventLabel,
  confidencePct,
  canDecide,
  actionClassLabel,
  actionClassImpact,
  actionClassTone,
  isLeadershipClass,
  type ActionRequestRow,
  type ActionAuditRow,
  type RequiredRole,
} from "@/lib/actions/types";

// One queue card = Tony's full reasoning for a single action_request, plus the
// human decision surface. Pending cards carry live APPROVE / REJECT (only when
// the caller may decide); decided cards show the decision + audit trail. Purely
// presentational — every value is real data handed down from the page.

function stamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 16).replace("T", " ");
  }
}

export function ActionCard({
  request,
  role,
  userName,
  audit,
  emailConfigured = null,
}: {
  request: ActionRequestRow;
  role: string;
  userName: Map<string, string>;
  audit: ActionAuditRow[];
  // Whether an email provider is configured — passed for Vesper's email drafts so
  // the card can warn honestly before approval. null when not relevant.
  emailConfigured?: boolean | null;
}) {
  const decidable = request.status === "pending" && canDecide(role, request.required_role as RequiredRole);
  const evidence = request.evidence ?? [];
  const options = request.options ?? [];

  // The Cognition Loop — and the Executive Council briefs built on it — store a
  // richer per-option shape (What/Why/How/Impact + task split) in the same
  // options jsonb, and are recommendation-only (no executor). Detect either to
  // render the brief layout and Approve/Hold verbs.
  const isCognition =
    request.source_module === "cognition_loop" || request.source_module === "council";
  const cognitionOptions = isCognition ? ((request.options ?? []) as unknown as CognitionOption[]) : [];
  const projectId =
    (request.execution_result?.project_id as string | undefined) ?? null;
  const activityId =
    (request.execution_result?.outreach_activity_id as string | undefined) ?? null;
  const taskId =
    (request.execution_result?.task_id as string | undefined) ?? null;
  const leadId =
    (request.execution_result?.lead_id as string | undefined) ?? null;
  // An executed 'ad_action' carries the change it applied on the platform.
  const adActionResult =
    request.proposed_action?.type === "ad_action" &&
    (request.execution_result?.kind as string | undefined) === "ad_action"
      ? {
          change: String(request.execution_result?.change ?? ""),
          platform: String(request.execution_result?.platform ?? ""),
          objectName: String(request.execution_result?.object_name ?? ""),
        }
      : null;
  const adPlatformLabel =
    adActionResult?.platform === "tiktok_ads"
      ? "TikTok Ads"
      : adActionResult?.platform === "meta_ads"
      ? "Meta Ads"
      : "the platform";

  const actionType = request.proposed_action?.type;
  const payload = request.proposed_action?.payload ?? {};

  // 'log_followup' and Vesper's 'send_outreach' both carry an editable message.
  // Pending cards surface it (editable); decided cards show the final text.
  const isFollowUp = actionType === "log_followup";
  const isOutreach = actionType === "send_outreach";
  const hasEditableMessage = isFollowUp || isOutreach;
  const draftedMessage = hasEditableMessage
    ? String((payload.drafted_message as string | undefined) ?? "")
    : null;
  const followUpChannel = (payload.channel as string | undefined) ?? "email";
  const followUpHref = request.source_module === "affiliate" ? "/creators" : "/outreach";

  // For Vesper outreach: the channel drives the approve verb, the copy button,
  // and the executed copy.
  const rawChannel = payload.channel as string | undefined;
  const outreachChannel: OutreachChannel | null =
    isOutreach && isOutreachChannel(rawChannel) ? rawChannel : null;
  const outreachHref = payload.creator_id ? "/creators" : "/outreach";
  const outreachSent = request.execution_result?.sent === true;
  const outreachRecipient = (request.execution_result?.recipient as string | undefined) ?? null;

  // Cleared approvers for the view-only note: department_head rows can also be
  // decided by the owning department head, so say so.
  const approverLabel =
    request.required_role === "department_head" ? "CEO / COO / department head" : "CEO / COO";

  return (
    <li id={`req-${request.id}`} className="scroll-mt-24 rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
      {/* Header: title + status/risk/confidence badges */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{request.title}</p>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            {sourceModuleLabel(request.source_module)} · drafted {stamp(request.created_at)}
          </p>
          <p
            className={`mt-1 text-[11px] ${
              isLeadershipClass(request.action_class) ? "text-amber-300/90" : "text-ink-muted"
            }`}
          >
            {actionClassImpact(request.action_class)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge tone={actionClassTone(request.action_class)}>{actionClassLabel(request.action_class)}</Badge>
          <Badge tone={request.reversible ? "muted" : "red"}>
            {request.reversible ? "Reversible" : "Irreversible"}
          </Badge>
          <Badge tone={riskTierTone(request.risk_tier)}>{riskTierLabel(request.risk_tier)}</Badge>
          {outreachChannel && (
            <Badge tone={isAutoSendChannel(outreachChannel) ? "teal" : "violet"}>
              {CHANNEL_LABEL[outreachChannel]}
              {isAutoSendChannel(outreachChannel) ? "" : " · copy-paste"}
            </Badge>
          )}
          {request.confidence != null && (
            <Badge tone="muted">{confidencePct(request.confidence)} confidence</Badge>
          )}
          <Badge tone={statusTone(request.status)}>{STATUS_LABEL[request.status]}</Badge>
        </div>
      </div>

      {/* Problem + root cause */}
      {request.problem && <p className="mt-3 text-sm text-ink">{request.problem}</p>}
      {request.root_cause && (
        <p className="mt-1.5 text-xs text-ink-muted">
          <span className="font-medium text-ink-muted">Root cause · </span>
          {request.root_cause}
        </p>
      )}

      {/* Evidence */}
      {evidence.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim">Evidence</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {evidence.map((f, i) => (
              <span key={i} className="text-xs text-ink-muted">
                {f.label} <span className="font-mono text-ink">{f.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Options — the Cognition Loop renders its richer 3-possibility brief
          (What/Why/How/Impact + auto/gate split); every other module renders the
          compact label — tradeoff list. */}
      {isCognition ? (
        <CognitionOptions options={cognitionOptions} recommendation={request.recommendation} />
      ) : (
        options.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
              Options Tony weighed
            </p>
            <ul className="space-y-1.5">
              {options.map((o, i) => (
                <li key={i} className="text-xs">
                  <span className="text-ink">{o.label}</span>
                  <span className="text-ink-dim"> — {o.tradeoff}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      )}

      {/* Recommendation + estimated impact */}
      {request.recommendation && (
        <div className="mt-3 rounded-md border border-teal-500/30 bg-teal-500/5 p-2.5">
          <p className="font-mono text-[10px] uppercase tracking-wider text-teal-400">
            Recommendation
          </p>
          <p className="mt-0.5 text-xs text-ink">{request.recommendation}</p>
          {request.estimated_impact?.summary && (
            <p className="mt-1 text-[11px] text-ink-muted">
              Estimated impact — {request.estimated_impact.summary}
            </p>
          )}
        </div>
      )}

      {/* Decision surface (pending) or outcome (decided) */}
      {request.status === "pending" ? (
        <ActionDecision
          requestId={request.id}
          canDecide={decidable}
          approverLabel={approverLabel}
          draftedMessage={draftedMessage}
          outreachChannel={outreachChannel}
          emailConfigured={emailConfigured}
          recommendationOnly={isCognition}
        />
      ) : (
        <div className="mt-3 border-t border-charcoal-700/70 pt-3">
          <p className="text-xs text-ink-muted">
            {STATUS_LABEL[request.status]}
            {request.decided_by ? ` by ${userName.get(request.decided_by) ?? "a reviewer"}` : ""}
            {request.decided_at ? ` · ${stamp(request.decided_at)}` : ""}
            {request.decision_note ? ` — “${request.decision_note}”` : ""}
          </p>
          {projectId && (
            <p className="mt-1 text-xs text-teal-300">
              Executed —{" "}
              <Link href="/projects" className="underline hover:text-teal-200">
                recovery project created
              </Link>
              .
            </p>
          )}
          {activityId && isOutreach && (
            <p className="mt-1 text-xs text-teal-300">
              Executed —{" "}
              {outreachSent ? (
                <>
                  {outreachChannel ? CHANNEL_LABEL[outreachChannel] : "Email"} sent
                  {outreachRecipient ? ` to ${outreachRecipient}` : ""} and logged on the{" "}
                  <Link href={outreachHref} className="underline hover:text-teal-200">
                    {payload.creator_id ? "creator" : "lead"}
                  </Link>
                  .
                </>
              ) : (
                <>
                  logged as a manually-sent{" "}
                  {outreachChannel ? CHANNEL_LABEL[outreachChannel] : "message"} touch on the{" "}
                  <Link href={outreachHref} className="underline hover:text-teal-200">
                    {payload.creator_id ? "creator" : "lead"}
                  </Link>
                  . Nothing was auto-sent — you sent it by hand.
                </>
              )}
            </p>
          )}
          {activityId && !isOutreach && (
            <p className="mt-1 text-xs text-teal-300">
              Executed — follow-up logged via {followUpChannel} on the{" "}
              <Link href={followUpHref} className="underline hover:text-teal-200">
                {request.source_module === "affiliate" ? "creator" : "lead"}
              </Link>
              . Nothing was sent externally.
            </p>
          )}
          {taskId && (
            <p className="mt-1 text-xs text-teal-300">
              Executed —{" "}
              <Link href="/tasks" className="underline hover:text-teal-200">
                {request.proposed_action?.type === "create_replenishment_task"
                  ? "replenishment task created"
                  : request.proposed_action?.type === "create_push_task"
                  ? "push-to-sell task created"
                  : request.proposed_action?.type === "create_cashflow_task"
                  ? "cash-flow task created"
                  : request.proposed_action?.type === "create_quality_task"
                  ? "quality task created"
                  : "standards task created"}
              </Link>
              {request.proposed_action?.type === "create_replenishment_task"
                ? " for the warehouse / ops head. Nothing was ordered — the human confirms the PO."
                : request.proposed_action?.type === "create_push_task"
                ? " for the ecom / brand owner. Nothing was discounted or seeded — the human picks the tactic."
                : request.proposed_action?.type === "create_cashflow_task"
                ? " for CEO / COO. No money was moved — the OS only opened the plan-owning task."
                : request.proposed_action?.type === "create_quality_task"
                ? " for the ecom / ops owner. Nothing was paused or edited — the human decides the fix."
                : " for the affiliate lead. No deal was paused — the human decides."}
            </p>
          )}
          {leadId && (
            <p className="mt-1 text-xs text-teal-300">
              Executed —{" "}
              <Link href="/leads" className="underline hover:text-teal-200">
                lead created for review
              </Link>
              . Nothing reached a prospect — no outreach, no email.
            </p>
          )}
          {adActionResult && (
            <p className="mt-1 text-xs text-teal-300">
              Executed on {adPlatformLabel} via{" "}
              <Link href="/ad-ops" className="underline hover:text-teal-200">
                Windsor
              </Link>
              —{" "}
              {adActionResult.change === "pause"
                ? "campaign paused"
                : adActionResult.change === "enable"
                ? "campaign enabled"
                : "campaign budget set"}
              {adActionResult.objectName ? ` (“${adActionResult.objectName}”)` : ""}. The before/after is
              in the audit trail below.
            </p>
          )}
          {/* The message that was logged/sent (read-only). */}
          {hasEditableMessage && draftedMessage && (
            <details className="mt-2">
              <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                {isOutreach && outreachSent ? "Sent message" : "Logged message"}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-xs text-ink-muted">
                {draftedMessage}
              </pre>
            </details>
          )}
          {request.status === "failed" && request.error && (
            <p className="mt-1 text-xs text-red-400">Execution failed — {request.error}</p>
          )}

          {/* Audit trail */}
          {audit.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {audit.map((a) => (
                <li key={a.id} className="font-mono text-[10px] text-ink-dim">
                  {stamp(a.created_at)} · {auditEventLabel(a.event)} ·{" "}
                  {a.actor_role === "system" ? "OS" : a.actor_id ? userName.get(a.actor_id) ?? "—" : "—"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
