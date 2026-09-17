import { manilaToday } from "@/lib/hr/time";

// Reads behind the Team Workspace. Both are department-scoped and both must
// degrade to empty rather than throw: this page is a landing surface, and a
// failed read should cost the queue, not the screen.
//
// `tasks` has no department column, so a department's work queue is reached
// through its people (assignee -> users.department_id). `daily_reports` does
// carry department_id, so the log side scopes directly.
type Shim = { from: (table: string) => any };

export type QueueItem = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  // The agent's note on the task, when one has been drafted.
  brief: string | null;
};

export type LogEntry = {
  id: string;
  text: string;
  filed: boolean;
};

const OPEN_STATUSES = ["todo", "in_progress", "blocked"];

export async function fetchDepartmentQueue(
  db: Shim,
  orgId: string,
  departmentId: string | null
): Promise<QueueItem[]> {
  if (!departmentId) return [];
  try {
    // Who belongs to this department...
    const { data: members } = await db
      .from("users")
      .select("id, full_name")
      .eq("org_id", orgId)
      .eq("department_id", departmentId);

    const people = (members ?? []) as { id: string; full_name: string }[];
    if (!people.length) return [];
    const nameById = new Map(people.map((person) => [person.id, person.full_name]));

    // ...and what is still open on their plates.
    const { data: rows } = await db
      .from("tasks")
      .select("id, title, description, status, priority, assignee_id")
      .eq("org_id", orgId)
      .in("assignee_id", people.map((person) => person.id))
      .in("status", OPEN_STATUSES)
      .order("priority", { ascending: false })
      .limit(12);

    return ((rows ?? []) as any[]).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? "Untitled task"),
      status: String(row.status ?? "todo"),
      priority: String(row.priority ?? "medium"),
      assignee: row.assignee_id ? nameById.get(String(row.assignee_id)) ?? null : null,
      brief: row.description ? String(row.description) : null,
    }));
  } catch {
    return [];
  }
}

// What the viewer has logged today. One daily_report per org+user+work_date,
// whose `outputs` is the running list -- each line is one logged entry, which is
// what "+ Log entry" appends to and what "File daily report" submits.
export async function fetchTodaysLog(
  db: Shim,
  orgId: string,
  userId: string
): Promise<{ entries: LogEntry[]; filed: boolean }> {
  try {
    const { data } = await db
      .from("daily_reports")
      .select("id, outputs, status")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .eq("work_date", manilaToday())
      .maybeSingle();

    const row = data as { id: string; outputs: string | null; status: string } | null;
    if (!row?.outputs) return { entries: [], filed: row?.status === "submitted" };

    const filed = row.status === "submitted";
    const entries = row.outputs
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text, index) => ({ id: `${row.id}-${index}`, text, filed }));

    return { entries, filed };
  } catch {
    return { entries: [], filed: false };
  }
}
