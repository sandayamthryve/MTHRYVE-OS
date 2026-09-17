// lib/finance/forecast.ts — the CASH-FLOW FORECAST ENGINE.
//
// Pure, deterministic, UI-free: given the latest cash_positions anchor plus the
// provisioned finance signals (payroll_runs, finance_entries, brand_finance
// retainers, tiktok_settlements), it projects a DAILY running balance forward
// over a horizon and reports the first day the balance falls below a safety
// buffer — the "runway". Nothing here reads the database or renders anything;
// the data layer (lib/finance/data.ts) feeds it real rows and both the Finance
// view and the "Scan cash flow" producer route on the SAME output, so what
// leadership sees is exactly what Tony flags.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): this engine only ALERTS and PLANS. It
// never moves money. A projected deficit becomes a drafted action_request for a
// human to approve; approval opens an internal task, never a transaction.
//
// TYPE MAPPING (inspected, not assumed): finance_entries.type is constrained to
// {'opex','capex'} — BOTH are outflows (operating vs capital expense). The ledger
// carries NO inflow type, so the "finance_entries inflows" term is structurally
// zero until such a type is added; entryDirection() encodes that honestly rather
// than guessing a label. Cash inflows therefore come only from brand retainers
// and TikTok settlements.

// ── Horizon / window constants ────────────────────────────────────────────────

export const DEFAULT_HORIZON_DAYS = 60;
export const ALLOWED_HORIZONS = [30, 60, 90] as const;
export type HorizonDays = (typeof ALLOWED_HORIZONS)[number];

// The recurring expense run-rate is the trailing-90d average of ledger outflows,
// spread evenly across the horizon (a conservative daily burn).
export const EXPENSE_RUNRATE_DAYS = 90;

// The settlement run-rate is a trailing 30–60d average of net settlements; we use
// the 60d end of that range so a lumpy payout cadence averages out rather than
// spiking the daily inflow.
export const SETTLEMENT_RUNRATE_DAYS = 60;

// Default safety buffer: a deficit is the first day the projected balance drops
// below this. 0 = "runs out of cash".
export const DEFAULT_SAFETY_BUFFER = 0;

// Coerce an untrusted horizon (URL param) to an allowed value.
export function parseHorizon(v: string | number | undefined | null): HorizonDays {
  const n = typeof v === "string" ? Number(v) : v;
  return (ALLOWED_HORIZONS as readonly number[]).includes(n as number)
    ? (n as HorizonDays)
    : DEFAULT_HORIZON_DAYS;
}

// ── Row shapes the engine consumes (mirror the provisioned columns) ────────────

export interface CashPosition {
  amount: number;
  as_of_date: string; // YYYY-MM-DD
  account: string | null;
  note: string | null;
  created_at?: string | null;
}

export interface PayrollRun {
  id: string;
  period_start: string | null;
  period_end: string | null; // the pay date the total leaves on
  status: string; // 'draft' | 'posted'
  total: number | null;
  finance_entry_id: string | null; // when posted, the ledger row it created
}

export interface FinanceEntry {
  id: string;
  entry_date: string; // YYYY-MM-DD
  type: string; // 'opex' | 'capex'
  category: string | null;
  amount: number | null; // stored positive; direction comes from type
}

export interface Settlement {
  stat_date: string | null; // YYYY-MM-DD
  net_amount: number | null;
}

// Direction of a ledger entry. The finance_entries.type CHECK constraint permits
// only 'opex' and 'capex' — both outflows — so every entry is an outflow and the
// ledger contributes no inflow. Kept as a function (not a constant) so a future
// inflow type has one honest place to be mapped rather than being assumed.
const INFLOW_TYPES = new Set<string>([]); // none today; add here if the schema grows
export function entryDirection(type: string): "inflow" | "outflow" {
  return INFLOW_TYPES.has(type) ? "inflow" : "outflow";
}

// ── Date helpers (UTC-anchored YYYY-MM-DD arithmetic, matching the codebase) ────

const DAY_MS = 86_400_000;

function toUtcMs(dateStr: string): number | null {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** A YYYY-MM-DD `n` days after `dateStr` (n may be negative). */
export function addDays(dateStr: string, n: number): string {
  const base = toUtcMs(dateStr);
  if (base == null) return dateStr;
  return fromUtcMs(base + n * DAY_MS);
}

/** Whole days from `a` to `b` (b - a); null if either is unparseable. */
export function daysBetween(a: string, b: string): number | null {
  const ax = toUtcMs(a);
  const bx = toUtcMs(b);
  if (ax == null || bx == null) return null;
  return Math.round((bx - ax) / DAY_MS);
}

function dayOfMonth(dateStr: string): number {
  return Number(dateStr.slice(8, 10));
}

function daysInMonthOf(dateStr: string): number {
  const y = Number(dateStr.slice(0, 4));
  const m0 = Number(dateStr.slice(5, 7)) - 1;
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

// A retainer lands on the monthly anniversary of the anchor's day-of-month,
// clamped to the target month's length (so an anchor on the 31st still pays on a
// 30-day month's last day). This is the honest cadence: we don't know exactly
// when the current cycle's retainer already arrived, so the first modelled inflow
// is one month out from the anchor.
function isRetainerCadenceDay(dateStr: string, anchorDate: string): boolean {
  const target = Math.min(dayOfMonth(anchorDate), daysInMonthOf(dateStr));
  return dayOfMonth(dateStr) === target;
}

// ── Engine input + output ──────────────────────────────────────────────────────

export interface ForecastInput {
  anchor: CashPosition;
  payrollRuns: PayrollRun[]; // any status; the engine filters to future pay dates
  financeEntries: FinanceEntry[]; // trailing + future; the engine splits by date
  settlements: Settlement[]; // trailing window rows
  retainerMonthly: number; // Σ brand_finance.retainer_monthly (recurring inflow)
  horizonDays?: number;
  safetyBuffer?: number;
  settlementWindowDays?: number; // days the settlement rows span (for the average)
}

export interface ForecastPoint {
  date: string; // YYYY-MM-DD
  balance: number; // projected running balance at end of this day
}

// The plain-language drivers behind the projection — surfaced on the view and
// carried verbatim into the action_request evidence.
export interface ForecastDrivers {
  currentBalance: number;
  asOfDate: string;
  account: string | null;
  horizonDays: number;
  safetyBuffer: number;
  avgDailyNet: number; // (end − start) / horizon: the true average daily drift
  expenseRunRateDaily: number; // trailing-90d outflow average, per day
  settlementRunRateDaily: number; // trailing settlement average, per day
  retainerMonthly: number; // recurring monthly inflow
  nextPayroll: { total: number; date: string } | null;
  upcomingPayrollTotal: number; // Σ payroll totals landing inside the horizon
  futureExpenseTotal: number; // Σ future-dated ledger outflows inside the horizon
}

export interface CashForecast {
  points: ForecastPoint[]; // length horizonDays + 1; points[0] is the anchor
  startBalance: number;
  endBalance: number;
  minBalance: number;
  minDate: string;
  deficitDate: string | null; // first date balance < safetyBuffer, else null
  runwayDays: number | null; // days from the anchor to deficitDate, else null
  projectedShortfall: number | null; // buffer − balance on the deficit date (>0)
  drivers: ForecastDrivers;
}

// Build the daily forecast. Caller guarantees a real anchor (see data layer's
// honest "no cash position set" state); everything else may be empty, in which
// case the projection is a flat line at the anchor balance.
export function buildCashForecast(input: ForecastInput): CashForecast {
  const horizon = Math.max(1, Math.round(input.horizonDays ?? DEFAULT_HORIZON_DAYS));
  const buffer = input.safetyBuffer ?? DEFAULT_SAFETY_BUFFER;
  const settWindow = Math.max(1, Math.round(input.settlementWindowDays ?? SETTLEMENT_RUNRATE_DAYS));
  const asOf = input.anchor.as_of_date;
  const start = Number(input.anchor.amount ?? 0);
  const horizonEnd = addDays(asOf, horizon);

  // ── Run-rates (continuous daily drift) ──────────────────────────────────────
  const trailingStart = addDays(asOf, -(EXPENSE_RUNRATE_DAYS - 1));
  const expenseTrailingTotal = input.financeEntries
    .filter(
      (e) =>
        entryDirection(e.type) === "outflow" &&
        e.entry_date >= trailingStart &&
        e.entry_date <= asOf
    )
    .reduce((a, e) => a + Number(e.amount ?? 0), 0);
  const expenseRunRateDaily = expenseTrailingTotal / EXPENSE_RUNRATE_DAYS;

  const settlementTotal = input.settlements
    .filter((s) => s.stat_date != null && s.stat_date <= asOf)
    .reduce((a, s) => a + Number(s.net_amount ?? 0), 0);
  const settlementRunRateDaily = settlementTotal / settWindow;

  const dailyNetRunRate = settlementRunRateDaily - expenseRunRateDaily;

  // ── Discrete events indexed by date ──────────────────────────────────────────
  // Payroll: every run whose pay date (period_end) falls inside the horizon,
  // regardless of draft/posted — a committed payroll is cash that will leave.
  const payrollByDate = new Map<string, number>();
  const upcomingPayrolls: Array<{ total: number; date: string }> = [];
  const payrollEntryIds = new Set<string>();
  for (const p of input.payrollRuns) {
    const date = p.period_end;
    if (!date || date <= asOf || date > horizonEnd) continue;
    const total = Number(p.total ?? 0);
    if (total <= 0) continue;
    payrollByDate.set(date, (payrollByDate.get(date) ?? 0) + total);
    upcomingPayrolls.push({ total, date });
    if (p.finance_entry_id) payrollEntryIds.add(p.finance_entry_id);
  }
  upcomingPayrolls.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Future-dated ledger outflows inside the horizon, EXCLUDING any entry a
  // payroll run already posted (payrollEntryIds) so a posted payroll isn't
  // counted twice — once as the payroll event and once as its ledger row.
  const futureExpenseByDate = new Map<string, number>();
  for (const e of input.financeEntries) {
    if (entryDirection(e.type) !== "outflow") continue;
    if (e.entry_date <= asOf || e.entry_date > horizonEnd) continue;
    if (payrollEntryIds.has(e.id)) continue;
    const amt = Number(e.amount ?? 0);
    if (amt <= 0) continue;
    futureExpenseByDate.set(e.entry_date, (futureExpenseByDate.get(e.entry_date) ?? 0) + amt);
  }

  // ── Project the daily running balance ────────────────────────────────────────
  const points: ForecastPoint[] = [{ date: asOf, balance: start }];
  let running = start;
  for (let d = 1; d <= horizon; d++) {
    const date = addDays(asOf, d);
    running += dailyNetRunRate;
    if (input.retainerMonthly > 0 && isRetainerCadenceDay(date, asOf)) {
      running += input.retainerMonthly;
    }
    running -= futureExpenseByDate.get(date) ?? 0;
    running -= payrollByDate.get(date) ?? 0;
    points.push({ date, balance: running });
  }

  // ── Runway + extremes ────────────────────────────────────────────────────────
  let deficitDate: string | null = null;
  let runwayDays: number | null = null;
  let projectedShortfall: number | null = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].balance < buffer) {
      deficitDate = points[i].date;
      runwayDays = i;
      projectedShortfall = buffer - points[i].balance;
      break;
    }
  }

  let minBalance = points[0].balance;
  let minDate = points[0].date;
  for (const p of points) {
    if (p.balance < minBalance) {
      minBalance = p.balance;
      minDate = p.date;
    }
  }

  const endBalance = points[points.length - 1].balance;
  const upcomingPayrollTotal = upcomingPayrolls.reduce((a, p) => a + p.total, 0);
  const futureExpenseTotal = Array.from(futureExpenseByDate.values()).reduce((a, v) => a + v, 0);

  return {
    points,
    startBalance: start,
    endBalance,
    minBalance,
    minDate,
    deficitDate,
    runwayDays,
    projectedShortfall,
    drivers: {
      currentBalance: start,
      asOfDate: asOf,
      account: input.anchor.account,
      horizonDays: horizon,
      safetyBuffer: buffer,
      avgDailyNet: (endBalance - start) / horizon,
      expenseRunRateDaily,
      settlementRunRateDaily,
      retainerMonthly: input.retainerMonthly,
      nextPayroll: upcomingPayrolls[0] ?? null,
      upcomingPayrollTotal,
      futureExpenseTotal,
    },
  };
}

// Pick the anchor: the latest cash position by as_of_date, breaking ties on
// created_at (the most recently entered row for that date wins). Null when none
// is set — the honest "no cash position" state the view renders.
export function latestCashPosition<T extends CashPosition>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    if (a.as_of_date !== b.as_of_date) return a.as_of_date < b.as_of_date ? 1 : -1;
    const ac = a.created_at ?? "";
    const bc = b.created_at ?? "";
    return ac < bc ? 1 : ac > bc ? -1 : 0;
  })[0];
}
