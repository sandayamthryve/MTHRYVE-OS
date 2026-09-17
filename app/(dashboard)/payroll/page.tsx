import { requireModule } from "@/lib/auth/session";
import { randomUUID } from "crypto";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ExportCsvButton } from "./ExportCsvButton";
import { summarize, type AttendanceLite } from "@/lib/hr/aggregate";
import { fmtMinutes } from "@/lib/hr/time";
import type { DailyLogRequest } from "@/lib/hr/requests";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// Payroll Worksheet — the PDF grants Finance module access; payroll mutation
// actions remain separately gated to leadership. It ties per-user
// compensation config to attendance to produce a payroll register, then posts
// the run's total net into Finance as a single Salaries & Wages opex entry.

type PayType = "monthly" | "daily" | "hourly";
type RunStatus = "draft" | "posted";

type User = { id: string; full_name: string };
type Compensation = {
  user_id: string;
  pay_type: PayType;
  base_rate: number | null;
  allowance: number | null;
  currency: string | null;
};
type PayrollRun = {
  id: string;
  period_start: string | null;
  period_end: string | null;
  status: RunStatus;
  total: number | null;
  finance_entry_id: string | null;
  archived_at: string | null;
};
type PayrollItem = {
  id: string;
  run_id: string;
  user_id: string;
  full_name: string;
  pay_type: PayType;
  base: number | null;
  days_present: number | null;
  allowance: number | null;
  deductions: number | null;
  gross: number | null;
  net: number | null;
  note: string | null;
};
type Attendance = { user_id: string; work_date: string; status: string };

// The People-master compensation now lives on users (base_pay, frequency,
// commission). Payroll reads it here rather than storing its own copy.
type UserComp = {
  id: string;
  full_name: string;
  base_pay: number | null;
  compensation_frequency: string | null;
  commission_structure: string | null;
};

// The Daily-Logs / approved-request numbers pulled into each payroll line item,
// stashed in payroll_items.note (jsonb-as-text) so the register stays
// schema-stable while carrying the full breakdown.
type PayrollMeta = {
  frequency?: string | null;
  daysWorked?: number;
  approvedLeave?: number;
  lateMinutes?: number;
  undertimeMinutes?: number;
  overtimeMinutes?: number;
  holidayDuty?: number;
  restDayDuty?: number;
  totalHours?: number;
  commission?: string | null;
};

function parseMeta(note: string | null): PayrollMeta | null {
  if (!note) return null;
  try {
    const m = JSON.parse(note) as PayrollMeta;
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

// Base pay for the period from the People-master base_pay + frequency. Hourly
// multiplies by hours actually worked, daily by working days; everything else
// (monthly / semi-monthly / bi-weekly / weekly / per project) is the flat period
// figure. Falls back to 0 when no base is set.
function payBaseFor(
  frequency: string | null,
  basePay: number | null,
  workingDays: number,
  totalHours: number
): number {
  const bp = Number(basePay ?? 0);
  if (!bp) return 0;
  const f = (frequency ?? "").toLowerCase();
  if (f.includes("hour")) return bp * totalHours;
  if (f.includes("dai") || f.includes("per day")) return bp * workingDays;
  return bp;
}

// These payroll tables aren't in the generated Supabase types, so writes go
// through this shim to keep insert/update/upsert/delete callable without `any`.
// Reads use the normal typed client and cast the result rows, matching Finance.
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown> | Record<string, unknown>[]) => Promise<unknown>;
    upsert: (
      v: Record<string, unknown>,
      opts?: Record<string, unknown>
    ) => Promise<unknown>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
    delete: () => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

function num(v: FormDataEntryValue | null): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isDate(s?: string): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// The base-rate label depends on how the employee is paid — the same field is a
// monthly salary, a per-day rate, or a per-hour rate.
const BASE_HINT: Record<PayType, string> = {
  monthly: "monthly salary",
  daily: "daily rate",
  hourly: "hourly rate",
};

// --- Server actions (all ceo/coo only) ------------------------------------

async function saveCompensation(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as {
    id: string;
    org_id: string;
  };
  const user_id = String(formData.get("user_id") ?? "");
  if (!user_id) return;
  const pt = String(formData.get("pay_type") ?? "monthly");
  const pay_type: PayType = pt === "daily" ? "daily" : pt === "hourly" ? "hourly" : "monthly";

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("compensation").upsert(
    {
      user_id,
      org_id: profile.org_id,
      pay_type,
      base_rate: num(formData.get("base_rate")),
      allowance: num(formData.get("allowance")),
      currency: "PHP",
    },
    { onConflict: "user_id" }
  );
  revalidatePath("/payroll");
}

async function generateRun(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as {
    id: string;
    org_id: string;
  };
  const period_start = String(formData.get("period_start") ?? "");
  const period_end = String(formData.get("period_end") ?? "");
  if (!isDate(period_start) || !isDate(period_end)) return;

  const supabase = createServerSupabaseClient();

  // Auto-pull the whole register from the People master + Daily Logs + approved
  // requests — no manual keying. `compensation` is kept as an allowance source
  // and a base fallback for anyone whose People base_pay isn't set yet.
  const [compRes, userRes, attRes, reqRes] = await Promise.all([
    supabase
      .from("compensation")
      .select("user_id, pay_type, base_rate, allowance, currency")
      .eq("org_id", profile.org_id),
    supabase
      .from("users")
      .select("id, full_name, base_pay, compensation_frequency, commission_structure")
      .eq("org_id", profile.org_id),
    supabase
      .from("attendance")
      .select("user_id, work_date, status, late_minutes, undertime_minutes, total_hours")
      .gte("work_date", period_start)
      .lte("work_date", period_end),
    supabase
      .from("daily_log_requests")
      .select("id, org_id, user_id, request_type, total_hours, work_date, status")
      .eq("status", "approved")
      .gte("work_date", period_start)
      .lte("work_date", period_end),
  ]);

  const comps = (compRes.data ?? []) as unknown as Compensation[];
  const users = (userRes.data ?? []) as unknown as UserComp[];
  const attendance = (attRes.data ?? []) as unknown as (Attendance & {
    late_minutes: number | null;
    undertime_minutes: number | null;
    total_hours: number | null;
  })[];
  const requests = (reqRes.data ?? []) as unknown as DailyLogRequest[];

  const compByUser = new Map(comps.map((c) => [c.user_id, c]));

  // Shared roll-up: working days + late/undertime/hours from punches, and
  // overtime / leave / holiday / rest-day from approved requests — the exact
  // same counting Daily Logs shows, so payroll and the logs never disagree.
  const attLite: AttendanceLite[] = attendance.map((a) => ({
    user_id: a.user_id,
    work_date: a.work_date,
    status: a.status,
    clock_in: null,
    clock_out: null,
    late_minutes: a.late_minutes,
    undertime_minutes: a.undertime_minutes,
    total_hours: a.total_hours,
    report_submitted: null,
    report_id: null,
  }));
  const summary = summarize(
    users.map((u) => u.id),
    attLite,
    requests
  );

  // Include anyone who has a People base_pay OR a legacy compensation row.
  const payable = users.filter((u) => u.base_pay != null || compByUser.has(u.id));

  const run_id = randomUUID();
  const items = payable.map((u) => {
    const s = summary.get(u.id)!;
    const c = compByUser.get(u.id);
    const days_present = s.workingDays;

    // Base: prefer the People master; fall back to the legacy compensation row.
    let base = payBaseFor(u.compensation_frequency, u.base_pay, days_present, s.totalHours);
    let pay_type = u.compensation_frequency ?? "—";
    if (u.base_pay == null && c) {
      const base_rate = Number(c.base_rate ?? 0);
      if (c.pay_type === "monthly") base = base_rate;
      else if (c.pay_type === "daily") base = base_rate * days_present;
      else base = base_rate * s.totalHours; // hourly × hours worked
      pay_type = c.pay_type;
    }

    const allowance = Number(c?.allowance ?? 0);
    const deductions = 0;
    const gross = base + allowance;
    const net = gross - deductions;

    const meta: PayrollMeta = {
      frequency: u.compensation_frequency ?? c?.pay_type ?? null,
      daysWorked: days_present,
      approvedLeave: s.approvedLeaveDays,
      lateMinutes: s.lateMinutes,
      undertimeMinutes: s.undertimeMinutes,
      overtimeMinutes: s.overtimeMinutes,
      holidayDuty: s.holidayDutyDays,
      restDayDuty: s.restDayDutyDays,
      totalHours: s.totalHours,
      commission: u.commission_structure ?? null,
    };

    return {
      id: randomUUID(),
      run_id,
      org_id: profile.org_id,
      user_id: u.id,
      full_name: u.full_name,
      pay_type,
      base,
      days_present,
      allowance,
      deductions,
      gross,
      net,
      note: JSON.stringify(meta),
    };
  });

  const total = items.reduce((a, i) => a + i.net, 0);

  const db = supabase as unknown as DbShim;
  await db.from("payroll_runs").insert({
    id: run_id,
    org_id: profile.org_id,
    period_start,
    period_end,
    status: "draft",
    total,
    finance_entry_id: null,
    created_by: profile.id,
  });
  if (items.length > 0) {
    await db.from("payroll_items").insert(items);
  }
  revalidatePath("/payroll");
}

async function deleteRun(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo"]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  // Drafts only — a posted run is locked (it has a Finance entry behind it).
  const { data: run } = await supabase
    .from("payroll_runs")
    .select("id, status")
    .eq("id", id)
    .single();
  if (!run || (run as unknown as PayrollRun).status !== "draft") return;
  await db.from("payroll_items").delete().eq("run_id", id);
  await db.from("payroll_runs").delete().eq("id", id);
  revalidatePath("/payroll");
}

async function updatePayrollItem(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo"]);
  const id = String(formData.get("id") ?? "");
  const run_id = String(formData.get("run_id") ?? "");
  if (!id || !run_id) return;

  const supabase = createServerSupabaseClient();

  // Never edit a posted run — its numbers are already reflected in Finance.
  const { data: run } = await supabase
    .from("payroll_runs")
    .select("id, status, org_id")
    .eq("id", run_id)
    .single();
  const r = run as unknown as (PayrollRun & { org_id: string }) | null;
  if (!r || r.status !== "draft") return;

  const base = num(formData.get("base"));
  const allowance = num(formData.get("allowance"));
  const deductions = num(formData.get("deductions"));
  const gross = base + allowance;
  const net = gross - deductions;

  const db = supabase as unknown as DbShim;
  await db.from("payroll_items").update({ allowance, deductions, gross, net }).eq("id", id);

  // Keep the run total in sync with the edited items.
  const { data: itemRows } = await supabase
    .from("payroll_items")
    .select("net")
    .eq("run_id", run_id);
  const total = ((itemRows ?? []) as unknown as { net: number | null }[]).reduce(
    (a, i) => a + Number(i.net ?? 0),
    0
  );
  await db.from("payroll_runs").update({ total }).eq("id", run_id);
  revalidatePath("/payroll");
}

async function postRun(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as {
    id: string;
    org_id: string;
  };
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createServerSupabaseClient();
  const { data: runRow } = await supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, status")
    .eq("id", id)
    .single();
  const run = runRow as unknown as PayrollRun | null;
  if (!run || run.status !== "draft") return; // only draft runs post

  const { data: itemRows } = await supabase
    .from("payroll_items")
    .select("net")
    .eq("run_id", id);
  const total = ((itemRows ?? []) as unknown as { net: number | null }[]).reduce(
    (a, i) => a + Number(i.net ?? 0),
    0
  );

  const period = `${run.period_start ?? "?"} – ${run.period_end ?? "?"}`;
  const finance_entry_id = randomUUID();
  const db = supabase as unknown as DbShim;

  await db.from("finance_entries").insert({
    id: finance_entry_id,
    org_id: profile.org_id,
    created_by: profile.id,
    entry_date: run.period_end,
    type: "opex",
    category: "Salaries & Wages",
    amount: total,
    brand_id: null,
    note: `Payroll ${period}`,
  });

  await db
    .from("payroll_runs")
    .update({ status: "posted", total, finance_entry_id })
    .eq("id", id);
  revalidatePath("/payroll");
  revalidatePath("/finance");
}

// --- Page ------------------------------------------------------------------

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: { run?: string; archived?: string };
}) {
  const profile = await requireModule("/payroll");
  const supabase = createServerSupabaseClient();
  const selectedRunId = typeof searchParams.run === "string" ? searchParams.run : "";
  const archived = searchParams.archived === "1";

  // If a run is selected, render its register detail; otherwise the config +
  // run-list worksheet.
  if (selectedRunId) {
    return renderRunDetail(await loadRunDetail(supabase, selectedRunId), profile);
  }

  const runBase = supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, status, total, finance_entry_id, archived_at");
  const runFiltered = archived
    ? runBase.not("archived_at", "is", null)
    : runBase.is("archived_at", null);

  const [userRes, compRes, runRes] = await Promise.all([
    supabase.from("users").select("id, full_name").order("full_name"),
    supabase.from("compensation").select("user_id, pay_type, base_rate, allowance, currency"),
    runFiltered.order("period_end", { ascending: false }),
  ]);

  const users = (userRes.data ?? []) as unknown as User[];
  const comps = (compRes.data ?? []) as unknown as Compensation[];
  const runs = (runRes.data ?? []) as unknown as PayrollRun[];
  const compByUser = new Map(comps.map((c) => [c.user_id, c]));

  const configured = users.filter((u) => compByUser.has(u.id)).length;
  const monthlyCommitment = comps.reduce((a, c) => {
    if (c.pay_type === "monthly") return a + Number(c.base_rate ?? 0) + Number(c.allowance ?? 0);
    return a;
  }, 0);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Payroll"]} profile={profile}>
      <PageHeader
        title="Payroll Worksheet"
        subtitle="Leadership view. Configure compensation, generate a run from attendance, then post the total to Finance."
      />

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="People" value={users.length} />
        <StatTile label="Compensation set" value={configured} hint={`of ${users.length} people`} />
        <StatTile label="Payroll runs" value={runs.length} />
        <StatTile
          label="Monthly base commitment"
          value={peso(monthlyCommitment)}
          hint="monthly-paid base + allowance"
        />
      </div>

      {/* 1. Compensation config. */}
      <SectionCard title="Compensation" className="mb-8">
        <p className="mb-4 text-xs text-ink-muted">
          Base pay now lives on the <span className="text-ink">People</span> master profile
          (base_pay + frequency) and is pulled automatically into each run. This card sets the
          optional <span className="text-ink">allowance</span> and a legacy base fallback for anyone
          whose People base pay isn't set yet.
        </p>
        <div className="space-y-3">
          {users.length === 0 && <p className="text-sm text-ink-muted">No people yet.</p>}
          {users.map((u) => {
            const c = compByUser.get(u.id);
            const pt: PayType = c?.pay_type ?? "monthly";
            return (
              <form
                key={u.id}
                action={saveCompensation}
                className="grid items-end gap-2 rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3 sm:grid-cols-[1.4fr_1fr_1fr_1fr_auto]"
              >
                <input type="hidden" name="user_id" value={u.id} />
                <div className="text-sm text-ink">{u.full_name}</div>
                <label className="text-[11px] text-ink-muted">
                  Pay type
                  <select
                    name="pay_type"
                    defaultValue={pt}
                    className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
                  >
                    <option value="monthly">monthly</option>
                    <option value="daily">daily</option>
                    <option value="hourly">hourly</option>
                  </select>
                </label>
                <label className="text-[11px] text-ink-muted">
                  Base rate ({BASE_HINT[pt]})
                  <input
                    name="base_rate"
                    type="number"
                    step="0.01"
                    defaultValue={c?.base_rate ?? 0}
                    className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
                  />
                </label>
                <label className="text-[11px] text-ink-muted">
                  Allowance
                  <input
                    name="allowance"
                    type="number"
                    step="0.01"
                    defaultValue={c?.allowance ?? 0}
                    className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
                  />
                </label>
                <button
                  type="submit"
                  className="rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 sm:w-auto sm:justify-self-start"
                >
                  Save
                </button>
              </form>
            );
          })}
        </div>
      </SectionCard>

      {/* 2. Payroll runs. */}
      <SectionCard title="New payroll run" className="mb-4">
        <p className="mb-4 text-xs text-ink-muted">
          Generates a register snapshot: days present come from attendance in the period, and base
          pay is computed per pay type. You can adjust deductions before posting.
        </p>
        <form action={generateRun} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="text-[11px] text-ink-muted">
            Period start
            <input
              name="period_start"
              type="date"
              required
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            />
          </label>
          <label className="text-[11px] text-ink-muted">
            Period end
            <input
              name="period_end"
              type="date"
              required
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            />
          </label>
          <button
            type="submit"
            className="rounded-md bg-teal-500 px-4 py-2.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:w-auto"
          >
            Generate run
          </button>
        </form>
      </SectionCard>

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">
          {archived ? "Archived runs" : "Payroll runs"}
        </h2>
        <ArchivedToggle basePath="/payroll" archived={archived} />
      </div>
      <TableShell columns={["Period", "Status", "Total (net)", "", "Manage"]}>
        {runs.length === 0 && (
          <tr>
            <td colSpan={5} className="p-4 text-ink-muted">
              No payroll runs yet — generate your first above.
            </td>
          </tr>
        )}
        {runs.map((run) => (
          <tr key={run.id} className={rowClass}>
            <td className="p-3">
              <Link href={`/payroll?run=${run.id}`} className="text-teal-300 hover:text-teal-200">
                {run.period_start ?? "?"} – {run.period_end ?? "?"}
              </Link>
            </td>
            <td className="p-3">
              <Badge tone={run.status === "posted" ? "teal" : "amber"}>{run.status}</Badge>
            </td>
            <td className="p-3 font-mono text-ink">{peso(Number(run.total ?? 0))}</td>
            <td className="p-3">
              <div className="flex items-center gap-2">
                <Link
                  href={`/payroll?run=${run.id}`}
                  className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700"
                >
                  Open
                </Link>
                {run.status === "draft" && (
                  <form action={deleteRun}>
                    <input type="hidden" name="id" value={run.id} />
                    <button
                      type="submit"
                      aria-label="Delete draft run"
                      className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-red-300 hover:bg-charcoal-700"
                    >
                      Delete
                    </button>
                  </form>
                )}
              </div>
            </td>
            <td className="p-3">
              <RowActions {...rowActionProps("payroll_runs", run as unknown as Record<string, unknown>, profile)} />
            </td>
          </tr>
        ))}
      </TableShell>
    </AppShell>
  );
}

// --- Run detail ------------------------------------------------------------

type RunDetail = {
  run: PayrollRun | null;
  items: PayrollItem[];
};

async function loadRunDetail(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  runId: string
): Promise<RunDetail> {
  const [runRes, itemRes] = await Promise.all([
    supabase
      .from("payroll_runs")
      .select("id, period_start, period_end, status, total, finance_entry_id")
      .eq("id", runId)
      .single(),
    supabase
      .from("payroll_items")
      .select(
        "id, run_id, user_id, full_name, pay_type, base, days_present, allowance, deductions, gross, net, note"
      )
      .eq("run_id", runId)
      .order("full_name"),
  ]);
  return {
    run: (runRes.data as unknown as PayrollRun) ?? null,
    items: (itemRes.data ?? []) as unknown as PayrollItem[],
  };
}

function renderRunDetail({ run, items }: RunDetail, profile: Awaited<ReturnType<typeof requireRole>>) {
  if (!run) {
    return (
      <AppShell breadcrumb={["Mthryve OS", "Payroll"]} profile={profile}>
        <PageHeader title="Payroll run" subtitle="This run could not be found." />
        <Link href="/payroll" className="text-sm text-teal-300 hover:text-teal-200">
          ← Back to payroll
        </Link>
      </AppShell>
    );
  }

  const posted = run.status === "posted";
  const period = `${run.period_start ?? "?"} – ${run.period_end ?? "?"}`;
  const totals = items.reduce(
    (a, i) => ({
      base: a.base + Number(i.base ?? 0),
      allowance: a.allowance + Number(i.allowance ?? 0),
      deductions: a.deductions + Number(i.deductions ?? 0),
      gross: a.gross + Number(i.gross ?? 0),
      net: a.net + Number(i.net ?? 0),
    }),
    { base: 0, allowance: 0, deductions: 0, gross: 0, net: 0 }
  );

  const csvRows = items.map((i) => {
    const m = parseMeta(i.note);
    return {
      full_name: i.full_name,
      pay_type: i.pay_type,
      base: Number(i.base ?? 0),
      days_present: Number(i.days_present ?? 0),
      approved_leave: Number(m?.approvedLeave ?? 0),
      late_minutes: Number(m?.lateMinutes ?? 0),
      undertime_minutes: Number(m?.undertimeMinutes ?? 0),
      overtime_minutes: Number(m?.overtimeMinutes ?? 0),
      holiday_duty: Number(m?.holidayDuty ?? 0),
      rest_day_duty: Number(m?.restDayDuty ?? 0),
      allowance: Number(i.allowance ?? 0),
      deductions: Number(i.deductions ?? 0),
      gross: Number(i.gross ?? 0),
      net: Number(i.net ?? 0),
    };
  });

  return (
    <AppShell breadcrumb={["Mthryve OS", "Payroll"]} profile={profile}>
      <PageHeader
        title={`Payroll register · ${period}`}
        subtitle={
          posted
            ? "Posted to Finance — this register is locked."
            : "Draft. Adjust deductions and allowances, then post the total to Finance."
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/payroll"
              className="rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-ink-muted hover:bg-charcoal-700"
            >
              ← Back
            </Link>
            <ExportCsvButton rows={csvRows} filename={`payroll-${run.period_start}-${run.period_end}.csv`} />
            {!posted && (
              <form action={postRun}>
                <input type="hidden" name="id" value={run.id} />
                <button
                  type="submit"
                  className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
                >
                  Post to Finance
                </button>
              </form>
            )}
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone={posted ? "teal" : "amber"}>{run.status}</Badge>
        <span className="font-mono text-sm text-ink">Total net: {peso(totals.net)}</span>
        {posted && run.finance_entry_id && (
          <Link href="/finance" className="text-xs text-teal-300 hover:text-teal-200">
            View in Finance →
          </Link>
        )}
      </div>

      <p className="mb-3 text-xs text-ink-muted">
        Days worked, late, undertime, approved overtime, leave, holiday duty and rest-day duty are
        pulled automatically from Daily Logs and approved requests for the period.
      </p>

      <TableShell
        columns={[
          "Employee",
          "Pay basis",
          "Base",
          "Days worked",
          "Leave",
          "Late",
          "Overtime",
          "Allowance",
          "Deductions",
          "Gross",
          "Net",
        ]}
      >
        {items.length === 0 && (
          <tr>
            <td colSpan={11} className="p-4 text-ink-muted">
              No line items — no one had a People base pay or a compensation row when this run was
              generated.
            </td>
          </tr>
        )}
        {items.map((i) => {
          const fid = `pi-${i.id}`;
          const m = parseMeta(i.note);
          return (
            <tr key={i.id} className={rowClass}>
              <td className="p-3 text-ink">
                {i.full_name}
                {m?.commission && (
                  <span className="block text-[10px] text-ink-dim">{m.commission}</span>
                )}
              </td>
              <td className="p-3">
                <Badge tone="muted">{i.pay_type}</Badge>
              </td>
              <td className="p-3 font-mono text-ink-muted">{peso(Number(i.base ?? 0))}</td>
              <td className="p-3 font-mono text-ink-muted">{Number(i.days_present ?? 0)}</td>
              <td className="p-3 font-mono text-ink-muted">{Number(m?.approvedLeave ?? 0)}</td>
              <td className="p-3 text-ink-muted">{fmtMinutes(m?.lateMinutes)}</td>
              <td className="p-3 text-ink-muted">{fmtMinutes(m?.overtimeMinutes)}</td>
              <td className="p-3">
                {posted ? (
                  <span className="font-mono text-ink-muted">{peso(Number(i.allowance ?? 0))}</span>
                ) : (
                  // Row edit form + its hidden inputs live here; the deductions
                  // input and Save button in the next cell associate to it via
                  // the HTML `form` attribute so each value stays in its column.
                  <form id={fid} action={updatePayrollItem} className="contents">
                    <input type="hidden" name="id" value={i.id} />
                    <input type="hidden" name="run_id" value={i.run_id} />
                    <input type="hidden" name="base" value={Number(i.base ?? 0)} />
                    <input
                      name="allowance"
                      type="number"
                      step="0.01"
                      defaultValue={Number(i.allowance ?? 0)}
                      className="w-24 rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                    />
                  </form>
                )}
              </td>
              <td className="p-3">
                {posted ? (
                  <span className="font-mono text-ink-muted">{peso(Number(i.deductions ?? 0))}</span>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <input
                      form={fid}
                      name="deductions"
                      type="number"
                      step="0.01"
                      defaultValue={Number(i.deductions ?? 0)}
                      className="w-24 rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                    />
                    <button
                      form={fid}
                      type="submit"
                      className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700"
                    >
                      Save
                    </button>
                  </div>
                )}
              </td>
              <td className="p-3 font-mono text-ink">{peso(Number(i.gross ?? 0))}</td>
              <td className="p-3 font-mono text-ink">{peso(Number(i.net ?? 0))}</td>
            </tr>
          );
        })}
        {items.length > 0 && (
          <tr className="border-t border-charcoal-700 font-semibold">
            <td className="p-3 text-ink" colSpan={2}>
              Totals
            </td>
            <td className="p-3 font-mono text-ink">{peso(totals.base)}</td>
            <td className="p-3" />
            <td className="p-3" />
            <td className="p-3" />
            <td className="p-3" />
            <td className="p-3 font-mono text-ink">{peso(totals.allowance)}</td>
            <td className="p-3 font-mono text-ink">{peso(totals.deductions)}</td>
            <td className="p-3 font-mono text-ink">{peso(totals.gross)}</td>
            <td className="p-3 font-mono text-teal-300">{peso(totals.net)}</td>
          </tr>
        )}
      </TableShell>
    </AppShell>
  );
}
