"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { Badge, type BadgeTone } from "@/components/ui";
import {
  SEVERITY_TONE,
  typeLabel,
  notificationHref,
  canApproveInline,
  type NotificationRow,
} from "@/lib/notifications/read";
import {
  markNotificationRead,
  markAllNotificationsRead,
  approveFromNotification,
} from "./actions";

// The Notification Centre — the per-user inbox. Reads are done server-side and
// handed in; this component only drives mark-read, mark-all-read, the
// unread/all filter, and the in-line Approve (which routes through the spine,
// never auto-executes). Optimistic-ish: after a successful action it flips the
// row locally so the list feels live without a full reload.

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function NotificationCentre({ initial }: { initial: NotificationRow[] }) {
  const [rows, setRows] = useState<NotificationRow[]>(initial);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const unreadCount = useMemo(() => rows.filter((r) => !r.read).length, [rows]);
  const shown = useMemo(
    () => (filter === "unread" ? rows.filter((r) => !r.read) : rows),
    [rows, filter]
  );

  function setRead(id: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, read: true } : r)));
  }

  function onMarkRead(id: string) {
    setRead(id);
    startTransition(async () => {
      await markNotificationRead(id);
    });
  }

  function onMarkAll() {
    setRows((prev) => prev.map((r) => ({ ...r, read: true })));
    startTransition(async () => {
      await markAllNotificationsRead();
    });
  }

  function onApprove(row: NotificationRow) {
    if (!row.entity_id) return;
    setError(null);
    startTransition(async () => {
      const res = await approveFromNotification(row.id, row.entity_id!);
      if (res.ok) {
        setRead(row.id);
      } else {
        setError(res.error ?? "Could not approve — open the Approval Queue.");
      }
    });
  }

  return (
    <div>
      {/* Controls */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-charcoal-700">
          {(["all", "unread"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                filter === f ? "bg-charcoal-800 text-ink" : "text-ink-muted hover:text-ink"
              }`}
            >
              {f}
              {f === "unread" && unreadCount > 0 ? ` · ${unreadCount}` : ""}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onMarkAll}
          disabled={pending || unreadCount === 0}
          className="rounded-md border border-charcoal-700 px-3 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Mark all read
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-charcoal-700 bg-charcoal-900">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">
            {filter === "unread" ? "No unread notifications. You're all caught up." : "No notifications yet."}
          </p>
        ) : (
          shown.map((r) => {
            const tone: BadgeTone = SEVERITY_TONE[r.severity] ?? "teal";
            const href = notificationHref(r);
            return (
              <div
                key={r.id}
                className={`flex items-start gap-3 border-b border-charcoal-700/60 px-4 py-3 last:border-0 ${
                  r.read ? "" : "bg-charcoal-800/40"
                }`}
              >
                {/* Unread dot */}
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    r.read ? "bg-transparent" : "bg-teal-400 shadow-[0_0_8px_theme(colors.teal.400)]"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={tone}>{typeLabel(r.type)}</Badge>
                    <span className="font-mono text-[10px] text-ink-dim">{timeAgo(r.created_at)}</span>
                  </div>
                  <p className={`mt-1 text-sm ${r.read ? "text-ink-muted" : "text-ink"}`}>{r.title}</p>
                  {r.body && (
                    <p className="mt-0.5 whitespace-pre-line text-xs text-ink-muted">{r.body}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Link
                      href={href}
                      onClick={() => onMarkRead(r.id)}
                      className="text-xs font-medium text-teal-400 hover:text-teal-300"
                    >
                      View →
                    </Link>
                    {canApproveInline(r) && (
                      <button
                        type="button"
                        onClick={() => onApprove(r)}
                        disabled={pending}
                        className="rounded-md bg-teal-500 px-2.5 py-1 text-xs font-semibold text-charcoal-950 transition hover:bg-teal-400 disabled:opacity-40"
                      >
                        Approve
                      </button>
                    )}
                    {!r.read && (
                      <button
                        type="button"
                        onClick={() => onMarkRead(r.id)}
                        disabled={pending}
                        className="text-xs text-ink-muted hover:text-ink disabled:opacity-40"
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <p className="mt-3 font-mono text-[10px] text-ink-dim">
        In-notification Approve routes through the policy registry + approval spine — nothing
        auto-executes.
      </p>
    </div>
  );
}
