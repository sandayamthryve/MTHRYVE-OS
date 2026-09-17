// Route-handler hardening helpers (PASTE 2.4 — Part D).
//
// One place to (a) schema-validate a JSON payload with zod and reject junk
// before it can reach the database, and (b) turn any thrown error into a generic
// client response while the real detail is logged server-side. No stack trace,
// upstream provider message, or raw Postgres error ever reaches the client.

import { NextResponse } from "next/server";
import type { ZodType } from "zod";

export type ParsedBody<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/**
 * Read + zod-validate a JSON request body. On malformed JSON or a schema
 * mismatch, returns a ready-to-send generic 400 (`ok: false`); the specific
 * validation issues are logged server-side only.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  context = "api"
): Promise<ParsedBody<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid request body." }, { status: 400 }),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Log the field-level detail for debugging; never return it to the client.
    console.warn(`[${context}] payload validation failed`, parsed.error.flatten());
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid request payload." }, { status: 400 }),
    };
  }

  return { ok: true, data: parsed.data };
}

/** Validate an already-parsed value (e.g. searchParams object) against a schema. */
export function validate<T>(
  schema: ZodType<T>,
  value: unknown,
  context = "api"
): ParsedBody<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    console.warn(`[${context}] validation failed`, parsed.error.flatten());
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid request." }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Log an error server-side and return a generic response. Use in `catch` blocks
 * that would otherwise leak `error.message` / a stack trace to the client.
 */
export function serverError(
  context: string,
  error: unknown,
  status = 500,
  clientMessage = "Something went wrong. Please try again."
): NextResponse {
  console.error(`[${context}]`, error);
  return NextResponse.json({ error: clientMessage }, { status });
}
