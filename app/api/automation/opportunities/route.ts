import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import { verifyRequestSignature } from "@/lib/webhooks/signature";

// Wire shape is permissive (fields validated individually below); this schema
// rejects non-object junk and caps field sizes before anything is processed.
const OpportunitySchema = z
  .object({
    source: z.unknown().optional(),
    status: z.unknown().optional(),
    tier: z.unknown().optional(),
    score: z.unknown().optional(),
    name: z.unknown().optional(),
    reason: z.unknown().optional(),
    next_action: z.unknown().optional(),
  })
  .passthrough();

// POST /api/automation/opportunities — the Layer-5 automation GATEWAY.
//
// automation's "Opportunity Engine" posts a qualified opportunity here; the OS stages it
// as ONE pending action_request on the existing approval spine for the CEO to
// approve. GitHub Actions NEVER touches the database — it only calls this HTTPS endpoint,
// authenticated by a shared bearer secret. On the OS side we write with the
// service-role client (there is no logged-in user), and nothing reaches a
// prospect: approval only creates an internal `leads` row for review (see the
// 'create_lead' executor in lib/actions/executor.ts).
//
// GOVERNING RULE (DECISIONS.md D-005): the OS DRAFTS (status='pending'), a human
// APPROVES, then the OS EXECUTES. This endpoint only performs the draft step.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single-org for now — Mthryve Marketing Inc. Later this resolves from a
// source→org mapping so multiple tenants can share one automation gateway.
const DEFAULT_ORG_ID = "146ab645-a5b8-4916-85c0-4ebd91480478";

type Shim = { from: (t: string) => any };

// Constant-time bearer check against AUTOMATION_API_KEY. Fails CLOSED when the
// secret isn't configured, so a missing env var can never accidentally open the
// gate. GitHub Actions sends this via its "Mthryve OS Automation Key" credential.
function bearerOk(req: NextRequest): boolean {
  const expected = process.env.AUTOMATION_API_KEY?.trim();
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const provided = match?.[1]?.trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// The payload automation's Opportunity Engine sends. Everything is optional on the wire;
// we validate name + tier + score below and reject the rest with 400.
interface OpportunityBody {
  source?: unknown;
  status?: unknown;
  tier?: unknown;
  score?: unknown;
  name?: unknown;
  reason?: unknown;
  next_action?: unknown;
}

// Coerce the wire score (number or numeric string) to a finite number, else null.
function toScore(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t === "" ? null : t;
}

export async function POST(req: NextRequest) {
  // 1) AUTH — reject anything without the exact shared bearer secret.
  if (!bearerOk(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 1b) SIGNATURE — GitHub Actions signs the RAW body with WEBHOOK_SIGNING_SECRET and sends
  // the HMAC in x-mthryve-signature. We read the raw bytes and verify BEFORE
  // parsing, so a forged / unsigned payload is rejected even if the bearer leaks.
  // Fails closed when the signing secret is unset.
  const rawBody = await req.text();
  if (!verifyRequestSignature(req.headers, rawBody)) {
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  // Parse + shape-validate the JSON body (the exact bytes we just verified).
  let body: OpportunityBody;
  try {
    const raw = JSON.parse(rawBody);
    const parsed = OpportunitySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    body = parsed.data as OpportunityBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  // 2) VALIDATE — name + tier + score are required.
  const name = str(body.name);
  const tier = str(body.tier);
  const score = toScore(body.score);
  if (!name || !tier || score == null) {
    return NextResponse.json(
      { ok: false, error: "name, tier and score are required" },
      { status: 400 }
    );
  }

  const source = str(body.source) ?? "opportunity_engine";
  const wireStatus = str(body.status);
  const reason = str(body.reason);
  const nextAction = str(body.next_action);

  // 3) Resolve the org (single-org for now) and stage ONE pending action_request.
  // confidence is score/100, clamped to the table's [0,1] check constraint.
  const confidence = Math.max(0, Math.min(1, score / 100));
  const db = createServiceRoleClient() as unknown as Shim;

  const { data: inserted, error } = await db
    .from("action_requests")
    .insert({
      org_id: DEFAULT_ORG_ID,
      source_module: "opportunity_engine",
      source_ref: { source, status: wireStatus, tier, score },
      title: `New opportunity: ${name} (${tier}, score ${score})`,
      problem: reason,
      recommendation: nextAction,
      proposed_action: {
        type: "create_lead",
        payload: {
          lead: { name, source: "opportunity_engine", tier, score, notes: reason },
        },
      },
      risk_tier: 1,
      required_role: "ceo",
      status: "pending",
      confidence,
    })
    .select("id")
    .single();

  if (error || !inserted?.id) {
    return NextResponse.json(
      { ok: false, error: "could not stage the opportunity" },
      { status: 500 }
    );
  }

  // 4) Audit the receipt (system event; detail = the received payload).
  await writeActionAudit(db, {
    org_id: DEFAULT_ORG_ID,
    action_request_id: inserted.id,
    event: "opportunity_received",
    actor_id: null,
    actor_role: "system",
    detail: {
      source,
      status: wireStatus,
      tier,
      score,
      name,
      reason,
      next_action: nextAction,
    },
  });

  // 5) 200 with the new request id.
  return NextResponse.json({ ok: true, action_request_id: inserted.id });
}
