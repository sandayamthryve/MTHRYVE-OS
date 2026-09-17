// lib/outreach/channels.ts — the outreach CHANNEL vocabulary for Vesper's gated
// reach tools (V2). One home so the draft-builder, the executor, and the UI all
// agree on which channels exist and, crucially, which ones the OS may ever SEND
// on automatically.
//
// GOVERNING RULE (mirrors DECISIONS.md D-005): Vesper DRAFTS, a human APPROVES,
// then the OS acts. Only ONE channel is ever machine-sent — email, and only when
// an email provider is configured (see lib/outreach/email.ts). Viber and DM
// (comment/reply) are copy-paste ONLY: Vesper writes the message, the human
// copies it and sends it by hand. Viber automation would breach Viber's ToS, and
// no platform messaging API is wired for comment/DM replies — so neither is ever
// auto-sent. This constant is the single source of truth for that rule.

// Dependency-free so both the server (executor, producer) and the client
// (panels, cards) can import it.

export type OutreachChannel = "email" | "viber" | "dm";

export const OUTREACH_CHANNELS: OutreachChannel[] = ["email", "viber", "dm"];

export const CHANNEL_LABEL: Record<OutreachChannel, string> = {
  email: "Email",
  viber: "Viber",
  dm: "Comment / DM reply",
};

// A one-line note on HOW a channel is delivered — shown in the UI so the human
// always knows whether approving will send, or only log a message they sent by
// hand.
export const CHANNEL_DELIVERY_NOTE: Record<OutreachChannel, string> = {
  email:
    "Sent by the OS on approval — only if an email provider is configured, otherwise blocked with an honest error (never a faked send).",
  viber:
    "Copy-paste only. Vesper drafts it; you send it in Viber by hand (Viber ToS forbids automated sending). Approving just logs the touch.",
  dm:
    "Copy-paste only. No platform messaging API is connected, so Vesper drafts the reply and you paste it yourself. Approving just logs the touch.",
};

// The ONE channel the OS is allowed to send on its own (after approval). Every
// other channel is copy-paste and is only ever logged as a manual touch.
export function isAutoSendChannel(channel: OutreachChannel): boolean {
  return channel === "email";
}

export function isOutreachChannel(v: unknown): v is OutreachChannel {
  return v === "email" || v === "viber" || v === "dm";
}

// Which outreach_activities.activity_type a channel logs as. The table's enum has
// no 'viber'/'dm' member and we add NO schema, so Viber and DM both log as the
// generic 'message' type; the channel is preserved in the note prefix (see
// channelNotePrefix) so the timeline still reads honestly.
export function activityTypeForChannel(channel: OutreachChannel): "email" | "message" {
  return channel === "email" ? "email" : "message";
}

// A short, human-readable prefix stamped on the logged note so a Viber/DM touch
// is distinguishable in the timeline without a dedicated column. Email needs no
// prefix (its activity_type already says 'email').
export function channelNotePrefix(channel: OutreachChannel): string {
  switch (channel) {
    case "viber":
      return "[Viber · sent by hand] ";
    case "dm":
      return "[Comment/DM reply · sent by hand] ";
    default:
      return "";
  }
}
