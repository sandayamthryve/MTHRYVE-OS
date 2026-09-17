// lib/security/output-filter.ts — outbound secret / PII leak filter (PASTE 4.3
// Part C).
//
// The last line of defense before an agent's answer reaches the user or is
// persisted: scan the generated text for anything that looks like a leaked
// secret (API keys, service-role JWTs, connection strings, private keys) or
// high-sensitivity PII (payment-card numbers), and REDACT it. A model that is
// tricked into echoing a key — or that stumbles onto one in tool output — must
// never hand it back in plain text.
//
// Design choices to avoid breaking legitimate answers:
//   • SECRETS are matched with high-precision patterns (real key shapes), so a
//     normal business sentence won't trip them.
//   • PII is intentionally NARROW — only payment-card numbers (Luhn-validated).
//     Emails and phone numbers are legitimate, everyday business data in this OS
//     (leads, creators, suppliers), so we do NOT redact them here; that would
//     gut the assistant's usefulness and isn't what "leaked secret/PII" means.
//
// Pure string ops, edge-safe, dependency-free.

export type LeakKind = "secret" | "pii";

export interface LeakFinding {
  kind: LeakKind;
  label: string;
  /** A short, non-sensitive preview (never the full value). */
  preview: string;
}

interface Rule {
  kind: LeakKind;
  label: string;
  re: RegExp;
  /** Optional extra validation (e.g. Luhn for cards) before it counts. */
  validate?: (match: string) => boolean;
}

// High-precision secret shapes. Each is specific enough that ordinary prose does
// not match. `g` flag so replace() catches every occurrence.
const RULES: Rule[] = [
  { kind: "secret", label: "anthropic-api-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "secret", label: "openai-api-key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "secret", label: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "secret", label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "secret", label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "secret", label: "telegram-bot-token", re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  { kind: "secret", label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "secret", label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "secret", label: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { kind: "secret", label: "postgres-connection-string", re: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi },
  { kind: "secret", label: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  {
    kind: "pii",
    label: "payment-card",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    validate: luhnValid,
  },
];

const REDACTION: Record<LeakKind, string> = {
  secret: "[REDACTED: secret withheld]",
  pii: "[REDACTED: sensitive number withheld]",
};

// Luhn check so a random 16-digit order/SKU number isn't mistaken for a card.
function luhnValid(raw: string): boolean {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function preview(match: string): string {
  const trimmed = match.trim();
  const head = trimmed.slice(0, 4);
  return `${head}…(${trimmed.length} chars)`;
}

export interface FilterResult {
  /** True when nothing sensitive was found. */
  safe: boolean;
  /** The text with any secrets / sensitive numbers replaced by a redaction tag. */
  text: string;
  findings: LeakFinding[];
}

/**
 * Scan + redact. Returns the (possibly redacted) text, a safe flag, and the list
 * of findings (label + non-sensitive preview only). Never throws.
 */
export function filterOutput(input: unknown): FilterResult {
  if (typeof input !== "string" || !input) {
    return { safe: true, text: typeof input === "string" ? input : "", findings: [] };
  }
  let text = input;
  const findings: LeakFinding[] = [];

  for (const rule of RULES) {
    text = text.replace(rule.re, (m) => {
      if (rule.validate && !rule.validate(m)) return m; // not a real hit — leave it
      findings.push({ kind: rule.kind, label: rule.label, preview: preview(m) });
      return REDACTION[rule.kind];
    });
  }

  return { safe: findings.length === 0, text, findings };
}

/** Convenience: just the redacted text. */
export function redactOutput(input: string): string {
  return filterOutput(input).text;
}

// The message substituted when a whole response has to be withheld (rare — we
// prefer surgical redaction so the rest of the answer survives).
export const OUTPUT_BLOCKED_MESSAGE =
  "I stopped that response because it contained something that looked like a secret or sensitive credential. If you need a value like that, retrieve it through the proper secured channel — I won't repeat it here.";
