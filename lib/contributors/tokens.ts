// lib/contributors/tokens.ts — the server-only contributor-token contract.
//
// A contributor (a live-selling HOST or an INTERN) has no OS login. They act
// through a single unguessable token embedded in a public link (/host/<token>).
// Every write the public page makes is re-validated HERE, server-side, against
// the token — the contributor_id and brand_id are ALWAYS derived from the token,
// never trusted from the client. The three contributor tables have RLS that only
// leadership / assigned moderators can reach, so the token path necessarily runs
// through the service-role client (it BYPASSES RLS): this module is the single
// choke-point that keeps that power scoped to "the contributor this token names".
//
// Kept server-only (imports the service-role client). Never import into a
// "use client" component.

import { randomBytes } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { manilaToday } from "@/lib/hr/time";
import type { SnapSchema } from "@/lib/snapfill/schema";

// Snap-to-Data is whitelisted to Live-Ops keys ONLY (viewers / gmv / ctor). The
// vision reader (lib/snapfill/vision.ts) drops anything not in this list, so a
// host's screenshot can only ever fill these three — never any other metric, and
// never a column on live_sessions or metric_entries (those are written only later,
// on moderator approval, by the promotion action).
export const LIVE_OPS_SNAP_FIELDS: SnapSchema = [
  {
    key: "viewers",
    label: "Viewers",
    type: "number",
    aliases: ["viewer", "live viewers", "peak viewers", "current viewers", "audience", "watching"],
  },
  {
    key: "gmv",
    label: "GMV",
    type: "number",
    unit: "PHP",
    aliases: ["sales", "revenue", "gross merchandise value", "total sales", "gmv (php)"],
  },
  {
    key: "ctor",
    label: "CTOR",
    type: "number",
    unit: "%",
    aliases: ["click to order rate", "click-to-order", "click to order", "ctr to order"],
  },
];

// The active contributor a token resolves to. Only the fields the public page and
// the write route need — never anything sensitive.
export interface TokenContributor {
  id: string;
  org_id: string;
  name: string;
  handle: string | null;
  brand_id: string | null;
  department_id: string | null;
  platform: string | null;
  kind: "host" | "intern";
  status: "active" | "revoked";
  assignment: string | null;
  brand_name: string | null;
  department_name: string | null;
}

// Which capture the /host portal shows a contributor, chosen from their
// department (kind is the fallback when no matching department is set):
//   live       → Live Operations: live-selling results (viewers/gmv/ctor, the
//                existing Snap-to-Data + moderator promotion to live_sessions).
//   creative   → Creative: assets produced + reference links.
//   ecommerce  → E-Commerce Ops: listings / orders handled.
//   general    → any other intern: plain outputs + blockers.
export type PortalMode = "live" | "creative" | "ecommerce" | "general";

export function portalModeForContributor(
  c: Pick<TokenContributor, "department_name" | "kind">
): PortalMode {
  const n = (c.department_name ?? "").toLowerCase();
  if (n.includes("live")) return "live";
  if (n.includes("creative")) return "creative";
  if (n.includes("commerce") || n.includes("ecom")) return "ecommerce";
  // No department (or an unmapped one): a host still defaults to the live capture
  // for backward compatibility; any other intern gets the general outputs form.
  if (c.kind === "host") return "live";
  return "general";
}

// An OPEN task a lead/moderator has assigned to this contributor. Read-only on the
// portal — the contributor confirms it in their daily log, never edits it.
export interface AssignedTask {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
}

// The contributor's OPEN assigned tasks (tasks.contributor_id = them), hard-scoped
// to their own org. Read through the service-role client because the public portal
// is unauthenticated and tasks are RLS-locked to OS users; the token is the only
// credential and this returns only that contributor's own open work.
export async function fetchOpenAssignedTasks(
  contributor: Pick<TokenContributor, "id" | "org_id">
): Promise<AssignedTask[]> {
  const db = createServiceRoleClient() as unknown as Db;
  const { data, error } = await db
    .from("tasks")
    .select("id, title, status, due_date")
    .eq("org_id", contributor.org_id)
    .eq("contributor_id", contributor.id)
    .is("archived_at", null)
    .in("status", ["todo", "in_progress", "blocked"])
    .order("due_date", { ascending: true })
    .limit(50);
  if (error || !data) return [];
  return data as AssignedTask[];
}

// A URL-safe, unguessable token. 24 bytes of entropy → 32 base64url chars. The
// `contributors.token` column is UNIQUE, so a (vanishingly unlikely) collision
// surfaces as an insert error the caller retries.
export function generateContributorToken(): string {
  return randomBytes(24).toString("base64url");
}

// Basic shape guard so a malformed path segment never reaches the DB. base64url
// alphabet only, bounded length.
export function isPlausibleToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

type Db = { from: (t: string) => any };

// Resolve a token → the ACTIVE contributor it names, or null (unknown token, or a
// revoked one). Runs through the service-role client because the contributors
// table is RLS-locked to leadership; this function is the ONLY place that read is
// made on behalf of an unauthenticated visitor, and it returns nothing sensitive.
export async function resolveContributorByToken(
  token: string
): Promise<TokenContributor | null> {
  if (!isPlausibleToken(token)) return null;
  const db = createServiceRoleClient() as unknown as Db;

  const { data, error } = await db
    .from("contributors")
    .select("id, org_id, name, handle, brand_id, department_id, platform, kind, status, assignment")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) return null;
  const c = data as Omit<TokenContributor, "brand_name" | "department_name">;
  if (c.status !== "active") return null;

  let brandName: string | null = null;
  if (c.brand_id) {
    const { data: brand } = await db
      .from("brands")
      .select("name")
      .eq("id", c.brand_id)
      .maybeSingle();
    brandName = (brand as { name?: string } | null)?.name ?? null;
  }

  let departmentName: string | null = null;
  if (c.department_id) {
    const { data: dept } = await db
      .from("departments")
      .select("name")
      .eq("id", c.department_id)
      .maybeSingle();
    departmentName = (dept as { name?: string } | null)?.name ?? null;
  }

  return { ...c, brand_name: brandName, department_name: departmentName };
}

// Find (or create) TODAY's contributor_logs row for this contributor. The three
// public actions (selfie clock-in, task note, snap) all land on the SAME daily
// row, so a host who clocks in and later snaps results doesn't spawn two records.
// There is no unique (contributor_id, log_date) constraint, so this is a
// select-then-insert; a same-second double-submit from one phone is not a real
// concern. brand_id is copied from the contributor (derived from the token).
export async function getOrCreateTodayLogId(
  contributor: Pick<TokenContributor, "id" | "org_id" | "brand_id">
): Promise<string | null> {
  const db = createServiceRoleClient() as unknown as Db;
  const today = manilaToday();

  const { data: existing } = await db
    .from("contributor_logs")
    .select("id")
    .eq("contributor_id", contributor.id)
    .eq("log_date", today)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created, error } = await db
    .from("contributor_logs")
    .insert({
      org_id: contributor.org_id,
      contributor_id: contributor.id,
      brand_id: contributor.brand_id,
      log_date: today,
      // status defaults to 'unverified', attendance_status to 'pending'.
    })
    .select("id")
    .single();
  if (error || !created) return null;
  return created.id as string;
}
