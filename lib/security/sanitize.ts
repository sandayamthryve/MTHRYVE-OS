// Shared input/output sanitization helpers (PASTE 2.4 — Part A).
//
// This app never renders user content through `dangerouslySetInnerHTML`, so
// stored-HTML XSS is not possible — React escapes every text node it renders.
// The real, exploitable surface is:
//   1. user-supplied URLs rendered into `<a href={...}>` — a `javascript:` /
//      `data:` / `vbscript:` URL there executes on click.
//   2. junk (control chars, stray markup) persisted verbatim into text columns.
//
// These helpers are edge-safe (pure string ops, no DOM, no Node APIs) so they
// can be used in middleware, route handlers, server components, and client
// components alike.

// Protocols we will ever emit into an href/src. Everything else — most
// importantly `javascript:`, `data:`, `vbscript:`, `file:` — is rejected.
const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * Returns a safe URL string for use in `href`/`src`, or `null` if the value is
 * missing or uses a disallowed scheme. Same-origin relative paths ("/foo",
 * "./foo", "#anchor") are allowed. Anything that parses to a non-http(s)/mailto
 * scheme (e.g. `javascript:alert(1)`) is rejected.
 *
 * Render pattern:  {safeUrl(u) ? <a href={safeUrl(u)!}>…</a> : <span>{u}</span>}
 */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Reject control characters outright — they can be used to smuggle a
  // `java\nscript:` scheme past a naïve prefix check.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return null;

  // Relative / same-document references are safe (no scheme to abuse).
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("?")
  ) {
    // A protocol-relative URL ("//evil.com") is NOT a safe relative path.
    if (trimmed.startsWith("//")) return null;
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (!SAFE_URL_PROTOCOLS.has(url.protocol.toLowerCase())) return null;
    return url.toString();
  } catch {
    // Not an absolute URL and not a recognised relative form → reject.
    return null;
  }
}

/**
 * Strip HTML/script markup and control characters from a free-text value, then
 * trim and optionally clamp its length. Use on WRITE (before persisting notes,
 * captions, remarks, report text) so junk never reaches the database. React
 * already escapes on render; this is defense-in-depth against stored payloads.
 *
 * Not an HTML allow-list sanitizer — this app stores/renders plain text only, so
 * we remove tags entirely rather than permit a subset.
 */
export function sanitizeText(value: unknown, maxLength = 10_000): string {
  if (typeof value !== "string") return "";
  let out = value;

  // Drop <script>/<style> blocks along with their contents.
  out = out.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Remove any remaining tags (e.g. <img onerror=…>, <svg>, stray <b>).
  out = out.replace(/<\/?[a-z][\s\S]*?>/gi, "");
  // Neutralise control characters except tab (\t), newline (\n), carriage
  // return (\r), and DEL.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  out = out.trim();
  if (out.length > maxLength) out = out.slice(0, maxLength);
  return out;
}

/**
 * Like {@link sanitizeText} but preserves `null`/empty as `null` — convenient
 * for optional text columns (a cleared note should store NULL, not "").
 */
export function sanitizeNullableText(value: unknown, maxLength = 10_000): string | null {
  if (value == null) return null;
  const cleaned = sanitizeText(value, maxLength);
  return cleaned === "" ? null : cleaned;
}
