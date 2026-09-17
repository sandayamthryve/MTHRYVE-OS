import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeAudit } from "@/lib/audit/log";

// POST /api/automation/leads-ingest — the MCP-independent automation WRITE path
// for the autonomous growth / creator-sourcing engines.
//
// The engines run headless (GitHub Actions / cron) and can't reliably write through Claude
// MCP, so they post a batch of qualified leads and/or prospect creators HERE with
// only the shared "Mthryve OS Automation Key" bearer — the SAME pattern as the
// Daily Tap and Sync-Health gateways. GitHub Actions never touches the database; on the OS
// side we insert with the service-role client (there is no logged-in user) and
// the middleware isPublicRoute allowlist already exempts /api/automation/*.
//
// GUARDRAILS:
//   • 401 on a missing / wrong bearer (fails CLOSED when the secret is unset).
//   • 400 — never a 500 — on a bad shape or a bad enum (department / platform).
//   • Idempotent: every candidate is deduped server-side BEFORE insert, against
//     the live tables AND within the batch, so a re-POST inserts nothing new.
//   • Service-role ONLY for the insert; no RLS is weakened anywhere else.
//   • One audit_log row per batch (the counts), written service-role/unforgeable.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Shim = { from: (t: string) => any };

// The columns the engines are allowed to set. stage / status are FORCED below
// (never taken from the wire) so an automation write can only ever create a fresh
// 'new' lead / 'prospect' creator.
const LEAD_DEPARTMENTS = ["Business Development", "Partnerships"] as const;
const CREATOR_PLATFORMS = ["tiktok", "shopee", "instagram", "facebook", "youtube", "other"] as const;

// Constant-time bearer check against AUTOMATION_API_KEY. Fails CLOSED when the
// secret isn't configured, so a missing env var can never open the gate. Mirrors
// the Daily Tap / Sync-Health / opportunities gateways exactly.
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

// Trim → non-empty string, else null. Honest nulls: a blank cell becomes SQL NULL
// (or the column default), never a fabricated "" / 0.
function str(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t === "" ? null : t;
}

// Coerce a wire number (number or numeric string) to a finite number, else null.
function num(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function intOrNull(raw: unknown): number | null {
  const n = num(raw);
  return n == null ? null : Math.trunc(n);
}

// Case- and whitespace-folded key for dedup, matching the creators email/handle
// unique indexes (lower(btrim(...))). Null for a blank value so a missing field
// never collides on emptiness. Phone uses str() directly (see below): its index
// is btrim(phone) — trimmed but NOT case-folded — so a phone key must be
// trim-only, never lowercased, to match the index exactly.
function key(raw: unknown): string | null {
  const s = str(raw);
  return s == null ? null : s.toLowerCase();
}

// Wire shape: an object with an org_id and optional leads / creators arrays.
// Field-level validation (enums, required name) happens after parse so we can
// return a precise 400 reason rather than a generic zod dump.
const BodySchema = z
  .object({
    org_id: z.string().uuid(),
    leads: z.array(z.record(z.string(), z.unknown())).optional(),
    creators: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

interface PreparedLead {
  row: Record<string, unknown>;
  emailKey: string | null;
  companyKey: string | null;
  label: string;
}
interface PreparedCreator {
  row: Record<string, unknown>;
  emailKey: string | null;
  phoneKey: string | null;
  nameKey: string | null;
  handleKey: string | null; // `${platform}:${lower(handle)}`
  label: string;
}

export async function POST(req: NextRequest) {
  // 1) AUTH — reject anything without the exact shared bearer secret.
  if (!bearerOk(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // 2) PARSE + shape-validate. Bad JSON or a missing/invalid org_id is a 400.
  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "invalid payload: org_id (uuid) required; leads/creators must be arrays" },
        { status: 400 }
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const orgId = body.org_id;
  const leadsIn = body.leads ?? [];
  const creatorsIn = body.creators ?? [];
  if (leadsIn.length === 0 && creatorsIn.length === 0) {
    return NextResponse.json(
      { ok: false, error: "nothing to ingest: provide at least one lead or creator" },
      { status: 400 }
    );
  }

  // 3) VALIDATE each item's enums / required fields. ANY bad value fails the whole
  // batch with a 400 (never a partial insert, never a 500). Enums are checked
  // BEFORE any DB call so a bad department / platform can't reach an insert.
  const prepLeads: PreparedLead[] = [];
  for (let i = 0; i < leadsIn.length; i++) {
    const l = leadsIn[i]!;
    const name = str(l.name);
    if (!name) {
      return NextResponse.json({ ok: false, error: `leads[${i}]: name is required` }, { status: 400 });
    }
    const department = str(l.department);
    if (department != null && !LEAD_DEPARTMENTS.includes(department as (typeof LEAD_DEPARTMENTS)[number])) {
      return NextResponse.json(
        { ok: false, error: `leads[${i}]: department must be one of ${LEAD_DEPARTMENTS.join(", ")}` },
        { status: 400 }
      );
    }
    const company = str(l.company);
    const email = str(l.email);
    // Only non-null values become columns, so a blank field takes the table
    // default (stage='new') or SQL NULL — never a fabricated value. stage is
    // FORCED to 'new'; created_by / owner_id stay null (automation, no user).
    const row: Record<string, unknown> = {
      org_id: orgId,
      name,
      stage: "new",
    };
    if (company != null) row.company = company;
    if (email != null) row.email = email;
    const phone = str(l.phone);
    if (phone != null) row.phone = phone;
    const source = str(l.source) ?? "automation";
    row.source = source;
    if (department != null) row.department = department;
    const value = num(l.value);
    if (value != null) row.value = value;
    const notes = str(l.notes);
    if (notes != null) row.notes = notes;

    prepLeads.push({
      row,
      emailKey: key(email),
      companyKey: key(company),
      label: name,
    });
  }

  const prepCreators: PreparedCreator[] = [];
  for (let i = 0; i < creatorsIn.length; i++) {
    const c = creatorsIn[i]!;
    const name = str(c.name);
    if (!name) {
      return NextResponse.json({ ok: false, error: `creators[${i}]: name is required` }, { status: 400 });
    }
    // platform defaults to 'tiktok' (the column default) when omitted; a provided
    // value MUST be in the enum, else 400.
    const platform = str(c.platform) ?? "tiktok";
    if (!CREATOR_PLATFORMS.includes(platform as (typeof CREATOR_PLATFORMS)[number])) {
      return NextResponse.json(
        { ok: false, error: `creators[${i}]: platform must be one of ${CREATOR_PLATFORMS.join(", ")}` },
        { status: 400 }
      );
    }
    const email = str(c.email);
    const phone = str(c.phone);
    const handle = str(c.handle);
    const row: Record<string, unknown> = {
      org_id: orgId,
      name,
      platform,
      status: "prospect", // FORCED — an automation write can only create a prospect.
    };
    if (handle != null) row.handle = handle;
    if (email != null) row.email = email;
    if (phone != null) row.phone = phone;
    const category = str(c.category);
    if (category != null) row.category = category;
    const followers = intOrNull(c.follower_count);
    if (followers != null) row.follower_count = followers;
    const viber = str(c.viber);
    if (viber != null) row.viber = viber;
    const tier = str(c.tier);
    if (tier != null) row.tier = tier;
    const gmv = num(c.attributed_gmv);
    if (gmv != null) row.attributed_gmv = gmv;
    const posts = intOrNull(c.posts_committed);
    if (posts != null) row.posts_committed = posts;
    const notes = str(c.notes);
    if (notes != null) row.notes = notes;

    prepCreators.push({
      row,
      emailKey: key(email), // lower(btrim(email)) — matches creators_org_email_uniq
      phoneKey: phone, // btrim(phone) only, case-SENSITIVE — matches creators_org_phone_uniq (phone is already str()-trimmed)
      nameKey: key(name),
      handleKey: handle != null ? `${platform}:${key(handle)}` : null, // lower(btrim(handle)) per platform — matches creators_org_handle_uniq
      label: name,
    });
  }

  const db = createServiceRoleClient() as unknown as Shim;

  // 3b) Confirm the org exists BEFORE any insert, so an unknown org_id returns a
  // clean 400 instead of an FK-violation 500 at insert time.
  {
    const { data: org, error } = await db
      .from("organizations")
      .select("id")
      .eq("id", orgId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ ok: false, error: "could not verify org" }, { status: 500 });
    }
    if (!org) {
      return NextResponse.json({ ok: false, error: "unknown org_id" }, { status: 400 });
    }
  }

  // 4) LOAD the dedup universe (org-scoped) once. A lead is a duplicate if its
  // company/email already exists in leads, OR its company matches a brand (client)
  // name / a creator name, OR its email matches a creator email. A creator is a
  // duplicate if its handle (per platform), name, email or phone already exists in
  // creators (the last two also guard the unique indexes so a re-POST can't 500).
  const leadEmails = new Set<string>();
  const leadCompanies = new Set<string>();
  const brandNames = new Set<string>();
  const creatorNames = new Set<string>();
  const creatorEmails = new Set<string>();
  const creatorPhones = new Set<string>();
  const creatorHandleKeys = new Set<string>();

  {
    const [leadsRes, brandsRes, creatorsRes] = await Promise.all([
      db.from("leads").select("company, email").eq("org_id", orgId),
      db.from("brands").select("name").eq("org_id", orgId),
      db.from("creators").select("name, email, phone, handle, platform").eq("org_id", orgId),
    ]);
    if (leadsRes.error || brandsRes.error || creatorsRes.error) {
      return NextResponse.json({ ok: false, error: "could not read existing records" }, { status: 500 });
    }
    for (const r of (leadsRes.data ?? []) as Array<{ company: string | null; email: string | null }>) {
      const c = key(r.company);
      if (c) leadCompanies.add(c);
      const e = key(r.email);
      if (e) leadEmails.add(e);
    }
    for (const r of (brandsRes.data ?? []) as Array<{ name: string | null }>) {
      const n = key(r.name);
      if (n) brandNames.add(n);
    }
    for (const r of (creatorsRes.data ?? []) as Array<{
      name: string | null;
      email: string | null;
      phone: string | null;
      handle: string | null;
      platform: string | null;
    }>) {
      const n = key(r.name);
      if (n) creatorNames.add(n);
      const e = key(r.email);
      if (e) creatorEmails.add(e);
      const p = str(r.phone); // trim-only, case-sensitive — matches creators_org_phone_uniq
      if (p) creatorPhones.add(p);
      const h = key(r.handle);
      if (h) creatorHandleKeys.add(`${(r.platform ?? "tiktok").trim().toLowerCase() || "tiktok"}:${h}`);
    }
  }

  const reasons: string[] = [];

  // 5) DEDUP leads — against the live tables AND earlier rows in THIS batch, so a
  // batch that repeats a lead inserts it only once.
  const leadRows: Record<string, unknown>[] = [];
  let leadsSkipped = 0;
  for (const l of prepLeads) {
    let skip: string | null = null;
    if (l.emailKey && (leadEmails.has(l.emailKey) || creatorEmails.has(l.emailKey))) {
      skip = "email already exists";
    } else if (
      l.companyKey &&
      (leadCompanies.has(l.companyKey) || brandNames.has(l.companyKey) || creatorNames.has(l.companyKey))
    ) {
      skip = "company matches an existing lead, client or creator";
    }
    if (skip) {
      leadsSkipped++;
      reasons.push(`lead "${l.label}" skipped: ${skip}`);
      continue;
    }
    leadRows.push(l.row);
    // Reserve this identity so a later duplicate in the same batch is skipped.
    if (l.emailKey) leadEmails.add(l.emailKey);
    if (l.companyKey) leadCompanies.add(l.companyKey);
  }

  // 6) DEDUP creators — handle (per platform), name, email and phone, all on the
  // NORMALIZED keys so case/whitespace variants (Bob@x.com vs "bob@x.com ")
  // collapse to one, matching the DB unique indexes. This is the app-layer skip;
  // the row-by-row insert below is the DB-layer backstop for anything that slips
  // through (a concurrent write, or a pre-existing normalized variant we didn't
  // read here).
  const creatorSurvivors: PreparedCreator[] = [];
  let creatorsSkipped = 0;
  for (const c of prepCreators) {
    let skip: string | null = null;
    if (c.emailKey && creatorEmails.has(c.emailKey)) {
      skip = "email already exists";
    } else if (c.handleKey && creatorHandleKeys.has(c.handleKey)) {
      skip = "handle already exists on this platform";
    } else if (c.phoneKey && creatorPhones.has(c.phoneKey)) {
      skip = "phone already exists";
    } else if (c.nameKey && creatorNames.has(c.nameKey)) {
      skip = "name already exists";
    }
    if (skip) {
      creatorsSkipped++;
      reasons.push(`creator "${c.label}" skipped: ${skip}`);
      continue;
    }
    creatorSurvivors.push(c);
    // Reserve this identity so a later duplicate in the same batch is skipped.
    if (c.emailKey) creatorEmails.add(c.emailKey);
    if (c.handleKey) creatorHandleKeys.add(c.handleKey);
    if (c.phoneKey) creatorPhones.add(c.phoneKey);
    if (c.nameKey) creatorNames.add(c.nameKey);
  }

  // 7) INSERT the survivors (service-role, RLS bypassed — there is no user).
  let leadsInserted = 0;
  let creatorsInserted = 0;
  if (leadRows.length > 0) {
    // Leads have no unique index, so a bulk insert is safe and cheapest.
    const { data, error } = await db.from("leads").insert(leadRows).select("id");
    if (error) {
      return NextResponse.json({ ok: false, error: `leads insert failed: ${error.message}` }, { status: 500 });
    }
    leadsInserted = ((data ?? []) as unknown[]).length;
  }

  // Creators are inserted ONE ROW AT A TIME so a single unique-index collision
  // (23505 on any of the email / phone / handle indexes) becomes a clean skip
  // instead of failing the whole batch — the difference between the engine
  // writing N-1 rows and writing 0. supabase-js returns the error in the result
  // (it does not throw), so we branch on error.code.
  for (const c of creatorSurvivors) {
    const { error } = await db.from("creators").insert(c.row).select("id").single();
    if (!error) {
      creatorsInserted++;
      continue;
    }
    if ((error as { code?: string }).code === "23505") {
      creatorsSkipped++;
      reasons.push(`creator "${c.label}" skipped: already exists (unique constraint)`);
      continue;
    }
    return NextResponse.json(
      { ok: false, error: `creators insert failed: ${error.message}` },
      { status: 500 }
    );
  }

  // 8) AUDIT — one row per ingest batch (the counts). Best-effort, unforgeable
  // (service-role), never blocks the response.
  await writeAudit({
    orgId,
    action: "automation_leads_ingest",
    entityType: "automation_batch",
    actorUserId: null,
    actorRole: "system",
    detail: {
      leads_received: leadsIn.length,
      creators_received: creatorsIn.length,
      leads_inserted: leadsInserted,
      leads_skipped: leadsSkipped,
      creators_inserted: creatorsInserted,
      creators_skipped: creatorsSkipped,
    },
  });

  // 9) 200 with the reconciled counts + human-readable skip reasons.
  return NextResponse.json({
    ok: true,
    leads_inserted: leadsInserted,
    leads_skipped: leadsSkipped,
    creators_inserted: creatorsInserted,
    creators_skipped: creatorsSkipped,
    reasons,
  });
}
