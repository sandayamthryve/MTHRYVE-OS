// lib/webhooks/signature.ts — HMAC request-signing for the GitHub Actions → OS webhooks.
//
// PASTE 3.2 (Part A). The bearer secret proves "you hold the shared key"; the
// HMAC signature proves "this exact body was produced by the holder of the
// signing secret". Layering the two means a LEAKED bearer alone can no longer
// forge an opportunity / action_request — the attacker would also need the
// separate WEBHOOK_SIGNING_SECRET to sign a body the OS will accept.
//
// GitHub Actions signs the RAW request body (an GitHub Actions Crypto/HMAC node, algorithm SHA256,
// key = WEBHOOK_SIGNING_SECRET, encoding hex) and sends the digest in the
// `x-mthryve-signature` header. The OS recomputes the digest over the bytes it
// received and constant-time compares.

import { createHmac, timingSafeEqual } from "crypto";

// The header carrying the hex HMAC-SHA256 digest of the raw body. A bare hex
// digest or the common `sha256=<hex>` prefix are both accepted.
export const SIGNATURE_HEADER = "x-mthryve-signature";

// Lowercase hex HMAC-SHA256 of `body` under `secret`. Exposed so callers/tests
// (and the GitHub Actions node config) can reproduce exactly what the OS expects.
export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// Normalize an incoming signature header to a bare lowercase hex digest, or null
// when it's absent/blank.
function normalizeSignature(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutPrefix = /^sha256=(.+)$/i.exec(trimmed)?.[1] ?? trimmed;
  return withoutPrefix.trim().toLowerCase();
}

// Verify that `rawBody` was signed with WEBHOOK_SIGNING_SECRET.
//
// Fails CLOSED — a missing secret, or a missing / malformed / non-matching
// signature, is a REJECT. So an unsigned call (or a forged one made with a
// leaked bearer but no signing secret) can never pass. Mirrors the constant-time
// bearer check used across the automation routes.
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.WEBHOOK_SIGNING_SECRET?.trim();
  if (!secret) return false; // signing unconfigured → reject, never open the gate
  const provided = normalizeSignature(signatureHeader);
  if (!provided || !/^[0-9a-f]+$/.test(provided)) return false;
  const expected = signPayload(rawBody, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Convenience over a Headers-like carrier (e.g. NextRequest.headers).
export function verifyRequestSignature(
  headers: { get(name: string): string | null },
  rawBody: string
): boolean {
  return verifyWebhookSignature(rawBody, headers.get(SIGNATURE_HEADER));
}
