import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireProfile, requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DtrCsvButton } from "./DtrCsvButton";
import { ImportDtrControl, type ImportDtrState } from "./ImportDtrControl";
import { NewRequestForm } from "@/components/daily-logs/NewRequestForm";
import { SubmitReportForm } from "@/components/daily-logs/SubmitReportForm";
import { StatusChart } from "@/components/daily-logs/StatusChart";
import {
  DAY_STATUSES,
  attendanceCredit,
  isDayStatus,
  requestOverviewKey,
  statusLabel,
  statusTone,
} from "@/lib/hr/status";
import {
  REQUEST_LABELS,
  REQUEST_STATUS_TONES,
  REQUEST_TONES,
  requestSummary,
  type DailyLogRequest,
  type RequestStatus,
} from "@/lib/hr/requests";
import { summarize, type AttendanceLite } from "@/lib/hr/aggregate";
import {
  DEFAULT_SCHEDULE,
  computeLateMinutes,
  computeTotalHours,
  computeUndertimeMinutes,
  fmtMinutes,
  fmtTime,
  isDate,
  isMonth,
  manilaMonth,
  manilaToday,
  monthRange,
  shiftDate,
} from "@/lib/hr/time";

// Daily Logs — the renamed Attendance module. It carries: a live dashboard
// (Contractor Status Overview + Daily Summary), the self-service clock + day
// status + Daily Report submission, the online request forms and their approval
// queue, a monthly attendance summary, and the leadership Team worksheet. Time
// (late / undertime / total hours) is computed automatically from scheduled vs
// actual punches; overtime, leave, holiday and rest-day totals come only from
// APPROVED requests. All reads are RLS-scoped, so a team member sees their own
// numbers and leadership / department heads see the whole team.

type AttendanceRow = {
  id: string;
  user_id: string;
  work_date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: string | null;
  note: string | null;
  scheduled_in: string | null;
  scheduled_out: string | null;
  late_minutes: number | null;
  undertime_minutes: number | null;
  overtime_minutes: number | null;
  total_hours: number | null;
  report_submitted: boolean | null;
  report_id: string | null;
};
type Person = {
  id: string;
  full_name: string;
  email: string;
  department_id: string | null;
  contractor_code: string | null;
};
type Dept = { id: string; name: string };

const ATT_COLS =
  "id, user_id, work_date, clock_in, clock_out, status, note, scheduled_in, scheduled_out, late_minutes, undertime_minutes, overtime_minutes, total_hours, report_submitted, report_id";

// `attendance` / `daily_log_requests` aren't in the generated types, so writes
// go through this shim — same pattern as Finance / Payroll / Recruitment.
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown> | Record<string, unknown>[]) => Promise<unknown>;
    upsert: (
      v: Record<string, unknown> | Record<string, unknown>[],
      opts?: Record<string, unknown>
    ) => Promise<unknown>;
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => Promise<unknown>;
      match: (q: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

// Split one CSV line into fields, honouring double-quoted fields and "" escapes.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// --- Self-service actions (any signed-in user, own row only) ---------------

async function clockIn() {
  "use server";
  const profile = await requireProfile();
  const today = manilaToday();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const { data } = await supabase
    .from("attendance")
    .select("id, scheduled_in, scheduled_out, clock_out, status")
    .eq("user_id", profile.id)
    .eq("work_date", today)
    .maybeSingle();
  const existing = data as unknown as {
    id: string;
    scheduled_in: string | null;
    scheduled_out: string | null;
    clock_out: string | null;
    status: string | null;
  } | null;

  const now = new Date().toISOString();
  const schedIn = existing?.scheduled_in ?? DEFAULT_SCHEDULE.in;
  const schedOut = existing?.scheduled_out ?? DEFAULT_SCHEDULE.out;
  const late = computeLateMinutes(schedIn, now);

  if (existing) {
    await db
      .from("attendance")
      .update({
        clock_in: now,
        scheduled_in: schedIn,
        scheduled_out: schedOut,
        late_minutes: late,
        undertime_minutes: computeUndertimeMinutes(schedOut, existing.clock_out),
        total_hours: computeTotalHours(now, existing.clock_out),
        org_id: profile.org_id,
        ...(existing.status ? {} : { status: "present" }),
      })
      .eq("id", existing.id);
  } else {
    await db.from("attendance").insert({
      org_id: profile.org_id,
      user_id: profile.id,
      work_date: today,
      clock_in: now,
      status: "present",
      scheduled_in: schedIn,
      scheduled_out: schedOut,
      late_minutes: late,
    });
  }
  revalidatePath("/attendance");
}

async function clockOut() {
  "use server";
  const profile = await requireProfile();
  const today = manilaToday();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const { data } = await supabase
    .from("attendance")
    .select("id, scheduled_in, scheduled_out, clock_in")
    .eq("user_id", profile.id)
    .eq("work_date", today)
    .maybeSingle();
  const existing = data as unknown as {
    id: string;
    scheduled_in: string | null;
    scheduled_out: string | null;
    clock_in: string | null;
  } | null;

  const now = new Date().toISOString();
  const schedOut = existing?.scheduled_out ?? DEFAULT_SCHEDULE.out;

  if (existing) {
    await db
      .from("attendance")
      .update({
        clock_out: now,
        scheduled_out: schedOut,
        undertime_minutes: computeUndertimeMinutes(schedOut, now),
        total_hours: computeTotalHours(existing.clock_in, now),
      })
      .eq("id", existing.id);
  } else {
    await db.from("attendance").insert({
      org_id: profile.org_id,
      user_id: profile.id,
      work_date: today,
      clock_out: now,
      status: "present",
      scheduled_out: schedOut,
    });
  }
  revalidatePath("/attendance");
}

async function setMyStatus(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const status = String(formData.get("status") ?? "");
  if (!isDayStatus(status)) return;
  const note = String(formData.get("note") ?? "").trim();
  const today = manilaToday();

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("attendance").upsert(
    {
      org_id: profile.org_id,
      user_id: profile.id,
      work_date: today,
      status,
      note: note || null,
    },
    { onConflict: "user_id,work_date" }
  );
  revalidatePath("/attendance");
}

// --- Request decisions ------------------------------------------------------

async function decideRequest(formData: FormData) {
  "use server";
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id || (decision !== "approved" && decision !== "rejected")) return;

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("daily_log_requests")
    .update({
      status: decision,
      approver_id: profile.id,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .match({ id, status: "pending" });
  revalidatePath("/attendance");
  revalidatePath("/payroll");
}

async function cancelRequest(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("daily_log_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .match({ id, user_id: profile.id, status: "pending" });
  revalidatePath("/attendance");
}

// --- Team DTR action (ceo/coo only) ----------------------------------------

async function saveDtr(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as { org_id: string };
  const workDate = String(formData.get("work_date") ?? "");
  if (!isDate(workDate)) return;
  const markAllPresent = String(formData.get("intent") ?? "") === "mark_all_present";

  const supabase = createServerSupabaseClient();
  const [{ data: userRows }, { data: attRows }] = await Promise.all([
    supabase.from("users").select("id").eq("org_id", profile.org_id),
    supabase
      .from("attendance")
      .select("user_id, clock_in, clock_out")
      .eq("work_date", workDate),
  ]);
  const users = (userRows ?? []) as unknown as { id: string }[];
  const punchByUser = new Map(
    ((attRows ?? []) as unknown as { user_id: string; clock_in: string | null; clock_out: string | null }[]).map(
      (r) => [r.user_id, r]
    )
  );

  const rows: Record<string, unknown>[] = [];
  for (const u of users) {
    let status = String(formData.get(`status_${u.id}`) ?? "").trim();
    if (!status && markAllPresent) status = "present";
    const schedIn = String(formData.get(`sched_in_${u.id}`) ?? "").trim() || null;
    const schedOut = String(formData.get(`sched_out_${u.id}`) ?? "").trim() || null;
    const note = String(formData.get(`note_${u.id}`) ?? "").trim();
    // Blank status AND no schedule = leave the row alone entirely.
    if ((!status || !isDayStatus(status)) && !schedIn && !schedOut) continue;

    const punch = punchByUser.get(u.id);
    const row: Record<string, unknown> = {
      org_id: profile.org_id,
      user_id: u.id,
      work_date: workDate,
      note: note || null,
    };
    if (status && isDayStatus(status)) row.status = status;
    if (schedIn || schedOut) {
      row.scheduled_in = schedIn;
      row.scheduled_out = schedOut;
      // Recompute time against the (possibly new) schedule and existing punches.
      row.late_minutes = computeLateMinutes(schedIn, punch?.clock_in ?? null);
      row.undertime_minutes = computeUndertimeMinutes(schedOut, punch?.clock_out ?? null);
      row.total_hours = computeTotalHours(punch?.clock_in ?? null, punch?.clock_out ?? null);
    }
    rows.push(row);
  }

  if (rows.length > 0) {
    await (supabase as unknown as DbShim)
      .from("attendance")
      .upsert(rows, { onConflict: "user_id,work_date" });
  }
  revalidatePath("/attendance");
}

// Bulk-import a DTR CSV (header: email,work_date,status,note). Only status/note
// are written on conflict, so punches are left untouched. Shaped for useFormState.
async function importDTR(_prev: ImportDtrState, formData: FormData): Promise<ImportDtrState> {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as { org_id: string };

  const file = formData.get("file");
  let text = "";
  if (file && typeof file !== "string" && file.size > 0) {
    text = await file.text();
  } else {
    text = String(formData.get("csv") ?? "");
  }

  const skipped: string[] = [];
  if (!text.trim()) return { imported: 0, skipped };

  const supabase = createServerSupabaseClient();
  const { data: userRows } = await supabase
    .from("users")
    .select("id, email")
    .eq("org_id", profile.org_id);
  const users = (userRows ?? []) as unknown as { id: string; email: string }[];
  const idByEmail = new Map(
    users.filter((u) => u.email).map((u) => [u.email.toLowerCase(), u.id])
  );

  const rowByKey = new Map<string, Record<string, unknown>>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cols = parseCsvLine(raw);
    const email = (cols[0] ?? "").trim();
    if (email.toLowerCase() === "email") continue;
    const workDate = (cols[1] ?? "").trim();
    const status = (cols[2] ?? "").trim().toLowerCase();
    const note = (cols[3] ?? "").trim();

    const userId = idByEmail.get(email.toLowerCase());
    if (!userId) {
      skipped.push(`unknown email ${email || "(blank)"}`);
      continue;
    }
    if (!isDate(workDate) || !isDayStatus(status)) {
      skipped.push(`invalid row ${email} ${workDate || "(no date)"} ${status || "(no status)"}`);
      continue;
    }
    rowByKey.set(`${userId}|${workDate}`, {
      org_id: profile.org_id,
      user_id: userId,
      work_date: workDate,
      status,
      note: note || null,
    });
  }

  const rows = Array.from(rowByKey.values());
  if (rows.length > 0) {
    await (supabase as unknown as DbShim)
      .from("attendance")
      .upsert(rows, { onConflict: "user_id,work_date" });
  }
  revalidatePath("/attendance");
  return { imported: rows.length, skipped };
}

// --- Page ------------------------------------------------------------------

export default async function DailyLogsPage({
  searchParams,
}: {
  searchParams: { date?: string; month?: string };
}) {
  const profile = await requireModule("/attendance");
  const canViewTeam =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const canWriteTeam = profile.role === "ceo" || profile.role === "coo";
  const canApprove = canViewTeam; // supervisor / leadership decide requests

  const today = manilaToday();
  const selectedDate = isDate(searchParams.date) ? (searchParams.date as string) : today;
  const selectedMonth = isMonth(searchParams.month) ? (searchParams.month as string) : manilaMonth();
  const { start: monthStart, end: monthEnd } = monthRange(selectedMonth);
  const cutoff = shiftDate(today, -13);
  const exportFrom = shiftDate(today, -29);
  const exportTo = today;

  const supabase = createServerSupabaseClient();

  const [usersRes, deptRes, todayRes, myRes, selectedRes, exportRes, requestsRes, monthRes] =
    await Promise.all([
      supabase
        .from("users")
        .select("id, full_name, email, department_id, contractor_code")
        .order("full_name"),
      supabase.from("departments").select("id, name").order("name"),
      supabase.from("attendance").select(ATT_COLS).eq("work_date", today),
      supabase
        .from("attendance")
        .select(ATT_COLS)
        .eq("user_id", profile.id)
        .gte("work_date", cutoff)
        .lte("work_date", today)
        .order("work_date", { ascending: false }),
      canViewTeam && selectedDate !== today
        ? supabase.from("attendance").select(ATT_COLS).eq("work_date", selectedDate)
        : Promise.resolve({ data: null }),
      canWriteTeam
        ? supabase
            .from("attendance")
            .select(ATT_COLS)
            .gte("work_date", exportFrom)
            .lte("work_date", exportTo)
            .order("work_date")
        : Promise.resolve({ data: null }),
      supabase
        .from("daily_log_requests")
        .select(
          "id, org_id, user_id, request_type, leave_type, work_date, start_time, end_time, time_out, total_hours, duration, purpose, expected_return, reason, remarks, status, approver_id, decided_at, created_at"
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("attendance")
        .select(ATT_COLS)
        .gte("work_date", monthStart)
        .lte("work_date", monthEnd),
    ]);

  const people = (usersRes.data ?? []) as unknown as Person[];
  const departments = (deptRes.data ?? []) as unknown as Dept[];
  const todayRows = (todayRes.data ?? []) as unknown as AttendanceRow[];
  const myRows = (myRes.data ?? []) as unknown as AttendanceRow[];
  const selectedRows =
    selectedDate === today ? todayRows : ((selectedRes.data ?? []) as unknown as AttendanceRow[]);
  const requests = (requestsRes.data ?? []) as unknown as DailyLogRequest[];
  const monthRows = (monthRes.data ?? []) as unknown as AttendanceRow[];

  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const personById = new Map(people.map((p) => [p.id, p]));
  const userName = (id: string | null) => (id ? personById.get(id)?.full_name ?? "—" : "—");
  const myToday = myRows.find((r) => r.work_date === today) ?? null;
  const selectedByUser = new Map(selectedRows.map((r) => [r.user_id, r]));

  // ── Dashboard: Contractor Status Overview ────────────────────────────────
  const approvedToday = requests.filter((r) => r.status === "approved" && r.work_date === today);
  const bucketUsers: Record<string, Set<string>> = {
    on_leave: new Set(),
    ooo: new Set(),
    rest_day: new Set(),
    holiday_duty: new Set(),
  };
  for (const r of approvedToday) {
    const key = requestOverviewKey(r);
    if (key && key in bucketUsers) bucketUsers[key].add(r.user_id);
  }
  for (const r of todayRows) {
    if (r.status === "on_leave") bucketUsers.on_leave.add(r.user_id);
  }
  const totalActive = people.length;
  const loggedInToday = todayRows.filter((r) => r.clock_in).length;
  const absentToday = todayRows.filter((r) => r.status === "absent").length;
  const remoteToday = todayRows.filter((r) => r.status === "working_remotely").length;
  const onLeave = bucketUsers.on_leave.size;
  const oooToday = bucketUsers.ooo.size;
  const restDayToday = bucketUsers.rest_day.size;
  const holidayDutyToday = bucketUsers.holiday_duty.size;

  // ── Dashboard: Daily Summary ─────────────────────────────────────────────
  const totalLate = todayRows.reduce((a, r) => a + Number(r.late_minutes ?? 0), 0);
  const totalUndertime = todayRows.reduce((a, r) => a + Number(r.undertime_minutes ?? 0), 0);
  const totalOvertime = approvedToday
    .filter((r) => r.request_type === "overtime")
    .reduce((a, r) => a + Math.round(Number(r.total_hours ?? 0) * 60), 0);
  const completedReports = todayRows.filter((r) => r.report_submitted).length;
  const pendingReports = todayRows.filter((r) => r.clock_in && !r.report_submitted).length;

  // Today's report/log reconciliation flags (self for team member, team for others).
  const flagRows = todayRows
    .map((r) => {
      const loggedIn = !!r.clock_in;
      const reported = !!r.report_submitted;
      let flag: { label: string; tone: "teal" | "amber" | "red" | "muted" };
      if (loggedIn && reported) flag = { label: "Complete", tone: "teal" };
      else if (loggedIn && !reported) flag = { label: "Logged in, no report", tone: "amber" };
      else if (!loggedIn && reported) flag = { label: "Report submitted, no log", tone: "red" };
      else flag = { label: "Pending submission", tone: "muted" };
      return { row: r, flag };
    })
    .sort((a, b) => userName(a.row.user_id).localeCompare(userName(b.row.user_id)));

  const statusSegments = [
    { label: "Logged in", value: loggedInToday, color: "bg-teal-500" },
    { label: "Working remotely", value: remoteToday, color: "bg-green-500" },
    { label: "On leave", value: onLeave, color: "bg-violet-500" },
    { label: "OOO", value: oooToday, color: "bg-ink-dim" },
    { label: "Rest day", value: restDayToday, color: "bg-sky-500" },
    { label: "Holiday duty", value: holidayDutyToday, color: "bg-amber-500" },
    { label: "Absent", value: absentToday, color: "bg-red-500" },
  ];

  // ── Monthly Attendance Summary ───────────────────────────────────────────
  const monthAtt: AttendanceLite[] = monthRows.map((r) => ({
    user_id: r.user_id,
    work_date: r.work_date,
    status: r.status,
    clock_in: r.clock_in,
    clock_out: r.clock_out,
    late_minutes: r.late_minutes,
    undertime_minutes: r.undertime_minutes,
    total_hours: r.total_hours,
    report_submitted: r.report_submitted,
    report_id: r.report_id,
  }));
  const monthReq = requests.filter(
    (r) => r.work_date && r.work_date >= monthStart && r.work_date <= monthEnd
  );
  // Team member sees only their own summary row; others see everyone with activity.
  const summaryUserIds = canViewTeam ? people.map((p) => p.id) : [profile.id];
  const summary = summarize(summaryUserIds, monthAtt, monthReq);
  const summaryRows = summaryUserIds
    .map((id) => ({ id, s: summary.get(id)! }))
    .filter((r) => r.s)
    .sort((a, b) => userName(a.id).localeCompare(userName(b.id)));
  const totalWorkingDays = summaryRows.reduce((a, r) => a + r.s.workingDays, 0);

  // ── Requests: my own + pending queue for approvers ───────────────────────
  const myRequests = requests.filter((r) => r.user_id === profile.id).slice(0, 12);
  const pendingQueue = requests.filter((r) => r.status === "pending");

  const exportRows = ((exportRes.data ?? []) as unknown as AttendanceRow[]).map((r) => {
    const person = personById.get(r.user_id);
    return {
      email: person?.email ?? "",
      full_name: person?.full_name ?? "",
      work_date: r.work_date,
      status: r.status ?? "",
      clock_in: r.clock_in ?? "",
      clock_out: r.clock_out ?? "",
      note: r.note ?? "",
    };
  });

  const prevDate = shiftDate(selectedDate, -1);
  const nextDate = shiftDate(selectedDate, 1);
  const myStatusDefault = (myToday?.status as string | undefined) ?? "present";
  const prevMonthNav = monthRange(shiftDate(monthStart, -1).slice(0, 7));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Daily Logs"]} profile={profile}>
      <PageHeader
        title="Daily Logs"
        subtitle="Clock in and out, file requests, submit your Daily Report — and, for leadership, keep the team's daily time record. Late, undertime and hours compute automatically."
      />

      {/* ── DASHBOARD ─────────────────────────────────────────────────────── */}
      <h2 className="mb-3 text-sm font-semibold text-ink">Contractor Status Overview · today</h2>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <StatTile label="Total Active" value={totalActive} hint="Contractors" />
        <StatTile label="Logged In" value={loggedInToday} hint="Clocked in today" />
        <StatTile label="Absent" value={absentToday} />
        <StatTile label="On Leave" value={onLeave} />
        <StatTile label="OOO" value={oooToday} hint="Out of office" />
        <StatTile label="Rest Day" value={restDayToday} />
        <StatTile label="Holiday Duty" value={holidayDutyToday} />
        <StatTile label="Working Remotely" value={remoteToday} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <SectionCard title="Status distribution">
          <StatusChart segments={statusSegments} />
        </SectionCard>
        <SectionCard title="Daily Summary">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTile label="Total Late" value={fmtMinutes(totalLate)} hint="today" />
            <StatTile label="Total Undertime" value={fmtMinutes(totalUndertime)} hint="today" />
            <StatTile label="Total Overtime" value={fmtMinutes(totalOvertime)} hint="approved" />
            <StatTile label="Pending Reports" value={pendingReports} hint="logged in, no report" />
            <StatTile label="Completed Reports" value={completedReports} hint="report on file" />
          </div>
        </SectionCard>
      </div>

      {/* Report vs log reconciliation */}
      {flagRows.length > 0 && (
        <SectionCard title="Daily Logs ↔ Daily Reports · today" className="mb-8">
          <TableShell columns={["Contractor", "Code", "In", "Out", "Report", "Workday"]}>
            {flagRows.map(({ row, flag }) => {
              const p = personById.get(row.user_id);
              return (
                <tr key={row.id} className={rowClass}>
                  <td className="p-3 text-ink">{userName(row.user_id)}</td>
                  <td className="p-3 font-mono text-xs text-teal-300">{p?.contractor_code ?? "—"}</td>
                  <td className="p-3 font-mono text-ink-muted">{fmtTime(row.clock_in)}</td>
                  <td className="p-3 font-mono text-ink-muted">{fmtTime(row.clock_out)}</td>
                  <td className="p-3">
                    {row.report_submitted ? (
                      <Badge tone="teal">Submitted</Badge>
                    ) : (
                      <span className="text-ink-dim">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <Badge tone={flag.tone}>{flag.label}</Badge>
                  </td>
                </tr>
              );
            })}
          </TableShell>
        </SectionCard>
      )}

      {/* ── MY DAY ────────────────────────────────────────────────────────── */}
      <h2 className="mb-3 text-sm font-semibold text-ink">My Day</h2>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title={`Today · ${today}`}>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={statusTone(myToday?.status ?? null)}>
              {myToday?.status ? statusLabel(myToday.status) : "No record yet"}
            </Badge>
            <span className="font-mono text-sm text-ink-muted">
              In: <span className="text-ink">{fmtTime(myToday?.clock_in ?? null)}</span>
            </span>
            <span className="font-mono text-sm text-ink-muted">
              Out: <span className="text-ink">{fmtTime(myToday?.clock_out ?? null)}</span>
            </span>
            {myToday?.late_minutes ? (
              <Badge tone="amber">Late {fmtMinutes(myToday.late_minutes)}</Badge>
            ) : null}
            {myToday?.total_hours ? (
              <span className="font-mono text-xs text-ink-muted">{myToday.total_hours}h</span>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <form action={clockIn}>
              <button
                type="submit"
                className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
              >
                Clock In
              </button>
            </form>
            <form action={clockOut}>
              <button
                type="submit"
                className="rounded-md bg-charcoal-800 px-4 py-2 text-sm font-semibold text-teal-300 hover:bg-charcoal-700"
              >
                Clock Out
              </button>
            </form>
          </div>

          <form action={setMyStatus} className="mt-4 grid items-end gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <label className="text-[11px] text-ink-muted">
              Set day status
              <select
                name="status"
                defaultValue={myStatusDefault}
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
              >
                {DAY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-muted">
              Note (optional)
              <input
                name="note"
                defaultValue={myToday?.note ?? ""}
                placeholder="e.g. clinic in the morning"
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-teal-300 hover:bg-charcoal-700"
            >
              Save status
            </button>
          </form>
        </SectionCard>

        <SectionCard
          title="Submit Daily Report"
          action={
            myToday?.report_submitted ? <Badge tone="teal">On file</Badge> : <Badge tone="amber">Not yet</Badge>
          }
        >
          <SubmitReportForm today={today} alreadySubmitted={!!myToday?.report_submitted} />
        </SectionCard>
      </div>

      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
        My last 14 days
      </h3>
      <TableShell
        className="mb-8"
        columns={["Date", "Status", "In", "Out", "Late", "Undertime", "Hours", "Report"]}
      >
        {myRows.length === 0 && (
          <tr>
            <td colSpan={8} className="p-4 text-ink-muted">
              No daily logs in the last 14 days.
            </td>
          </tr>
        )}
        {myRows.map((r) => (
          <tr key={r.id} className={rowClass}>
            <td className="p-3 font-mono text-xs text-ink-muted">{r.work_date}</td>
            <td className="p-3">
              <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
            </td>
            <td className="p-3 font-mono text-ink-muted">{fmtTime(r.clock_in)}</td>
            <td className="p-3 font-mono text-ink-muted">{fmtTime(r.clock_out)}</td>
            <td className="p-3 text-ink-muted">{fmtMinutes(r.late_minutes)}</td>
            <td className="p-3 text-ink-muted">{fmtMinutes(r.undertime_minutes)}</td>
            <td className="p-3 font-mono text-ink-muted">{r.total_hours != null ? `${r.total_hours}h` : "—"}</td>
            <td className="p-3">
              {r.report_submitted ? <Badge tone="teal">✓</Badge> : <span className="text-ink-dim">—</span>}
            </td>
          </tr>
        ))}
      </TableShell>

      {/* ── ONLINE REQUESTS ───────────────────────────────────────────────── */}
      <h2 className="mb-3 text-sm font-semibold text-ink">Online Requests</h2>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title="File a request">
          <NewRequestForm today={today} />
        </SectionCard>

        <SectionCard title="My requests">
          <div className="overflow-x-auto">
            {myRequests.length === 0 ? (
              <p className="py-4 text-sm text-ink-muted">You haven't filed any requests yet.</p>
            ) : (
              <ul className="divide-y divide-charcoal-700/60">
                {myRequests.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge tone={REQUEST_TONES[r.request_type]}>
                          {REQUEST_LABELS[r.request_type]}
                        </Badge>
                        <Badge tone={REQUEST_STATUS_TONES[r.status as RequestStatus] ?? "muted"}>
                          {r.status}
                        </Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-ink-muted">{requestSummary(r)}</p>
                    </div>
                    {r.status === "pending" && (
                      <form action={cancelRequest}>
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-red-300 hover:bg-charcoal-700"
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>
      </div>

      {canApprove && (
        <SectionCard
          title="Approval queue"
          action={<Badge tone={pendingQueue.length ? "amber" : "muted"}>{pendingQueue.length} pending</Badge>}
          className="mb-8"
        >
          <div className="overflow-x-auto">
            {pendingQueue.length === 0 ? (
              <p className="py-4 text-sm text-ink-muted">Nothing awaiting a decision.</p>
            ) : (
              <TableShell columns={["Contractor", "Type", "Details", "Filed", "Decision"]}>
                {pendingQueue.map((r) => (
                  <tr key={r.id} className={rowClass}>
                    <td className="p-3 text-ink">{userName(r.user_id)}</td>
                    <td className="p-3">
                      <Badge tone={REQUEST_TONES[r.request_type]}>{REQUEST_LABELS[r.request_type]}</Badge>
                    </td>
                    <td className="p-3 text-ink-muted">{requestSummary(r)}</td>
                    <td className="p-3 font-mono text-[11px] text-ink-dim">{r.created_at.slice(0, 10)}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <form action={decideRequest}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="decision" value="approved" />
                          <button
                            type="submit"
                            className="rounded-md bg-green-500/90 px-2.5 py-1 text-xs font-medium text-charcoal-950 hover:bg-green-400"
                          >
                            Approve
                          </button>
                        </form>
                        <form action={decideRequest}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="decision" value="rejected" />
                          <button
                            type="submit"
                            className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
                          >
                            Reject
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </TableShell>
            )}
          </div>
        </SectionCard>
      )}

      {/* ── MONTHLY ATTENDANCE SUMMARY ────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">
          Monthly Attendance Summary <span className="font-mono text-[11px] text-ink-dim">· {selectedMonth}</span>
        </h2>
        <div className="flex items-center gap-2">
          <Link
            href={`/attendance?month=${prevMonthNav.start.slice(0, 7)}`}
            className="rounded-md bg-charcoal-800 px-2.5 py-1.5 text-xs text-ink-muted hover:bg-charcoal-700"
          >
            ← Prev month
          </Link>
          <form action="/attendance" method="get" className="flex items-center gap-2">
            <input
              name="month"
              type="month"
              defaultValue={selectedMonth}
              className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-sm text-ink"
            />
            <button
              type="submit"
              className="rounded-md bg-charcoal-800 px-2.5 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700"
            >
              Go
            </button>
          </form>
        </div>
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        Total working days this month: <span className="font-mono text-ink">{totalWorkingDays}</span>
        {!canViewTeam && " · showing your own summary"}. Overtime, leave, holiday and rest-day totals
        come from approved requests only.
      </p>
      <TableShell
        className="mb-8"
        columns={[
          "Contractor",
          "Code",
          "Working Days",
          "Late",
          "Undertime",
          "Overtime",
          "Hours",
          "Leave",
          "Holiday",
          "Rest Day",
        ]}
      >
        {summaryRows.length === 0 && (
          <tr>
            <td colSpan={10} className="p-4 text-ink-muted">
              No attendance recorded this month.
            </td>
          </tr>
        )}
        {summaryRows.map(({ id, s }) => {
          const p = personById.get(id);
          return (
            <tr key={id} className={rowClass}>
              <td className="p-3 text-ink">{userName(id)}</td>
              <td className="p-3 font-mono text-xs text-teal-300">{p?.contractor_code ?? "—"}</td>
              <td className="p-3 font-mono text-ink">{s.workingDays}</td>
              <td className="p-3 text-ink-muted">{fmtMinutes(s.lateMinutes)}</td>
              <td className="p-3 text-ink-muted">{fmtMinutes(s.undertimeMinutes)}</td>
              <td className="p-3 text-ink-muted">{fmtMinutes(s.overtimeMinutes)}</td>
              <td className="p-3 font-mono text-ink-muted">{s.totalHours}h</td>
              <td className="p-3 font-mono text-ink-muted">{s.approvedLeaveDays}</td>
              <td className="p-3 font-mono text-ink-muted">{s.holidayDutyDays}</td>
              <td className="p-3 font-mono text-ink-muted">{s.restDayDutyDays}</td>
            </tr>
          );
        })}
      </TableShell>

      {/* ── TEAM DAILY TIME RECORD ────────────────────────────────────────── */}
      {canViewTeam && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">Team Daily Time Record</h2>
            <div className="flex flex-wrap items-center gap-2">
              {canWriteTeam && (
                <DtrCsvButton rows={exportRows} filename={`dtr_${exportFrom}_${exportTo}.csv`} />
              )}
              <Link
                href={`/attendance?date=${prevDate}`}
                className="rounded-md bg-charcoal-800 px-2.5 py-1.5 text-xs text-ink-muted hover:bg-charcoal-700"
              >
                ← Prev
              </Link>
              <form action="/attendance" method="get" className="flex items-center gap-2">
                <input
                  name="date"
                  type="date"
                  defaultValue={selectedDate}
                  className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-sm text-ink"
                />
                <button
                  type="submit"
                  className="rounded-md bg-charcoal-800 px-2.5 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700"
                >
                  Go
                </button>
              </form>
              <Link
                href={`/attendance?date=${nextDate}`}
                className="rounded-md bg-charcoal-800 px-2.5 py-1.5 text-xs text-ink-muted hover:bg-charcoal-700"
              >
                Next →
              </Link>
            </div>
          </div>

          {canWriteTeam && (
            <SectionCard title="Import DTR (CSV)" className="mb-4">
              <p className="mb-3 text-xs text-ink-muted">
                Bulk-set status and notes from a spreadsheet. Rows upsert on (person, date); existing
                punches are left untouched. Unknown emails and invalid rows are skipped and reported.
              </p>
              <ImportDtrControl action={importDTR} />
            </SectionCard>
          )}

          {canWriteTeam ? (
            <form action={saveDtr}>
              <input type="hidden" name="work_date" value={selectedDate} />
              <TableShell
                columns={["Name", "Department", "Sched In", "Sched Out", "Status", "Note"]}
              >
                {people.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-4 text-ink-muted">
                      No people in the org yet.
                    </td>
                  </tr>
                )}
                {people.map((p) => {
                  const row = selectedByUser.get(p.id);
                  return (
                    <tr key={p.id} className={rowClass}>
                      <td className="p-3 text-ink">
                        {p.full_name}
                        {p.contractor_code && (
                          <span className="ml-2 font-mono text-[10px] text-teal-300">
                            {p.contractor_code}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-ink-muted">
                        {p.department_id ? deptName.get(p.department_id) ?? "—" : "—"}
                      </td>
                      <td className="p-3">
                        <input
                          name={`sched_in_${p.id}`}
                          type="time"
                          defaultValue={row?.scheduled_in ?? ""}
                          className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                        />
                      </td>
                      <td className="p-3">
                        <input
                          name={`sched_out_${p.id}`}
                          type="time"
                          defaultValue={row?.scheduled_out ?? ""}
                          className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                        />
                      </td>
                      <td className="p-3">
                        <select
                          name={`status_${p.id}`}
                          defaultValue={row?.status ?? ""}
                          className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                        >
                          <option value="">— no record —</option>
                          {DAY_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {statusLabel(s)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-3">
                        <input
                          name={`note_${p.id}`}
                          defaultValue={row?.note ?? ""}
                          placeholder="Note"
                          className="w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                        />
                      </td>
                    </tr>
                  );
                })}
              </TableShell>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  name="intent"
                  value="save"
                  className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
                >
                  Save DTR
                </button>
                <button
                  type="submit"
                  name="intent"
                  value="mark_all_present"
                  className="rounded-md bg-charcoal-800 px-4 py-2 text-sm font-semibold text-teal-300 hover:bg-charcoal-700"
                >
                  Mark all present &amp; save
                </button>
              </div>
            </form>
          ) : (
            <TableShell columns={["Name", "Department", "Status", "In", "Out", "Late", "Hours"]}>
              {people.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-4 text-ink-muted">
                    No people in the org yet.
                  </td>
                </tr>
              )}
              {people.map((p) => {
                const row = selectedByUser.get(p.id);
                return (
                  <tr key={p.id} className={rowClass}>
                    <td className="p-3 text-ink">{p.full_name}</td>
                    <td className="p-3 text-ink-muted">
                      {p.department_id ? deptName.get(p.department_id) ?? "—" : "—"}
                    </td>
                    <td className="p-3">
                      {row?.status ? (
                        <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
                      ) : (
                        <span className="text-ink-dim">—</span>
                      )}
                    </td>
                    <td className="p-3 font-mono text-ink-muted">{fmtTime(row?.clock_in ?? null)}</td>
                    <td className="p-3 font-mono text-ink-muted">{fmtTime(row?.clock_out ?? null)}</td>
                    <td className="p-3 text-ink-muted">{fmtMinutes(row?.late_minutes)}</td>
                    <td className="p-3 font-mono text-ink-muted">
                      {row?.total_hours != null ? `${row.total_hours}h` : "—"}
                    </td>
                  </tr>
                );
              })}
            </TableShell>
          )}

          <p className="mt-3 text-xs text-ink-muted">
            Late and undertime compute from each day's scheduled vs actual punches (default schedule
            {" "}
            {DEFAULT_SCHEDULE.in}–{DEFAULT_SCHEDULE.out} unless set above). Overtime is credited only
            from approved overtime requests. Payroll reads these same numbers — no manual reconciliation.
          </p>
        </>
      )}
    </AppShell>
  );
}
