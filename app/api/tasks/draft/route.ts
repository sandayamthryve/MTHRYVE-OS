import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { anthropicMessages } from "@/lib/briefings/anthropic";
import { TIER_MODEL, TIER_ORDER, defaultTierFor, isModelTier } from "@/lib/ai/models";
import { parseJsonBody, serverError } from "@/lib/security/api";
import { TASK_PRIORITIES } from "@/lib/tasks/display";
import type { TaskPriority } from "@/types/database";

// POST /api/tasks/draft — the AI-assist half of the hybrid "New task" form.
//
// READ-ONLY drafting: the caller sends a one-line brief, this returns a
// SUGGESTED {title, description, priority, assigneeHint, departmentHint} that the
// client PRE-FILLS into the manual fields. It NEVER creates a task — the manual
// Save (the RLS-scoped insert in NewTaskForm) remains the only write path. A
// failure here degrades to a plain manual form; nothing is blocked.
//
// Reuse, not a new integration: the request goes through the SAME Anthropic path
// as every other surface (lib/briefings/anthropic → the one ANTHROPIC_API_KEY),
// the model is picked with the SAME role/grant tiering (lib/ai/models), and the
// call is logged to the SAME content_generations ledger as the Content Studio.
//
// Scope: any authenticated member may draft (leg-work doctrine). Grounding reads
// (departments + teammate names) go through the caller's RLS-scoped client, so a
// draft can only ever see the caller's own org — no privileged reads.

const DraftSchema = z.object({
  brief: z.string().min(1).max(2000),
});

export const runtime = "nodejs";
export const maxDuration = 30;

// Pick the caller's model: their role default, upgraded only if an active
// model_grant maps to a higher tier. Mirrors the Content Studio route's tiering
// (D-012) so both drafting surfaces resolve the model identically.
async function selectModel(profile: { role: string; id: string }): Promise<string> {
  const defaultTier = defaultTierFor(profile.role);
  let tier = defaultTier;
  try {
    const supabase = createServerSupabaseClient();
    const { data: grant } = await (
      supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (col: string, v: string) => {
              gt: (col: string, v: string) => {
                order: (
                  col: string,
                  o: { ascending: boolean }
                ) => { limit: (n: number) => { maybeSingle: () => Promise<{ data: { tier?: string } | null }> } };
              };
            };
          };
        };
      }
    )
      .from("model_grants")
      .select("tier")
      .eq("user_id", profile.id)
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const granted = grant?.tier;
    if (isModelTier(granted) && TIER_ORDER[granted] > TIER_ORDER[defaultTier]) {
      tier = granted;
    }
  } catch {
    // Grant lookup is best-effort — fall back to the role default on any failure.
  }
  return TIER_MODEL[tier];
}

// A task draft shape the client pre-fills into the manual form. priority is
// clamped to a valid task_priority; hints are free text the client resolves
// against its own roster (assignee) or shows as advisory (department).
interface TaskDraft {
  title: string;
  description: string;
  priority: TaskPriority;
  assigneeHint: string;
  departmentHint: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Parse the model's reply into a TaskDraft. The model is asked for a single JSON
// object; we pull the first {...} block and coerce each field defensively so a
// stray sentence or a bad priority never throws — a thin draft still pre-fills.
function parseDraft(raw: string): TaskDraft | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const priorityRaw = str(obj.priority).toLowerCase();
  const priority: TaskPriority = (TASK_PRIORITIES as string[]).includes(priorityRaw)
    ? (priorityRaw as TaskPriority)
    : "medium";
  return {
    title: str(obj.title).slice(0, 200),
    description: str(obj.description).slice(0, 2000),
    priority,
    assigneeHint: str(obj.assignee ?? obj.assigneeHint).slice(0, 120),
    departmentHint: str(obj.department ?? obj.departmentHint).slice(0, 120),
  };
}

export async function POST(req: NextRequest) {
  // Any authenticated member may draft — no session redirects to /login.
  const profile = (await requireRole([
    "ceo",
    "coo",
    "department_head",
    "team_member",
  ])) as unknown as { role: string; org_id: string; id: string };

  const parsed = await parseJsonBody(req, DraftSchema, "tasks/draft");
  if (!parsed.ok) return parsed.response;
  const brief = parsed.data.brief.trim();

  // Ground the department/assignee hints in the caller's OWN org roster (RLS
  // scoped — same read the Tasks page already does). Best-effort: if these
  // fail, drafting still works, just with un-grounded hints.
  const supabase = createServerSupabaseClient();
  let deptNames: string[] = [];
  let userNames: string[] = [];
  try {
    const [deptsRes, usersRes] = await Promise.all([
      supabase.from("departments").select("name").eq("org_id", profile.org_id),
      supabase.from("users").select("full_name").eq("org_id", profile.org_id),
    ]);
    deptNames = ((deptsRes.data ?? []) as unknown as { name: string | null }[])
      .map((d) => (d.name ?? "").trim())
      .filter(Boolean);
    userNames = ((usersRes.data ?? []) as unknown as { full_name: string | null }[])
      .map((u) => (u.full_name ?? "").trim())
      .filter(Boolean);
  } catch {
    // ungrounded hints are acceptable — the draft still pre-fills the core fields.
  }

  const model = await selectModel(profile);

  const system =
    "You turn a one-line work request into a single, well-scoped task draft for an operations team " +
    "at Mthryve, a digital-marketing agency in the Philippines (TikTok Shop & Shopee). " +
    "Reply with ONE JSON object and nothing else — no prose, no code fences. " +
    'Shape: {"title": string, "description": string, "priority": "low"|"medium"|"high"|"urgent", ' +
    '"department": string, "assignee": string}. ' +
    "title: a crisp imperative (<= 12 words). description: 1-3 sentences of concrete scope; never invent " +
    "metrics, names, or facts not implied by the request. priority: infer from urgency words, else \"medium\". " +
    "department and assignee: pick the SINGLE best match from the provided lists, or \"\" if none fits — " +
    "never invent a person or department that is not listed.";

  const deptLine = deptNames.length ? `Departments: ${deptNames.join(", ")}.` : "Departments: (none on file).";
  const userLine = userNames.length ? `Teammates: ${userNames.join(", ")}.` : "Teammates: (none on file).";
  const userPrompt = `${deptLine}\n${userLine}\n\nWork request: "${brief}"\n\nReturn the JSON task draft.`;

  let text = "";
  try {
    text = await anthropicMessages({ model, system, user: userPrompt, maxTokens: 600 });
  } catch (e) {
    // Surface a soft 502 — the client treats any non-2xx as "AI unavailable" and
    // silently keeps the manual form usable.
    return serverError("tasks/draft", e, 502, "AI draft is temporarily unavailable.");
  }

  const draft = parseDraft(text);
  if (!draft || !draft.title) {
    return NextResponse.json({ error: "AI draft is temporarily unavailable." }, { status: 502 });
  }

  // Best-effort ledger row — same table + shape as the Content Studio, so task
  // drafts are auditable alongside every other generation. Never blocks output.
  try {
    await (
      supabase as unknown as {
        from: (t: string) => { insert: (v: Record<string, unknown>) => Promise<unknown> };
      }
    )
      .from("content_generations")
      .insert({
        org_id: profile.org_id,
        created_by: profile.id,
        department: draft.departmentHint || "Operations",
        template_key: "task_draft",
        inputs: { brief },
        output: text,
        model,
      });
  } catch {
    // non-blocking
  }

  return NextResponse.json({ draft, model });
}
