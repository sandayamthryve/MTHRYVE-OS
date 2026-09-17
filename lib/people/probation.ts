// lib/people/probation.ts — the shared domain logic behind the new-hire
// probation LIFECYCLE: who may manage it, the HR-facing queue, and the single
// "Review due" definition every surface reuses (the queue page, the decision
// actions, and the daily auto-flag scan all import from here so they never
// disagree about what "within 14 days" means).
//
// employment_status is free text on the live users table; a new hire is
// 'probationary' with a probation_end date. The two lifecycle values this
// feature writes — 'regular' (regularized) and 'released' — are recorded on the
// same column. probation_reviews is the append-only ledger of every decision.

import { isProbationary, probationDaysLeft } from "@/lib/auth/session";
import type { UserRole } from "@/types/database";

type Shim = { from: (t: string) => any };

// A hire is "Review due" when probation_end is within this many days — upcoming
// OR already lapsed (a negative day-count is even more urgent). One constant so
// the queue flag, the decision panel and the auto-flag scan share one window.
export const PROBATION_REVIEW_WINDOW_DAYS = 14;

// The department whose HEAD (departments.lead_user_id) may manage probation
// alongside leadership. Matched loosely against the department name so "HR &
// Admin", "HR and Admin" and "HR/Admin" all resolve to the same head.
export const HR_ADMIN_DEPT_MATCH = /hr\b.*admin/i;

// The three decisions the ledger records (mirrors the DB CHECK constraint on
// probation_reviews.decision exactly).
export type ProbationDecision = "regularize" | "extend" | "release";

// The lifecycle status each decision writes onto users.employment_status.
// 'regularize' → 'active' (matching the "Make Permanent" path exactly, so both
// routes out of probation converge on one value). 'extend' keeps the hire
// probationary; only the probation_end date moves.
export const DECISION_STATUS: Record<ProbationDecision, string | null> = {
  regularize: "active",
  extend: null, // stays 'probationary'
  release: "released",
};

export interface ProbationQueueRow {
  id: string;
  full_name: string;
  email: string;
  position: string | null;
  department_id: string | null;
  supervisor_id: string | null;
  probation_end: string; // never null in the queue (filtered below)
  daysLeft: number | null;
  reviewDue: boolean;
}

// The person a decision acts on, read once from the master users row.
export interface ProbationSubject {
  id: string;
  org_id: string;
  full_name: string;
  email: string | null;
  employment_status: string | null;
  probation_end: string | null;
  supervisor_id: string | null;
}

// Resolve the user id who heads the HR & Admin department (its lead_user_id).
// Org-scoped explicitly. Returns null when there's no such department or it has
// no lead — in which case only leadership can manage probation. Never throws.
export async function resolveHrAdminHeadId(db: Shim, orgId: string): Promise<string | null> {
  try {
    const { data } = await db
      .from("departments")
      .select("name, lead_user_id")
      .eq("org_id", orgId);
    const rows = (data as Array<{ name: string | null; lead_user_id: string | null }> | null) ?? [];
    const hr = rows.find((d) => HR_ADMIN_DEPT_MATCH.test((d.name ?? "").trim()));
    return hr?.lead_user_id ?? null;
  } catch {
    return null;
  }
}

// The probation gate: leadership (ceo / coo) always, plus the HR & Admin dept
// head. Everyone else is denied. This is the single predicate the queue page
// and every decision action enforce so the UI and the write path never diverge.
export async function canManageProbation(
  db: Shim,
  profile: { id: string; org_id: string; role: UserRole }
): Promise<boolean> {
  if (profile.role === "ceo" || profile.role === "coo") return true;
  if (profile.role !== "department_head") return false;
  const hrHead = await resolveHrAdminHeadId(db, profile.org_id);
  return !!hrHead && hrHead === profile.id;
}

// Is this hire within the review window (upcoming or lapsed)?
export function isReviewDue(
  row: { employment_status: string | null; probation_end: string | null },
  now: Date = new Date()
): boolean {
  const left = probationDaysLeft(row, now);
  return left !== null && left <= PROBATION_REVIEW_WINDOW_DAYS;
}

// The HR-facing queue: probationary users WITH a probation_end, soonest first,
// each flagged "Review due" when inside the window. Reads through whatever
// client the caller passes (the RLS server client for the page; the
// service-role client for the automation scan). Org-scoped explicitly.
export async function listProbationQueue(
  db: Shim,
  orgId: string,
  now: Date = new Date()
): Promise<ProbationQueueRow[]> {
  let rows: Array<{
    id: string;
    full_name: string;
    email: string;
    position: string | null;
    department_id: string | null;
    supervisor_id: string | null;
    employment_status: string | null;
    probation_end: string | null;
  }> = [];
  try {
    const { data } = await db
      .from("users")
      .select("id, full_name, email, position, department_id, supervisor_id, employment_status, probation_end")
      .eq("org_id", orgId)
      .not("probation_end", "is", null)
      .order("probation_end", { ascending: true });
    rows = (data as typeof rows | null) ?? [];
  } catch {
    return [];
  }

  return rows
    // Match the session gate's case/space-insensitive notion of probationary,
    // and keep only rows that actually carry a probation_end date.
    .filter((r) => isProbationary(r.employment_status) && !!r.probation_end)
    .map((r) => {
      const daysLeft = probationDaysLeft(r, now);
      return {
        id: r.id,
        full_name: r.full_name,
        email: r.email,
        position: r.position,
        department_id: r.department_id,
        supervisor_id: r.supervisor_id,
        probation_end: r.probation_end as string,
        daysLeft,
        reviewDue: daysLeft !== null && daysLeft <= PROBATION_REVIEW_WINDOW_DAYS,
      };
    });
}
