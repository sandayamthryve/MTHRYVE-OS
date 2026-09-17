// lib/outreach/email.ts — the EMAIL channel for Vesper's gated outreach. The
// single place the OS turns an approved 'send_outreach' (channel='email') into a
// real sent email. It is SERVER-ONLY — never import it into a "use client"
// component; the credentials must never reach the browser.
//
// Two transports, chosen by env (read at CALL TIME, never module load, so Vercel
// "Sensitive" runtime vars are seen fresh per request and nothing is captured
// into a build artifact):
//
//   • SMTP           — set SMTP_HOST (+ SMTP_PORT / SMTP_USER / SMTP_PASS /
//                      SMTP_SECURE) and a from address (EMAIL_FROM or SMTP_FROM).
//                      Sent with nodemailer.
//   • Provider API   — set EMAIL_API_KEY and EMAIL_FROM. Defaults to Resend
//                      (https://api.resend.com/emails); override the endpoint
//                      with EMAIL_API_URL for a Resend-compatible provider. Sent
//                      over HTTPS with fetch (no SDK), matching every other
//                      integration client in this repo.
//
// If NEITHER is configured, sendEmail throws EmailNotConfiguredError. The executor
// surfaces that as an honest 'email not configured' failure — it NEVER fakes a
// send and NEVER logs an activity for a mail that didn't go out. This mirrors how
// knowledge ingestion surfaces its own not-configured state
// (lib/knowledge/embed.ts → EmbeddingError('not-configured')).

const RESEND_DEFAULT_URL = "https://api.resend.com/emails";

// ── Config detection ──────────────────────────────────────────────────────────

function env(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

// The verified sender. SMTP_FROM is accepted as an alias so an SMTP-only setup
// needn't also set EMAIL_FROM.
function fromAddress(): string | undefined {
  return env("EMAIL_FROM") ?? env("SMTP_FROM");
}

export type EmailTransport = "smtp" | "provider";

// Which transport (if any) is configured, plus a short, non-secret label for the
// UI/diag. SMTP wins when both are set (an explicit host is the stronger signal).
export interface EmailConfig {
  configured: boolean;
  transport: EmailTransport | null;
  from: string | null;
  // A short, safe descriptor e.g. "SMTP · smtp.example.com" or "Resend API".
  detail: string | null;
}

export function emailConfig(): EmailConfig {
  const from = fromAddress() ?? null;
  const smtpHost = env("SMTP_HOST");
  const apiKey = env("EMAIL_API_KEY");

  // SMTP needs a host and a from address to be usable.
  if (smtpHost && from) {
    return {
      configured: true,
      transport: "smtp",
      from,
      detail: `SMTP · ${smtpHost}`,
    };
  }
  // Provider API needs a key and a from address.
  if (apiKey && from) {
    const url = env("EMAIL_API_URL") ?? RESEND_DEFAULT_URL;
    const host = safeHost(url);
    return {
      configured: true,
      transport: "provider",
      from,
      detail: host ? `Email API · ${host}` : "Email API",
    };
  }

  // Not usable yet. Say which piece is missing without leaking anything secret.
  const missing: string[] = [];
  if (!from) missing.push("EMAIL_FROM");
  if (!smtpHost && !apiKey) missing.push("SMTP_HOST or EMAIL_API_KEY");
  return {
    configured: false,
    transport: null,
    from,
    detail: missing.length ? `Missing ${missing.join(" + ")}` : null,
  };
}

// True only when a usable transport is configured. The UI uses this to warn
// before drafting an email, and the executor uses it to fail cleanly.
export function isEmailConfigured(): boolean {
  return emailConfig().configured;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

// Thrown when email can't be sent because nothing is configured. Distinct type
// so the executor can render the honest "email not configured" state rather than
// a generic failure.
export class EmailNotConfiguredError extends Error {
  constructor(message = "Email is not configured — set SMTP_* or EMAIL_* env vars. Nothing was sent.") {
    super(message);
    this.name = "EmailNotConfiguredError";
  }
}

export function isEmailNotConfigured(e: unknown): boolean {
  return e instanceof EmailNotConfiguredError;
}

// ── Send ──────────────────────────────────────────────────────────────────────

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
}

export interface SendEmailResult {
  transport: EmailTransport;
  // A provider/message id when the transport returns one; null otherwise.
  messageId: string | null;
}

// Send one email. Throws EmailNotConfiguredError when no transport is set up, or
// a plain Error carrying a short reason when the send itself fails. Never fakes
// success.
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const cfg = emailConfig();
  if (!cfg.configured || !cfg.transport || !cfg.from) {
    throw new EmailNotConfiguredError();
  }
  const to = input.to.trim();
  if (!to) throw new Error("No recipient email address.");

  if (cfg.transport === "smtp") {
    return sendViaSmtp({ ...input, to }, cfg.from);
  }
  return sendViaProvider({ ...input, to }, cfg.from);
}

// SMTP via nodemailer. Imported dynamically so the module only loads when SMTP is
// actually used (and so a provider-only deploy never pays for it).
async function sendViaSmtp(input: SendEmailInput, from: string): Promise<SendEmailResult> {
  const host = env("SMTP_HOST")!;
  const port = Number(env("SMTP_PORT") ?? "587") || 587;
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  // SMTP_SECURE=true forces implicit TLS (port 465); otherwise STARTTLS is used.
  const secure = (env("SMTP_SECURE") ?? "").toLowerCase() === "true" || port === 465;

  let nodemailer: typeof import("nodemailer");
  try {
    nodemailer = await import("nodemailer");
  } catch {
    throw new Error("SMTP transport unavailable (nodemailer not installed).");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });

  try {
    const info = await transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      replyTo: input.replyTo ?? undefined,
    });
    return { transport: "smtp", messageId: (info?.messageId as string | undefined) ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[outreach/email] SMTP send failed", msg);
    throw new Error(`SMTP send failed: ${msg.slice(0, 200)}`);
  }
}

// Provider HTTP API (Resend by default; any Resend-compatible endpoint via
// EMAIL_API_URL). Bearer-auth JSON POST. No SDK — fetch only, matching the repo's
// other integration clients.
async function sendViaProvider(input: SendEmailInput, from: string): Promise<SendEmailResult> {
  const key = env("EMAIL_API_KEY")!;
  const url = env("EMAIL_API_URL") ?? RESEND_DEFAULT_URL;

  const body: Record<string, unknown> = {
    from,
    to: [input.to],
    subject: input.subject,
    text: input.text,
  };
  if (input.replyTo) body.reply_to = input.replyTo;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    console.error("[outreach/email] provider fetch threw", e);
    throw new Error("Could not reach the email provider.");
  }

  const rawText = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[outreach/email] provider rejected", res.status, rawText.slice(0, 300));
    throw new Error(`Email provider returned ${res.status}.`);
  }

  // Resend returns { id }; other providers vary — parse defensively, and never
  // fail a genuinely-sent email just because the id shape drifted.
  let messageId: string | null = null;
  try {
    const json = JSON.parse(rawText) as { id?: string; messageId?: string } | null;
    messageId = json?.id ?? json?.messageId ?? null;
  } catch {
    messageId = null;
  }
  return { transport: "provider", messageId };
}
