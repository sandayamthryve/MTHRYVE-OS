import type { TaskStatus, TaskPriority, ProjectStatus } from "@/types/database";

// Presentation helpers shared across the task list and detail views. Kept in one
// place so status/priority labels and colors never drift between screens.

// Valid project statuses, mirroring the project_status enum. Used by the bulk
// CSV import to normalize a pasted status to a valid value (default 'active').
export const PROJECT_STATUSES: ProjectStatus[] = ["active", "on_hold", "completed", "archived"];

export const TASK_STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

export const TASK_PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

// Tailwind classes for a small status pill.
export function statusPillClasses(status: TaskStatus): string {
  switch (status) {
    case "done":
      return "bg-green-500/15 text-green-400";
    case "in_progress":
      return "bg-teal-500/15 text-teal-400";
    case "blocked":
      return "bg-gold-500/15 text-gold-400";
    case "cancelled":
      return "bg-charcoal-800 text-ink-muted line-through";
    default:
      return "bg-charcoal-800 text-ink-muted";
  }
}

// Priority accent — urgent/high draw the eye, low recedes.
export function priorityClasses(priority: TaskPriority): string {
  switch (priority) {
    case "urgent":
      return "text-gold-400";
    case "high":
      return "text-teal-400";
    case "low":
      return "text-ink-muted";
    default:
      return "text-ink";
  }
}

// Human date without pulling in a date library. Input is a YYYY-MM-DD date
// string (Postgres `date`) or null.
export function formatDate(value: string | null): string {
  if (!value) return "—";
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}
