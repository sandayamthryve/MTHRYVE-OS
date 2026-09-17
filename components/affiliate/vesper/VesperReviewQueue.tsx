// Vesper Reach → REVIEW + APPROVE + SEND. The single queue for every creator
// outreach_message (Vesper-drafted or hand-composed). A draft can be edited inline
// and then approved; NOTHING leaves 'draft' without a leadership approval. After
// approval the send path depends on the channel:
//   • email          → the app sends it (only when EMAIL_*/SMTP is configured).
//   • copy channels  → 'ready_to_send': show the approved text + Copy, and a human
//                      confirms the hand-paste to mark it sent ("copy-to-send").
// A server component: it wires the server actions directly and embeds the one
// client island it needs (the Copy button).

import { Badge, TableShell, rowClass } from "@/components/ui";
import { EMPTY } from "@/lib/metrics/format";
import { CopyMessageButton } from "@/components/affiliate/CopyMessageButton";
import {
  CHANNEL_LABEL,
  MESSAGE_STATUS_LABEL,
  messageStatusTone,
  hasAppSender,
  isCopyToSend,
  type OutreachChannel,
  type MessageStatus,
} from "@/lib/affiliate/domain";
import {
  editVesperDraft,
  approveVesperMessage,
  sendVesperEmail,
  confirmCopySent,
} from "@/app/(dashboard)/affiliate/vesper-actions";

export interface ReviewMessage {
  id: string;
  creatorName: string;
  channel: string;
  body: string | null;
  status: string;
  approved_at: string | null;
  sent_at: string | null;
  created_at: string | null;
  recipientHasEmail: boolean;
}

const btnPrimary = "rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400";
const btnApprove = "rounded-md bg-violet-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500";
const btnGhost =
  "rounded-md border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-xs font-medium text-ink hover:bg-charcoal-800";

function chan(c: string): string {
  return CHANNEL_LABEL[c as OutreachChannel] ?? c;
}

export function VesperReviewQueue({
  messages,
  iAmApprover,
  emailConfigured,
}: {
  messages: ReviewMessage[];
  iAmApprover: boolean;
  emailConfigured: boolean;
}) {
  if (messages.length === 0) {
    return <p className="p-5 text-sm text-ink-muted">No drafts yet — draft with Vesper above, or compose one by hand.</p>;
  }

  return (
    <TableShell columns={["Creator", "Channel", "Status", "Message & action"]}>
      {messages.map((m) => {
        const isDraft = m.status === "draft";
        const staged = m.status === "approved" || m.status === "ready_to_send";
        const copy = isCopyToSend(m.channel);
        const email = hasAppSender(m.channel);
        return (
          <tr key={m.id} className={rowClass}>
            <td className="p-3 align-top font-medium text-ink">{m.creatorName}</td>
            <td className="p-3 align-top">
              <Badge tone="muted">{chan(m.channel)}</Badge>
            </td>
            <td className="p-3 align-top">
              <Badge tone={messageStatusTone(m.status)}>
                {MESSAGE_STATUS_LABEL[m.status as MessageStatus] ?? m.status}
              </Badge>
            </td>
            <td className="p-3 align-top">
              {isDraft ? (
                <div className="flex flex-col gap-2">
                  {/* Inline edit — the human refines Vesper's draft, then approves. */}
                  <form action={editVesperDraft} className="flex flex-col gap-1.5">
                    <input type="hidden" name="id" value={m.id} />
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
                      <span className="text-[10px] text-ink-dim">Edit first, then approve — nothing sends yet.</span>
                    </div>
                  </form>
                  {iAmApprover ? (
                    <form action={approveVesperMessage}>
                      <input type="hidden" name="id" value={m.id} />
                      <button type="submit" className={btnApprove}>
                        Approve
                      </button>
                    </form>
                  ) : (
                    <span className="text-[11px] text-ink-dim">Awaiting leadership approval.</span>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="max-w-md whitespace-pre-wrap text-xs text-ink-muted">{m.body ?? EMPTY}</p>

                  {m.status === "sent" ? (
                    <span className="text-[11px] text-teal-300">Sent {m.sent_at?.slice(0, 10) ?? ""}</span>
                  ) : staged && email ? (
                    emailConfigured && m.recipientHasEmail ? (
                      <form action={sendVesperEmail}>
                        <input type="hidden" name="id" value={m.id} />
                        <button type="submit" className={btnPrimary}>
                          Send email
                        </button>
                      </form>
                    ) : (
                      <span className="text-[11px] text-amber-300">
                        {m.recipientHasEmail
                          ? "Email not configured — set EMAIL_* / SMTP to send. Nothing was sent."
                          : "No email on file for this creator — add one to send."}
                      </span>
                    )
                  ) : staged && copy ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <CopyMessageButton text={m.body ?? ""} />
                        <form action={confirmCopySent}>
                          <input type="hidden" name="id" value={m.id} />
                          <button type="submit" className={btnPrimary}>
                            I&apos;ve pasted it — mark sent
                          </button>
                        </form>
                      </div>
                      <span className="text-[10px] text-ink-dim">
                        Copy-to-send: {chan(m.channel)} has no send API here — paste it by hand, then mark it sent.
                      </span>
                    </div>
                  ) : (
                    <span className="text-[11px] text-ink-dim">—</span>
                  )}
                </div>
              )}
            </td>
          </tr>
        );
      })}
    </TableShell>
  );
}
