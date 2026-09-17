// lib/outreach/bridge.ts — the pure, DB-free brain of the Lean Outreach Bridge.
//
// The $0, no-ESP, no-subscription, no-auto-send loop. The OS drafts + approves +
// tracks; the team runs their existing FREE Gmail / Apps Script mail-merge to
// SEND; the merge's results re-import to close the loop. This module is the ONE
// home for the vocabulary and the pure logic the whole bridge agrees on — the
// delivery lifecycle, the suppression hard-filter, the merge-CSV shape, and the
// result-CSV parser — so the server actions, the export route and the UI can
// never drift on what a status means or which contact gets excluded.
//
// It is recipient-AGNOSTIC: every function speaks in terms of a RecipientType
// ('creator' | 'lead') and a plain contact shape, so the same engine serves both
// audiences (affiliate creators + client leads) with no branching duplicated.
//
// PURE: no DB, no network, no `Date.now()` — callers pass timestamps in. This
// keeps it unit-reasonable and safe to import from both server and client.

import type { UserRole } from "@/types/database";
import type { BadgeTone } from "@/components/ui";

// ── Recipient type ────────────────────────────────────────────────────────────
export type RecipientType = "creator" | "lead";

export function isRecipientType(v: string): v is RecipientType {
  return v === "creator" || v === "lead";
}

export const RECIPIENT_LABEL: Record<RecipientType, string> = {
  creator: "Creator",
  lead: "Lead",
};

// ── Delivery lifecycle (the Gmail-merge outcome, re-imported) ─────────────────
// DISTINCT from the workflow `status` column (draft/approved/ready_to_send/sent):
// `status` is the approval/send workflow; delivery_status tracks what the human
// merge actually DID, imported back from the result CSV.
//   draft → approved → exported → sent → opened → replied
//                                     ↘ bounced
//                                     ↘ opted_out
export const DELIVERY_STATUSES = [
  "draft",
  "approved",
  "exported",
  "sent",
  "opened",
  "replied",
  "bounced",
  "opted_out",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export function isDeliveryStatus(v: string): v is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(v);
}

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  exported: "Exported",
  sent: "Sent",
  opened: "Opened",
  replied: "Replied",
  bounced: "Bounced",
  opted_out: "Opted out",
};

export function deliveryStatusTone(status: string): BadgeTone {
  switch (status) {
    case "replied":
    case "opened":
    case "sent":
      return "teal";
    case "approved":
      return "violet";
    case "exported":
      return "amber";
    case "bounced":
    case "opted_out":
      return "red";
    default:
      return "muted"; // draft
  }
}

// A delivery_status that means "we should never contact this address again" — the
// recipient-agnostic hard stop (covers creators, which carry no do_not_contact
// column of their own).
export function isHardStopStatus(status: string | null | undefined): boolean {
  return status === "opted_out" || status === "bounced";
}

// ── Access gate (bizdev on Leads, partnerships on Affiliate — NOT all-org) ────
// Leadership (ceo/coo/department_head) always. A team_member is gated to the
// FUNCTION that owns the audience, keyed off users.team_assignment exactly like
// lib/auth/session.ts#isClientOwner: Business Development owns leads; the
// Partnerships / Affiliate team owns creators. This keeps the UI and the server
// actions agreeing on who may draft/approve/export/import.
export const BRIDGE_ROLES: UserRole[] = ["ceo", "coo", "department_head", "team_member"];

export function isOutreachLeadership(role: string): boolean {
  return role === "ceo" || role === "coo" || role === "department_head";
}

// The team_assignment substrings a member must carry to run the bridge for a
// given audience. Matched case-insensitively as a substring so "Business
// Development", "Partnerships", "Affiliate Partnerships" all resolve correctly.
const TEAM_MATCH: Record<RecipientType, string[]> = {
  lead: ["business development", "bizdev"],
  creator: ["partnership", "affiliate"],
};

export function canRunBridge(
  profile: { role: string; team_assignment?: string | null },
  recipientType: RecipientType
): boolean {
  if (isOutreachLeadership(profile.role)) return true;
  if (profile.role !== "team_member") return false;
  const team = (profile.team_assignment ?? "").trim().toLowerCase();
  if (!team) return false;
  return TEAM_MATCH[recipientType].some((m) => team.includes(m));
}

// ── Batch labelling ───────────────────────────────────────────────────────────
// A human-readable, sortable batch label stamped on every message in one export,
// e.g. "leads-2026-07-20-1435". The caller passes the timestamp (this module is
// pure). The label is what the results-import matches a returned row back to.
export function makeBatchLabel(recipientType: RecipientType, at: Date): string {
  const iso = at.toISOString(); // 2026-07-20T14:35:07.123Z
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16).replace(":", "");
  return `${recipientType}s-${date}-${time}`;
}

// ── Merge CSV (export) ────────────────────────────────────────────────────────
// The approved batch, ready to drop straight into the Gmail / Apps Script merge.
// Personalization is ALREADY RESOLVED in `body` (Vesper composed it per-contact
// from that contact's real fields), so the merge sends each row's body verbatim —
// there are no {{placeholders}} for the merge to fill. `subject` is split out of
// the body so the merge has a real subject line per recipient.
export interface MergeRow {
  name: string;
  email: string;
  subject: string;
  body: string;
}

export const MERGE_HEADERS = ["name", "email", "subject", "body"] as const;

// RFC-4180 cell: always quote, double embedded quotes — so a comma, newline or
// quote in a personalized body never shifts a column.
function csvCell(v: string): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

export function buildMergeCsv(rows: MergeRow[]): string {
  const lines = [MERGE_HEADERS.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([r.name, r.email, r.subject, r.body].map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

// ── Result CSV (import) ───────────────────────────────────────────────────────
// The Gmail-merge result sheet, exported back as CSV. We need only two columns:
// the recipient email and the per-row status the merge recorded. Header names are
// matched loosely (case-insensitive, trimmed) so a real exported sheet lines up
// without hand-editing.
export interface ParsedResult {
  email: string;
  outcome: ResultOutcome;
}

// The outcomes the loop understands, normalized from the many labels a merge
// sheet might use.
export type ResultOutcome = "sent" | "opened" | "replied" | "bounced" | "opted_out";

// Map a raw status cell to a canonical outcome, or null if unrecognized (the row
// is then reported as skipped — never guessed).
export function normalizeOutcome(raw: string): ResultOutcome | null {
  const s = raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!s) return null;
  if (/(^| )(reply|replied|responded|response)( |$)/.test(s)) return "replied";
  if (/(^| )(open|opened|read)( |$)/.test(s)) return "opened";
  if (/(unsub|opt out|opted out|opt-out|do not contact|dnc|remove)/.test(s)) return "opted_out";
  if (/(bounce|bounced|reject|rejected|undeliver|failed|invalid|hard bounce)/.test(s)) return "bounced";
  if (/(^| )(sent|delivered|ok|success)( |$)/.test(s)) return "sent";
  return null;
}

// Split one CSV line into fields, honoring quotes + escaped quotes + embedded
// commas. Good enough for a merge result sheet (no exotic dialects).
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const EMAIL_HEADERS = new Set(["email", "email address", "recipient", "to", "e-mail"]);
const STATUS_HEADERS = new Set(["status", "delivery status", "result", "outcome", "merge status"]);

export interface ParsedResultsCsv {
  rows: ParsedResult[];
  skipped: string[];
}

// Parse a merge result CSV into normalized {email, outcome} rows. Rows missing an
// email or carrying an unrecognized status are reported, never invented. The
// email is lower-cased for matching; the caller matches it against the batch.
export function parseResultsCsv(text: string): ParsedResultsCsv {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: [], skipped: ["The results file is empty."] };

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  let emailIdx = header.findIndex((h) => EMAIL_HEADERS.has(h));
  let statusIdx = header.findIndex((h) => STATUS_HEADERS.has(h));

  // A file with no recognizable header falls back to positional [email, status].
  let dataStart = 1;
  if (emailIdx < 0 && statusIdx < 0) {
    emailIdx = 0;
    statusIdx = 1;
    dataStart = 0;
  } else {
    if (emailIdx < 0) emailIdx = 0;
    if (statusIdx < 0) statusIdx = 1;
  }

  const rows: ParsedResult[] = [];
  const skipped: string[] = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const email = (cols[emailIdx] ?? "").trim().toLowerCase();
    const rawStatus = (cols[statusIdx] ?? "").trim();
    if (!email || !email.includes("@")) {
      skipped.push(`row ${i + 1}: missing email`);
      continue;
    }
    const outcome = normalizeOutcome(rawStatus);
    if (!outcome) {
      skipped.push(`row ${i + 1} (${email}): unrecognized status "${rawStatus || "—"}"`);
      continue;
    }
    rows.push({ email, outcome });
  }
  return { rows, skipped };
}

// ── Suppression (the pre-export HARD filter) ──────────────────────────────────
// A contact is excluded from an export when it has no email, is flagged
// do_not_contact / opted out, has already hard-stopped (a prior bounced/opted_out
// message — the recipient-agnostic backstop for creators), or its email domain
// matches an existing CLIENT (a brand primary-contact domain) — we never cold-
// pitch a live client. Every skip is logged so the operator sees exactly who and
// why; nothing is silently dropped.
export type SuppressReason = "no_email" | "do_not_contact" | "opted_out" | "client_domain";

export const SUPPRESS_REASON_LABEL: Record<SuppressReason, string> = {
  no_email: "No email on file",
  do_not_contact: "Marked do-not-contact",
  opted_out: "Opted out / prior bounce",
  client_domain: "Email domain is an existing client",
};

export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return null;
  const dom = (email ?? "").trim().toLowerCase().slice(at + 1);
  return dom || null;
}

// Build the set of client email domains from brand primary-contact emails.
export function clientDomainsFrom(emails: (string | null | undefined)[]): Set<string> {
  const set = new Set<string>();
  for (const e of emails) {
    const d = emailDomain(e);
    if (d) set.add(d);
  }
  return set;
}

export interface SuppressibleContact {
  email: string | null;
  // leads-only durable flags (undefined for creators)
  do_not_contact?: boolean | null;
  opted_out_at?: string | null;
  // recipient-agnostic backstop: a prior bounced/opted_out message exists
  priorHardStop?: boolean | null;
}

// The reason this contact must be excluded from an export, or null if clear.
export function suppressionReason(
  c: SuppressibleContact,
  clientDomains: Set<string>
): SuppressReason | null {
  if (c.do_not_contact) return "do_not_contact";
  if (c.opted_out_at) return "opted_out";
  if (c.priorHardStop) return "opted_out";
  const email = (c.email ?? "").trim();
  if (!email || !email.includes("@")) return "no_email";
  const dom = emailDomain(email);
  if (dom && clientDomains.has(dom)) return "client_domain";
  return null;
}

// ── Stored-body ⇄ subject helpers ─────────────────────────────────────────────
// An email draft is stored with its subject as a leading `Subject: …` line in the
// body (the same convention lib/affiliate/vesper-reach.ts#splitEmailBody uses),
// so the subject is visible + editable in the approval list and splits cleanly
// back out at export time.
export function composeStoredBody(subject: string | null, body: string): string {
  const s = (subject ?? "").trim();
  return s ? `Subject: ${s}\n\n${body.trim()}` : body.trim();
}

export function splitStoredBody(
  stored: string | null | undefined,
  fallbackSubject: string
): { subject: string; body: string } {
  const raw = (stored ?? "").trim();
  const m = raw.match(/^\s*subject:\s*(.+?)\r?\n\r?\n?([\s\S]*)$/i);
  if (m) {
    return { subject: m[1].trim() || fallbackSubject, body: m[2].trim() || raw };
  }
  return { subject: fallbackSubject, body: raw };
}
