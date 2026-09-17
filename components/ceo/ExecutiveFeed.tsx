import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui";
import { ActionDecision } from "@/components/approvals/ActionDecision";
import {
  sourceModuleLabel,
  riskTierLabel,
  riskTierTone,
  canDecide,
  type RequiredRole,
} from "@/lib/actions/types";
import type { ExecutiveFeed as ExecutiveFeedData, FeedKind } from "@/lib/ceo/mission-control";

// The Executive Feed — Tony's live queue on the CEO Mission Control page. Every
// item is a REAL pending action_request produced by a proactive loop (delivery
// risk, quality, finance, ad-ops, opportunity engine, …). Nothing is fabricated;
// when the queue is empty the panel says so honestly.
//
// APPROVE / REJECT go through the SAME server action the Approvals queue uses
// (decideActionRequest via <ActionDecision/>), so approving here executes the
// action exactly as it would on /approvals — RLS remains the real gate. "Review"
// deep-links to the full card for the complete reasoning + audit trail.

const KIND_LABEL: Record<FeedKind, string> = {
  APPROVAL: "Approval",
  BOTTLENECK: "Bottleneck",
  RECOMMEND: "Recommend",
};
const KIND_TONE: Record<FeedKind, BadgeTone> = {
  APPROVAL: "amber",
  BOTTLENECK: "red",
  RECOMMEND: "teal",
};

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

export function ExecutiveFeed({
  feed,
  role,
  limit = 6,
}: {
  feed: ExecutiveFeedData;
  role: string;
  limit?: number;
}) {
  const items = feed.items.slice(0, limit);
  const overflow = feed.pendingTotal - items.length;

  if (feed.pendingTotal === 0) {
    return (
      <div className="rounded-md border border-dashed border-charcoal-700 bg-charcoal-950/40 px-4 py-8 text-center text-sm text-ink-muted">
        Nothing awaiting a decision. When a proactive loop spots something, Tony&rsquo;s drafted
        action lands here for you to approve.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2.5">
        {items.map(({ request: r, kind }) => {
          const decidable = canDecide(role, r.required_role as RequiredRole);
          const isFollowUp =
            r.proposed_action?.type === "log_followup" || r.proposed_action?.type === "send_outreach";
          const draftedMessage = isFollowUp
            ? String((r.proposed_action?.payload?.drafted_message as string | undefined) ?? "")
            : null;
          return (
            <li key={r.id} className="rounded-lg border border-charcoal-700 bg-charcoal-950/60 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{r.title}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                    {sourceModuleLabel(r.source_module)} · {stamp(r.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge tone={KIND_TONE[kind]}>{KIND_LABEL[kind]}</Badge>
                  {r.risk_tier >= 3 && <Badge tone={riskTierTone(r.risk_tier)}>{riskTierLabel(r.risk_tier)}</Badge>}
                </div>
              </div>

              {(r.recommendation || r.problem) && (
                <p className="mt-2 line-clamp-2 text-xs text-ink-muted">
                  {r.recommendation ?? r.problem}
                </p>
              )}

              <div className="mt-2 flex items-center justify-between gap-3">
                <Link
                  href="/approvals"
                  className="text-xs text-teal-400 hover:text-teal-300"
                >
                  Review full reasoning →
                </Link>
              </div>

              <ActionDecision
                requestId={r.id}
                canDecide={decidable}
                approverLabel={
                  r.required_role === "department_head" ? "CEO / COO / department head" : "CEO / COO"
                }
                draftedMessage={draftedMessage}
              />
            </li>
          );
        })}
      </ul>
      {overflow > 0 && (
        <Link href="/approvals" className="block text-center text-xs text-teal-400 hover:text-teal-300">
          + {overflow} more in the Approval Queue →
        </Link>
      )}
    </div>
  );
}
