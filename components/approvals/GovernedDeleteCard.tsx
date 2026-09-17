import { Badge } from "@/components/ui";
import { GovernedDecision } from "./GovernedDecision";
import {
  statusTone,
  STATUS_LABEL,
  sourceModuleLabel,
  auditEventLabel,
  type ActionRequestRow,
  type ActionAuditRow,
} from "@/lib/actions/types";

// One card for a governed permanent-delete request. Renders the sequential
// COO → CEO chain with each stage's state, and — only for the officer whose turn
// it is — the live Approve/Reject surface. Purely presentational; the server
// action re-enforces the stage→role gate, so this only decides what to show.

function stamp(iso: string | null | undefined): string {
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

// One line in the chain: the stage's role, its outcome, and who/when.
function StageLine({
  n,
  role,
  decision,
  byName,
  at,
  note,
  active,
}: {
  n: number;
  role: string;
  decision: "approved" | "rejected" | null | undefined;
  byName: string | null;
  at: string | null | undefined;
  note: string | null | undefined;
  active: boolean;
}) {
  const tone = decision === "approved" ? "teal" : decision === "rejected" ? "red" : active ? "amber" : "muted";
  const label = decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : active ? "Awaiting" : "Waiting";
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
        Stage {n} · {role}
      </span>
      <Badge tone={tone}>{label}</Badge>
      {(decision || (byName && at)) && (
        <span className="text-ink-muted">
          {byName ? `${byName}` : ""}
          {at ? ` · ${stamp(at)}` : ""}
          {note ? ` — “${note}”` : ""}
        </span>
      )}
    </li>
  );
}

export function GovernedDeleteCard({
  request,
  role,
  userName,
  audit,
}: {
  request: ActionRequestRow;
  role: string;
  userName: Map<string, string>;
  audit: ActionAuditRow[];
}) {
  const status = request.status;
  const requesterName = request.created_by ? userName.get(request.created_by) ?? "Someone" : "Someone";
  const cooName = request.first_decided_by ? userName.get(request.first_decided_by) ?? null : null;
  const ceoName = request.final_decided_by ? userName.get(request.final_decided_by) ?? null : null;

  // Whose turn it is — the ONLY gate that renders live buttons (the server action
  // re-checks). Stage 1 is the COO; stage 2 is the CEO. Strict order.
  const canDecideCoo = status === "pending_coo" && role === "coo";
  const canDecideCeo = status === "pending_ceo" && role === "ceo";
  const decidable = canDecideCoo || canDecideCeo;

  const viewerNote =
    status === "pending_coo"
      ? "Awaiting the COO's first approval."
      : status === "pending_ceo"
        ? "Awaiting the CEO's final sign-off."
        : null;

  return (
    <li id={`req-${request.id}`} className="scroll-mt-24 rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{request.title}</p>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            {sourceModuleLabel(request.source_module)} · requested by {requesterName} · {stamp(request.created_at)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge tone="red">Permanent delete</Badge>
          <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>
        </div>
      </div>

      {request.problem && <p className="mt-3 text-sm text-ink">{request.problem}</p>}

      {/* The sequential chain. */}
      <ul className="mt-3 space-y-1.5">
        <StageLine
          n={1}
          role="COO"
          decision={request.first_decision}
          byName={cooName}
          at={request.first_decided_at}
          note={request.first_note}
          active={status === "pending_coo"}
        />
        <StageLine
          n={2}
          role="CEO"
          decision={request.final_decision}
          byName={ceoName}
          at={request.final_decided_at}
          note={request.final_note}
          active={status === "pending_ceo"}
        />
      </ul>

      {/* Decision surface (only the current officer) or a view-only note. */}
      {decidable ? (
        <GovernedDecision requestId={request.id} stage={canDecideCeo ? "ceo" : "coo"} />
      ) : viewerNote ? (
        <p className="mt-3 border-t border-charcoal-700/70 pt-3 text-xs text-ink-muted">
          View only — {viewerNote}
        </p>
      ) : null}

      {/* Terminal outcomes. */}
      {status === "executed" && (
        <p className="mt-3 border-t border-charcoal-700/70 pt-3 text-xs text-teal-300">
          Executed — the record was permanently deleted after the CEO's approval.
        </p>
      )}
      {status === "rejected" && (
        <p className="mt-3 border-t border-charcoal-700/70 pt-3 text-xs text-ink-muted">
          Rejected — nothing was deleted.
        </p>
      )}
      {status === "failed" && (
        <p className="mt-3 border-t border-charcoal-700/70 pt-3 text-xs text-red-400">
          Approved, but the delete failed{request.error ? ` — ${request.error}` : ""}.
        </p>
      )}

      {/* Audit trail. */}
      {audit.length > 0 && (
        <ul className="mt-3 space-y-0.5 border-t border-charcoal-700/70 pt-2">
          {audit.map((a) => (
            <li key={a.id} className="font-mono text-[10px] text-ink-dim">
              {stamp(a.created_at)} · {auditEventLabel(a.event)} ·{" "}
              {a.actor_role === "system" ? "OS" : a.actor_id ? userName.get(a.actor_id) ?? "—" : "—"}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
