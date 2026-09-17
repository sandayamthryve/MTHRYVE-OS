import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, Badge, rowClass } from "@/components/ui";
import { LiveOpsTabs } from "@/components/live-ops/LiveOpsTabs";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { todayManila, manilaStamp } from "@/lib/metrics/windows";
import { intOrDash } from "@/lib/metrics/format";
import { manilaDateOf, type LiveSession } from "@/lib/metrics/live";
import {
  parseView,
  parseAnchor,
  rangeFor,
  scheduleDay,
  detectConflicts,
  conflictedIds,
} from "@/lib/live-ops/schedule";
import { updateSchedule } from "../actions";

// PART F — Live Schedule Integration + HR.
//
// The schedule IS live_sessions with status='scheduled'. Day/Week/Month views
// with conflict detection (overlapping anchor OR studio), attendance cross-check
// for Live Ops personnel (punctuality, absences, adherence), substitute-anchor
// reassignment, and a schedule history via updated timestamps. Reschedule is via
// the inline form (the same live_sessions row the Plan calendar shows).

export const dynamic = "force-dynamic";

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink";

type Brand = { id: string; name: string };
type Anchor = { id: string; name: string };
type Person = { id: string; full_name: string; team_assignment: string | null };
interface Attendance {
  id: string;
  user_id: string;
  work_date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: string;
  scheduled_in: string | null;
  scheduled_out: string | null;
  late_minutes: number | null;
  undertime_minutes: number | null;
}

function shiftDate(anchor: string, view: string, dir: number): string {
  const d = new Date(`${anchor}T12:00:00+08:00`);
  // Guard: never call .toISOString() on an Invalid Date (throws RangeError).
  if (Number.isNaN(d.getTime())) return anchor;
  if (view === "day") d.setDate(d.getDate() + dir);
  else if (view === "week") d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir);
  return manilaDateOf(d.toISOString()) ?? anchor;
}

interface SearchParams { view?: string; date?: string }

export default async function SchedulePage({ searchParams }: { searchParams?: SearchParams }) {
  const profile = await requireModule("/live-ops");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  const view = parseView(searchParams?.view);
  // parseAnchor validates that ?date is a REAL calendar date (not just the right
  // shape) and falls back to today in Manila otherwise, so the range is always
  // a valid current period and the date math below can never crash.
  const anchor = parseAnchor(searchParams?.date);
  const range = rangeFor(view, anchor);

  const [sessionsRes, brandsRes, anchorsRes, usersRes, attendanceRes] = await Promise.all([
    u.from("live_sessions").select("*").eq("status", "scheduled").is("archived_at", null).order("started_at", { ascending: true, nullsFirst: false }),
    supabase.from("brands").select("id, name").order("name"),
    u.from("anchors").select("id, name").order("name"),
    supabase.from("users").select("id, full_name, team_assignment").order("full_name"),
    u.from("attendance").select("*").gte("work_date", range.start).lte("work_date", range.end),
  ]);

  const scheduled = (sessionsRes.data ?? []) as LiveSession[];
  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const anchors = (anchorsRes.data ?? []) as Anchor[];
  const people = (usersRes.data ?? []) as unknown as Person[];
  const attendance = (attendanceRes.data ?? []) as Attendance[];

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const anchorName = (id: string | null) => anchors.find((a) => a.id === id)?.name ?? "—";
  const personName = (id: string | null) => people.find((p) => p.id === id)?.full_name ?? "—";

  // Scheduled sessions inside the visible range, by day.
  const inRange = scheduled.filter((s) => {
    const day = scheduleDay(s);
    return day != null && day >= range.start && day <= range.end;
  });
  const byDay = new Map<string, LiveSession[]>();
  for (const s of inRange) {
    const day = scheduleDay(s)!;
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(s);
  }

  const conflicts = detectConflicts(inRange);
  const conflicted = conflictedIds(conflicts);

  // ── HR cross-check: Live Ops personnel = users appearing on these sessions as
  // moderator/team leader, plus anyone whose team_assignment mentions "live".
  const personnelIds = new Set<string>();
  for (const s of inRange) {
    if (s.moderator_id) personnelIds.add(s.moderator_id);
    if (s.team_leader_id) personnelIds.add(s.team_leader_id);
  }
  for (const p of people) if ((p.team_assignment ?? "").toLowerCase().includes("live")) personnelIds.add(p.id);
  const attendanceForPersonnel = attendance.filter((a) => personnelIds.has(a.user_id));

  const lateCount = attendanceForPersonnel.filter((a) => (a.late_minutes ?? 0) > 0).length;
  const absentCount = attendanceForPersonnel.filter((a) => a.status === "absent").length;

  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Operations", "Schedule & HR"]} profile={profile}>
      <PageHeader
        title="Live Schedule & HR"
        subtitle="Scheduled lives with conflict detection (anchor or studio overlap) and an attendance cross-check for Live Ops personnel."
      />
      <LiveOpsTabs />

      {/* View + date navigation */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-charcoal-700/60 bg-charcoal-900 p-1">
          {(["day", "week", "month"] as const).map((v) => (
            <Link
              key={v}
              href={{ pathname: "/live-ops/schedule", query: { view: v, date: anchor } }}
              className={`rounded-md px-3 py-1.5 text-xs capitalize ${view === v ? "bg-teal-500/10 text-teal-300" : "text-ink-muted hover:text-ink"}`}
            >
              {v}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Link href={{ pathname: "/live-ops/schedule", query: { view, date: shiftDate(anchor, view, -1) } }} className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs text-ink-muted hover:bg-charcoal-700">← Prev</Link>
          <Link href={{ pathname: "/live-ops/schedule", query: { view, date: todayManila() } }} className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs text-ink-muted hover:bg-charcoal-700">Today</Link>
          <Link href={{ pathname: "/live-ops/schedule", query: { view, date: shiftDate(anchor, view, 1) } }} className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs text-ink-muted hover:bg-charcoal-700">Next →</Link>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Scheduled" value={inRange.length} hint={`${range.start} → ${range.end}`} />
        <StatTile label="Conflicts" value={conflicts.length} valueClassName={conflicts.length ? "text-red-300" : "text-ink"} />
        <StatTile label="Late (personnel)" value={lateCount} valueClassName={lateCount ? "text-amber-300" : "text-ink"} />
        <StatTile label="Absences" value={absentCount} valueClassName={absentCount ? "text-red-300" : "text-ink"} />
      </div>

      {/* ── Conflicts ── */}
      {conflicts.length > 0 && (
        <div className="mb-6 rounded-xl border border-red-500/40 bg-red-500/[0.06] p-4">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-red-300">⚠ Schedule conflicts</p>
          <ul className="space-y-1 text-xs text-ink">
            {conflicts.map((c, i) => (
              <li key={i}>
                <span className="font-mono text-red-300">{c.reason === "anchor" ? "Anchor" : "Studio"} overlap</span>{" "}
                — <Link href={`/live-ops/reports/${c.a.id}`} className="text-teal-300 hover:text-teal-200">{c.a.title ?? "Untitled"}</Link>
                {" ↔ "}
                <Link href={`/live-ops/reports/${c.b.id}`} className="text-teal-300 hover:text-teal-200">{c.b.title ?? "Untitled"}</Link>
                {c.reason === "anchor" ? ` · ${anchorName(c.a.anchor_id)}` : ` · ${c.a.studio}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Month grid (also shown for week/day, scoped to the range) ── */}
      {view === "month" && (
        <SectionCard title={`Calendar · ${anchor.slice(0, 7)}`} className="mb-6">
          <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:overflow-visible sm:px-0">
          <div className="grid min-w-[34rem] grid-cols-7 gap-1 sm:min-w-0">
            {WEEKDAYS.map((w) => (
              <div key={w} className="pb-1 text-center font-mono text-[9px] uppercase tracking-wider text-ink-dim">{w}</div>
            ))}
            {range.gridDays.map((day) => {
              const inMonth = day.slice(0, 7) === anchor.slice(0, 7);
              const items = byDay.get(day) ?? [];
              const isToday = day === todayManila();
              return (
                <div
                  key={day}
                  className={`min-h-[76px] rounded-md border p-1 ${inMonth ? "border-charcoal-700/60 bg-charcoal-950/40" : "border-charcoal-800/40 bg-transparent opacity-50"} ${isToday ? "ring-1 ring-teal-500/50" : ""}`}
                >
                  <div className="mb-1 text-right font-mono text-[9px] text-ink-dim">{day.slice(8)}</div>
                  <div className="space-y-0.5">
                    {items.slice(0, 3).map((s) => (
                      <Link
                        key={s.id}
                        href={`/live-ops/reports/${s.id}`}
                        className={`block truncate rounded px-1 py-0.5 text-[9px] ${conflicted.has(s.id) ? "bg-red-500/20 text-red-200" : "bg-violet-500/15 text-violet-200"}`}
                        title={`${s.title ?? "Untitled"} · ${anchorName(s.anchor_id)}`}
                      >
                        {manilaStamp(s.started_at)?.slice(-5) ?? ""} {s.title ?? "Live"}
                      </Link>
                    ))}
                    {items.length > 3 && <span className="text-[9px] text-ink-dim">+{items.length - 3} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        </SectionCard>
      )}

      {/* ── Schedule details + inline reschedule / substitute anchor ── */}
      <SectionCard title="Scheduled lives" className="mb-6">
        <TableShell columns={["When", "Brand", "Anchor", "Moderator", "TL", "Studio / Shift", "Reschedule / substitute"]}>
          {inRange.length === 0 && (
            <tr><td colSpan={7} className="p-4 text-ink-muted">No lives scheduled in this {view}. Schedule one from a Daily Report (set status “Scheduled”) or the Plan calendar.</td></tr>
          )}
          {inRange.map((s) => (
            <tr key={s.id} className={rowClass}>
              <td className="p-3 text-[11px] text-ink-dim">
                {manilaStamp(s.started_at) ?? "TBD"}
                {conflicted.has(s.id) && <div><Badge tone="red">conflict</Badge></div>}
              </td>
              <td className="p-3 text-ink-muted">{brandName(s.brand_id)}</td>
              <td className="p-3 text-ink">{anchorName(s.anchor_id)}</td>
              <td className="p-3 text-ink-muted">{personName(s.moderator_id)}</td>
              <td className="p-3 text-ink-muted">{personName(s.team_leader_id)}</td>
              <td className="p-3 text-[11px] text-ink-muted">{s.studio ?? "—"}{s.shift ? ` · ${s.shift}` : ""}</td>
              <td className="p-3">
                <form action={updateSchedule} className="flex flex-wrap items-center gap-1.5">
                  <input type="hidden" name="id" value={s.id} />
                  <input
                    type="datetime-local"
                    name="started_at"
                    defaultValue={s.started_at ? manilaStampInput(s.started_at) : ""}
                    className={inputCls}
                  />
                  <select name="anchor_id" defaultValue={s.anchor_id ?? ""} className={inputCls} title="Substitute anchor">
                    <option value="">No anchor</option>
                    {anchors.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                  </select>
                  <input type="hidden" name="moderator_id" value={s.moderator_id ?? ""} />
                  <input type="hidden" name="team_leader_id" value={s.team_leader_id ?? ""} />
                  <input name="studio" defaultValue={s.studio ?? ""} placeholder="Studio" className={`${inputCls} w-20`} />
                  <input name="shift" defaultValue={s.shift ?? ""} placeholder="Shift" className={`${inputCls} w-16`} />
                  <input name="expected_duration_minutes" type="number" defaultValue={s.expected_duration_minutes ?? ""} placeholder="min" className={`${inputCls} w-16`} />
                  <button type="submit" className="rounded-md bg-teal-500 px-2 py-1 text-[11px] font-semibold text-charcoal-950 hover:bg-teal-400">Save</button>
                </form>
              </td>
            </tr>
          ))}
        </TableShell>
      </SectionCard>

      {/* ── HR: attendance cross-check for Live Ops personnel ── */}
      <SectionCard title="Attendance cross-check" action={<Badge tone="muted">{range.start} → {range.end}</Badge>}>
        <p className="mb-3 text-xs text-ink-muted">
          Punctuality and adherence for Live Ops personnel scheduled in this range — validated against their attendance (scheduled vs actual clock in/out). Blank means no attendance record for that day.
        </p>
        <TableShell columns={["Person", "Date", "Scheduled", "Clock in / out", "Late", "Undertime", "Status"]}>
          {attendanceForPersonnel.length === 0 && (
            <tr><td colSpan={7} className="p-4 text-ink-muted">No attendance records for Live Ops personnel in this range.</td></tr>
          )}
          {attendanceForPersonnel
            .sort((a, b) => a.work_date.localeCompare(b.work_date))
            .map((a) => {
              const late = (a.late_minutes ?? 0) > 0;
              return (
                <tr key={a.id} className={rowClass}>
                  <td className="p-3 text-ink">{personName(a.user_id)}</td>
                  <td className="p-3 font-mono text-[11px] text-ink-dim">{a.work_date}</td>
                  <td className="p-3 font-mono text-[11px] text-ink-muted">{a.scheduled_in ?? "—"}{a.scheduled_out ? `–${a.scheduled_out}` : ""}</td>
                  <td className="p-3 font-mono text-[11px] text-ink-muted">
                    {a.clock_in ? manilaStamp(a.clock_in)?.slice(-5) : "—"}
                    {a.clock_out ? ` – ${manilaStamp(a.clock_out)?.slice(-5)}` : ""}
                  </td>
                  <td className={`p-3 font-mono ${late ? "text-amber-300" : "text-ink-muted"}`}>{a.late_minutes ? `${a.late_minutes}m` : "—"}</td>
                  <td className="p-3 font-mono text-ink-muted">{intOrDash(a.undertime_minutes)}</td>
                  <td className="p-3">
                    <Badge tone={a.status === "absent" ? "red" : a.status === "present" ? "teal" : "muted"}>{a.status}</Badge>
                  </td>
                </tr>
              );
            })}
        </TableShell>
      </SectionCard>
    </AppShell>
  );
}

// datetime-local value for a stored instant, rendered in Manila wall-clock.
function manilaStampInput(iso: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(iso));
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
  } catch {
    return "";
  }
}
