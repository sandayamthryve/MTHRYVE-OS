// components/commerce-ops/RecordCalendar.tsx — the campaign / promotion calendar
// + timeline. Pure, server-rendered from op_records that carry start/end dates.
// A month grid marks every day covered by a record; a timeline lists each record
// as a proportional bar across the visible window. No external deps.

import { STATUS_LABEL, statusTone, type OpStatus } from "@/lib/commerce-ops/records";
import { Badge } from "@/components/ui";

export interface CalendarRecord {
  id: string;
  title: string;
  status: OpStatus;
  start_date: string | null;
  end_date: string | null;
}

function toDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// Records that overlap [monthStart, monthEnd].
export function RecordCalendar({
  records,
  month,
}: {
  records: CalendarRecord[];
  month: Date;
}) {
  const year = month.getFullYear();
  const mo = month.getMonth();
  const first = new Date(year, mo, 1);
  const daysInMonth = new Date(year, mo + 1, 0).getDate();
  const leading = first.getDay(); // 0=Sun

  // Map each in-window record to the set of day-numbers it covers this month.
  const dated = records
    .map((r) => ({ r, s: toDate(r.start_date), e: toDate(r.end_date) }))
    .filter((x) => x.s || x.e);

  const dayCount: number[] = Array.from({ length: daysInMonth + 1 }, () => 0);
  for (const { s, e } of dated) {
    const start = s ?? e!;
    const end = e ?? s!;
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(year, mo, day);
      if (d >= new Date(start.getFullYear(), start.getMonth(), start.getDate()) &&
          d <= new Date(end.getFullYear(), end.getMonth(), end.getDate())) {
        dayCount[day] += 1;
      }
    }
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);

  const todayStr = ymd(new Date());

  // Timeline window: min start → max end across dated records.
  const bounds = dated.reduce(
    (acc, { s, e }) => {
      const lo = (s ?? e)!.getTime();
      const hi = (e ?? s)!.getTime();
      return { min: Math.min(acc.min, lo), max: Math.max(acc.max, hi) };
    },
    { min: Infinity, max: -Infinity }
  );
  const span = Math.max(1, bounds.max - bounds.min);

  return (
    <section className="grid gap-5 lg:grid-cols-2">
      {/* Month grid */}
      <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">{MONTHS[mo]} {year}</h3>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Calendar</span>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {DOW.map((d) => (
            <div key={d} className="pb-1 font-mono text-[10px] uppercase text-ink-muted">{d}</div>
          ))}
          {cells.map((day, i) => {
            if (day === null) return <div key={i} className="aspect-square rounded-md" />;
            const isToday = ymd(new Date(year, mo, day)) === todayStr;
            const active = dayCount[day] > 0;
            return (
              <div
                key={i}
                className={`flex aspect-square flex-col items-center justify-center rounded-md text-xs ${
                  active ? "bg-teal-500/15 text-teal-200 ring-1 ring-teal-500/30" : "text-ink-muted"
                } ${isToday ? "outline outline-1 outline-gold-400/70" : ""}`}
              >
                <span>{day}</span>
                {active && <span className="mt-0.5 h-1 w-1 rounded-full bg-teal-400" />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline bars */}
      <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Timeline</h3>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            {dated.length} scheduled
          </span>
        </div>
        {dated.length === 0 ? (
          <p className="text-sm text-ink-muted">No records with dates yet — set start/end dates to see the timeline.</p>
        ) : (
          <ul className="space-y-2.5">
            {dated
              .sort((a, b) => ((a.s ?? a.e)!.getTime() - (b.s ?? b.e)!.getTime()))
              .map(({ r, s, e }) => {
                const lo = (s ?? e)!.getTime();
                const hi = (e ?? s)!.getTime();
                const left = ((lo - bounds.min) / span) * 100;
                const width = Math.max(2, ((hi - lo) / span) * 100);
                return (
                  <li key={r.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-ink">{r.title}</span>
                      <Badge tone={statusTone(r.status)}>{STATUS_LABEL[r.status]}</Badge>
                    </div>
                    <div className="mt-1 h-2 w-full rounded-full bg-charcoal-800">
                      <div
                        className="h-2 rounded-full bg-teal-500/60"
                        style={{ marginLeft: `${left}%`, width: `${width}%` }}
                      />
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                      {r.start_date ?? "—"}{r.end_date ? ` → ${r.end_date}` : ""}
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </div>
    </section>
  );
}
