import type { ProjectStatus } from "@/types/database";

// Presentation helpers for the Projects Log (the /tony panel and /projects
// board). Kept in one place so the column definitions, labels and colors never
// drift between the two surfaces.

// Human labels for every project status, including the new 'planned' ("Next").
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Working On",
  planned: "Next",
  on_hold: "Paused",
  completed: "Done",
  archived: "Archived",
};

// The Projects Log board columns, left→right. 'archived' is intentionally
// excluded — archived projects fall off the board (still reachable elsewhere).
// The 'planned' ("Next") column is optional; callers can hide it when empty.
export type BoardColumn = {
  status: ProjectStatus;
  title: string;
  hint: string;
};

export const BOARD_COLUMNS: BoardColumn[] = [
  { status: "active", title: "Working On", hint: "In progress now" },
  { status: "planned", title: "Next", hint: "Planned / upcoming" },
  { status: "on_hold", title: "Paused", hint: "On hold" },
  { status: "completed", title: "Done", hint: "Completed in the last 30 days" },
];

// The statuses a card can be moved between via the quick status control. Matches
// the board columns so the board is closed under moves.
export const MOVABLE_STATUSES: ProjectStatus[] = ["active", "planned", "on_hold", "completed"];

// Column accent — a dot + heading tint per status so the eye can scan columns.
export function columnAccent(status: ProjectStatus): { dot: string; text: string } {
  switch (status) {
    case "active":
      return { dot: "bg-teal-400", text: "text-teal-300" };
    case "planned":
      return { dot: "bg-sky-400", text: "text-sky-300" };
    case "on_hold":
      return { dot: "bg-gold-400", text: "text-gold-300" };
    case "completed":
      return { dot: "bg-green-400", text: "text-green-300" };
    default:
      return { dot: "bg-ink-dim", text: "text-ink-muted" };
  }
}

// A YYYY-MM-DD date, or "—" when blank/malformed. Same style as lib/tasks/display.
export function formatDate(value: string | null): string {
  if (!value) return "—";
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}

// The cutoff for the "Done" column: completed projects whose updated_at is within
// the last 30 days. Returns an ISO timestamp.
export function doneSinceIso(now: Date = new Date()): string {
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
}
