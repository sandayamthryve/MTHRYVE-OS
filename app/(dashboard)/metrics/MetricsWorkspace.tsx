"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { BriefBentoPanel, type BriefHistoryRow } from "./BriefBentoPanel";
import { ImportMetricsControl, type ImportMetricsState } from "./ImportMetricsControl";

export type ValidationWorkspaceCard = {
  id: string;
  departmentId: string;
  department: string;
  date: string | null;
  efficiency: number | null;
  efficiencyBasis: string;
  quality: number | null;
  capacity: number | null;
  gmvImpact: number | null;
  tasks: string[];
  expectedOutputs: string[];
  challenges: string[];
  actionPlan: string[];
};

export type MetricLog = {
  id: string;
  department: string;
  periodStart: string | null;
  periodEnd: string | null;
  quality: number | null;
  capacity: number | null;
  gmvImpact: number | null;
  createdAt: string;
};

type NamedRow = { id: string; name: string };
type ValidationCategory = "tasks" | "expectedOutputs" | "challenges" | "actionPlan";
type SwipeState = "idle" | "view" | "delete";

const panel = "min-h-0 overflow-hidden rounded-2xl border border-charcoal-700/60 bg-charcoal-900/90 shadow-elevate";
const inset = "rounded-xl border border-charcoal-700/55 bg-charcoal-950/70";
const control = "h-9 w-full rounded-lg border border-charcoal-700/70 bg-charcoal-950 px-2.5 text-xs text-ink outline-none transition focus:border-teal-500/60 focus:ring-1 focus:ring-teal-500/20";
const hiddenScroll = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

function peso(value: number | null) {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat("en-PH", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `₱${Math.round(value).toLocaleString()}`;
  }
}

function score(value: number | null) {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function MiniMetric({ label, value }: { label: string; value: number | null }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="text-ink-dim">{label}</span>
        <span className="font-mono text-ink-muted">{value == null ? "—" : `${Math.round(value)}%`}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-charcoal-800">
        <div className="h-full rounded-full bg-teal-400/80 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Modal({
  open,
  title,
  onClose,
  children,
  width = "max-w-2xl",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) onClose();
          }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className={`max-h-[86dvh] w-full ${width} overflow-hidden rounded-2xl border border-charcoal-700 bg-charcoal-900 shadow-2xl`}
          >
            <div className="flex items-center justify-between border-b border-charcoal-700/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-ink">{title}</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-muted transition hover:bg-charcoal-800 hover:text-ink">✕</button>
            </div>
            <div className={`max-h-[calc(86dvh-52px)] overflow-y-auto p-4 ${hiddenScroll}`}>{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ValidationPanel({ cards, apiTools }: { cards: ValidationWorkspaceCard[]; apiTools?: ReactNode }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [category, setCategory] = useState<ValidationCategory>("tasks");
  const [showTools, setShowTools] = useState(false);
  const expanded = cards.find((card) => card.id === expandedId) ?? null;

  const items = expanded ? expanded[category] : [];
  const categoryLabel: Record<ValidationCategory, string> = {
    tasks: "Tasks",
    expectedOutputs: "Expected Outputs",
    challenges: "Challenges",
    actionPlan: "Action Plan",
  };

  return (
    <section className={`${panel} flex flex-col p-3.5`}>
      <header className="mb-3 flex shrink-0 items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">API Validation</h2>
          <p className="text-[10px] text-ink-dim">Department signals · live + recorded</p>
        </div>
        {apiTools && (
          <button type="button" onClick={() => setShowTools(true)} className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-2.5 py-1.5 text-[10px] font-medium text-teal-300 transition hover:bg-charcoal-800">
            API tools
          </button>
        )}
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {expanded ? (
            <motion.article
              key={`expanded-${expanded.id}`}
              initial={{ opacity: 0, scale: 0.985, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.985, y: 8 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 flex min-h-0 flex-col rounded-xl border border-teal-500/25 bg-charcoal-950 p-3 shadow-[0_0_30px_rgba(45,212,191,0.05)]"
            >
              <div className="shrink-0 border-b border-charcoal-700/60 pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-ink">{expanded.department}</p>
                    <p className="mt-0.5 font-mono text-[9px] text-ink-dim">{expanded.date || "No recorded date"}</p>
                  </div>
                  <button type="button" onClick={() => setExpandedId(null)} className="rounded-md border border-charcoal-700 px-2 py-1 text-[10px] text-ink-muted hover:bg-charcoal-800 hover:text-ink">Collapse</button>
                </div>
                <div className="mt-3 space-y-2">
                  <MiniMetric label="Efficiency" value={expanded.efficiency} />
                  <MiniMetric label="Quality" value={expanded.quality} />
                  <MiniMetric label="Capacity" value={expanded.capacity} />
                </div>
                {expanded.gmvImpact != null && <p className="mt-2 font-mono text-[10px] text-teal-300">GMV impact {peso(expanded.gmvImpact)}</p>}
              </div>

              <div className="mt-3 min-h-0 flex-1">
                <label className="block text-[9px] font-medium uppercase tracking-[0.15em] text-ink-dim">
                  Review detail
                  <select value={category} onChange={(e) => setCategory(e.target.value as ValidationCategory)} className={`${control} mt-1.5 normal-case tracking-normal`}>
                    <option value="tasks">Tasks</option>
                    <option value="expectedOutputs">Expected Outputs</option>
                    <option value="challenges">Challenges</option>
                    <option value="actionPlan">Action Plan</option>
                  </select>
                </label>
                <div className={`mt-2 h-[calc(100%-54px)] snap-y snap-mandatory space-y-2 overflow-y-auto overscroll-contain ${hiddenScroll}`}>
                  {items.length ? items.map((item, index) => (
                    <div key={`${category}-${index}`} className="min-h-[72px] snap-start rounded-lg border border-charcoal-700/50 bg-charcoal-900 p-2.5">
                      <p className="text-[9px] font-semibold uppercase tracking-wider text-teal-300">{categoryLabel[category]} · {index + 1}</p>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{item}</p>
                    </div>
                  )) : (
                    <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-charcoal-700/60 px-3 text-center text-[11px] text-ink-dim">No {categoryLabel[category].toLowerCase()} recorded for this department.</div>
                  )}
                </div>
              </div>
            </motion.article>
          ) : (
            <motion.div
              key="collapsed-list"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              className={`absolute inset-0 snap-y snap-mandatory space-y-2 overflow-y-auto overscroll-contain pr-0.5 ${hiddenScroll}`}
            >
              {cards.length ? cards.map((card) => (
                <article key={card.id} className={`${inset} snap-start p-3 transition hover:border-charcoal-600`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="truncate text-xs font-semibold text-ink">{card.department}</p><p className="mt-0.5 font-mono text-[9px] text-ink-dim">{card.date || "No snapshot"}</p></div>
                    <span className="rounded-full border border-charcoal-700 bg-charcoal-900 px-2 py-0.5 font-mono text-[9px] text-ink-dim">API</span>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    <MiniMetric label="Efficiency" value={card.efficiency} />
                    <MiniMetric label="Quality" value={card.quality} />
                    <MiniMetric label="Capacity" value={card.capacity} />
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[9px] text-ink-dim">{card.gmvImpact == null ? "No GMV floor" : peso(card.gmvImpact)}</span>
                    <button type="button" onClick={() => { setCategory("tasks"); setExpandedId(card.id); }} className="rounded-md border border-charcoal-700 px-2.5 py-1 text-[10px] font-medium text-teal-300 hover:bg-charcoal-800">Expand</button>
                  </div>
                </article>
              )) : <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-charcoal-700/60 text-center text-xs text-ink-dim">No department validation data yet.</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Modal open={showTools} onClose={() => setShowTools(false)} title="API validation tools" width="max-w-4xl">
        {apiTools}
      </Modal>
    </section>
  );
}

function SnapshotPanel({
  departments,
  canRecord,
  action,
}: {
  departments: NamedRow[];
  canRecord: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  const [date, setDate] = useState("");
  return (
    <section className={`${panel} flex min-h-0 flex-col p-3.5`}>
      <header className="mb-2 shrink-0">
        <h2 className="text-sm font-semibold text-ink">Record Snapshot</h2>
        <p className="text-[10px] text-ink-dim">Quality, capacity and GMV floor · efficiency stays system-derived</p>
      </header>
      {canRecord ? (
        <form action={action} className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 xl:grid-cols-4">
          <label className="col-span-2 text-[9px] font-medium uppercase tracking-[0.14em] text-ink-dim">
            Department
            <select name="department_id" required className={`${control} mt-1 normal-case tracking-normal`}>
              <option value="">Department…</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </label>
          <label className="col-span-2 text-[9px] font-medium uppercase tracking-[0.14em] text-ink-dim">
            Date
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={`${control} mt-1 normal-case tracking-normal`} />
          </label>
          <input type="hidden" name="period_start" value={date} readOnly />
          <input type="hidden" name="period_end" value={date} readOnly />
          <label className="text-[9px] font-medium uppercase tracking-[0.14em] text-ink-dim">
            Quality
            <input name="quality_score" type="number" min={1} max={100} step={1} required placeholder="1–100" className={`${control} mt-1 normal-case tracking-normal`} />
          </label>
          <label className="text-[9px] font-medium uppercase tracking-[0.14em] text-ink-dim">
            Capacity
            <input name="capacity_utilization" type="number" min={1} max={100} step={1} required placeholder="1–100" className={`${control} mt-1 normal-case tracking-normal`} />
          </label>
          <label className="col-span-2 text-[9px] font-medium uppercase tracking-[0.14em] text-ink-dim">
            GMV Impact (PHP)
            <input name="gmv_impact" type="number" step="0.01" placeholder="e.g. 250000" className={`${control} mt-1 normal-case tracking-normal`} />
          </label>
          <div className="col-span-2 flex justify-end pt-1 xl:col-span-4">
            <button type="submit" className="rounded-lg bg-teal-500 px-4 py-2 text-[11px] font-semibold text-charcoal-950 transition hover:bg-teal-400">Save Snapshot</button>
          </div>
        </form>
      ) : <div className="flex min-h-24 flex-1 items-center justify-center rounded-xl border border-dashed border-charcoal-700/60 px-4 text-center text-xs text-ink-dim">Snapshots are recorded by department heads and above.</div>}
    </section>
  );
}

function LogCard({
  log,
  canRecord,
  onView,
  onDelete,
}: {
  log: MetricLog;
  canRecord: boolean;
  onView: () => void;
  onDelete: () => void;
}) {
  const [swipe, setSwipe] = useState<SwipeState>("idle");
  const dragStart = useRef(0);
  const x = swipe === "view" ? -76 : swipe === "delete" ? 76 : 0;

  return (
    <div className="group relative snap-start overflow-hidden rounded-xl">
      <div className="absolute inset-0 flex items-stretch justify-between overflow-hidden rounded-xl">
        <button type="button" onClick={onDelete} disabled={!canRecord} className="flex w-20 items-center justify-center bg-red-500/15 text-[10px] font-semibold text-red-300 transition hover:bg-red-500/25 disabled:opacity-40">Delete</button>
        <button type="button" onClick={onView} className="flex w-20 items-center justify-center bg-teal-500/15 text-[10px] font-semibold text-teal-300 transition hover:bg-teal-500/25">View</button>
      </div>
      <motion.article
        drag="x"
        dragConstraints={{ left: -88, right: 88 }}
        dragElastic={0.08}
        animate={{ x }}
        transition={{ type: "spring", stiffness: 420, damping: 35 }}
        onDragStart={(_, info) => { dragStart.current = info.point.x; }}
        onDragEnd={(_, info) => {
          const distance = info.point.x - dragStart.current;
          if (distance < -35) setSwipe("view");
          else if (distance > 35 && canRecord) setSwipe("delete");
          else setSwipe("idle");
        }}
        onDoubleClick={() => setSwipe("idle")}
        className={`${inset} relative cursor-grab p-3 active:cursor-grabbing`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0"><p className="truncate text-xs font-semibold text-ink">{log.department}</p><p className="mt-0.5 font-mono text-[9px] text-ink-dim">{log.periodEnd || log.periodStart || "No date"}</p></div>
          <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onView(); }} className="rounded border border-charcoal-700 bg-charcoal-900 px-1.5 py-0.5 text-[9px] text-teal-300">View</button>
            {canRecord && <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDelete(); }} className="rounded border border-red-500/20 bg-red-500/5 px-1.5 py-0.5 text-[9px] text-red-300">Delete</button>}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <div className="rounded-lg bg-charcoal-900 px-2 py-1.5 text-center"><p className="font-mono text-xs text-ink">{score(log.quality)}</p><p className="text-[9px] text-ink-dim">Quality</p></div>
          <div className="rounded-lg bg-charcoal-900 px-2 py-1.5 text-center"><p className="truncate font-mono text-[10px] text-teal-300">{peso(log.gmvImpact)}</p><p className="text-[9px] text-ink-dim">GMV Impact</p></div>
          <div className="rounded-lg bg-charcoal-900 px-2 py-1.5 text-center"><p className="font-mono text-xs text-ink">{score(log.capacity)}</p><p className="text-[9px] text-ink-dim">Capacity</p></div>
        </div>
        <p className="mt-2 text-center text-[8px] uppercase tracking-[0.12em] text-ink-dim opacity-60">drag → delete · ← view</p>
      </motion.article>
    </div>
  );
}

function MetricLogsPanel({
  logs,
  canRecord,
  deleteAction,
  importAction,
  exportControl,
}: {
  logs: MetricLog[];
  canRecord: boolean;
  deleteAction: (formData: FormData) => Promise<void>;
  importAction: (prev: ImportMetricsState, formData: FormData) => Promise<ImportMetricsState>;
  exportControl?: ReactNode;
}) {
  const [viewLog, setViewLog] = useState<MetricLog | null>(null);
  const [deleteLog, setDeleteLog] = useState<MetricLog | null>(null);
  const [showImport, setShowImport] = useState(false);

  return (
    <section className={`${panel} flex flex-col p-3.5`}>
      <header className="mb-3 flex shrink-0 items-center justify-between gap-2">
        <div><h2 className="text-sm font-semibold text-ink">Metric Logs</h2><p className="text-[10px] text-ink-dim">Swipe or use hover actions</p></div>
        <div className="flex items-center gap-1.5">
          {exportControl}
          {canRecord && <button type="button" onClick={() => setShowImport(true)} className="rounded-lg bg-teal-500 px-2.5 py-1.5 text-[10px] font-semibold text-charcoal-950 hover:bg-teal-400">Import</button>}
        </div>
      </header>

      <div className={`min-h-0 flex-1 snap-y snap-mandatory space-y-2 overflow-y-auto overscroll-contain pr-0.5 ${hiddenScroll}`}>
        {logs.length ? logs.map((log) => <LogCard key={log.id} log={log} canRecord={canRecord} onView={() => setViewLog(log)} onDelete={() => setDeleteLog(log)} />) : <div className="flex h-full min-h-28 items-center justify-center rounded-xl border border-dashed border-charcoal-700/60 px-4 text-center text-xs text-ink-dim">No metric snapshots recorded yet.</div>}
      </div>

      <Modal open={!!viewLog} onClose={() => setViewLog(null)} title="Metric record" width="max-w-md">
        {viewLog && <div className="space-y-3">
          <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-950 p-4"><p className="text-sm font-semibold text-ink">{viewLog.department}</p><p className="mt-1 font-mono text-[10px] text-ink-dim">{viewLog.periodStart || "—"} → {viewLog.periodEnd || "—"}</p></div>
          <div className="grid grid-cols-2 gap-2"><div className={`${inset} p-3`}><p className="text-[10px] text-ink-dim">Quality</p><p className="mt-1 font-mono text-lg text-ink">{score(viewLog.quality)}</p></div><div className={`${inset} p-3`}><p className="text-[10px] text-ink-dim">Capacity</p><p className="mt-1 font-mono text-lg text-ink">{score(viewLog.capacity)}</p></div><div className={`${inset} col-span-2 p-3`}><p className="text-[10px] text-ink-dim">GMV Impact</p><p className="mt-1 font-mono text-lg text-teal-300">{peso(viewLog.gmvImpact)}</p></div></div>
        </div>}
      </Modal>

      <Modal open={!!deleteLog} onClose={() => setDeleteLog(null)} title="Delete metric log" width="max-w-md">
        {deleteLog && <div><p className="text-sm leading-relaxed text-ink">Are you sure you want to delete this metric log?</p><p className="mt-2 text-xs text-ink-muted">{deleteLog.department} · {deleteLog.periodEnd || deleteLog.periodStart || "No date"}. This action cannot be undone.</p><form action={deleteAction} className="mt-5 flex justify-end gap-2"><input type="hidden" name="id" value={deleteLog.id} /><button type="button" onClick={() => setDeleteLog(null)} className="rounded-lg border border-charcoal-700 px-3 py-2 text-xs font-medium text-ink-muted hover:bg-charcoal-800">Cancel</button><button type="submit" className="rounded-lg bg-red-500 px-3 py-2 text-xs font-semibold text-white hover:bg-red-400">Delete</button></form></div>}
      </Modal>

      <Modal open={showImport} onClose={() => setShowImport(false)} title="Import metric data" width="max-w-xl">
        <ImportMetricsControl action={importAction} />
      </Modal>
    </section>
  );
}

export function MetricsWorkspace({
  departments,
  brands,
  briefHistory,
  validationCards,
  logs,
  canRecord,
  recordAction,
  deleteAction,
  importAction,
  apiTools,
  exportControl,
}: {
  departments: NamedRow[];
  brands: NamedRow[];
  briefHistory: BriefHistoryRow[];
  validationCards: ValidationWorkspaceCard[];
  logs: MetricLog[];
  canRecord: boolean;
  recordAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
  importAction: (prev: ImportMetricsState, formData: FormData) => Promise<ImportMetricsState>;
  apiTools?: ReactNode;
  exportControl?: ReactNode;
}) {
  const orderedLogs = useMemo(() => [...logs].sort((a, b) => (b.periodEnd || b.createdAt).localeCompare(a.periodEnd || a.createdAt)), [logs]);

  return (
    <div className="metrics-workspace -mt-2 h-[calc(100dvh-104px)] min-h-[500px] overflow-hidden pb-1 lg:h-[min(650px,calc(100dvh-104px))]">
      <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-y-auto overflow-x-hidden lg:grid-cols-[minmax(240px,0.82fr)_minmax(470px,1.55fr)_minmax(270px,0.92fr)] lg:overflow-hidden 2xl:grid-cols-[minmax(270px,0.8fr)_minmax(620px,1.65fr)_minmax(300px,0.9fr)]">
        <ValidationPanel cards={validationCards} apiTools={apiTools} />

        <div className="grid min-h-0 gap-3 lg:grid-rows-[minmax(0,1fr)_minmax(190px,0.55fr)]">
          <section className={`${panel} flex min-h-0 flex-col p-3.5`}>
            <header className="mb-3 flex shrink-0 items-center justify-between gap-2"><div><h1 className="text-sm font-semibold text-ink">AI Account Review Brief</h1><p className="text-[10px] text-ink-dim">Grounded management review · generated history</p></div><span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-violet-300">AI brief</span></header>
            <BriefBentoPanel departments={departments} brands={brands} history={briefHistory} canGenerate={canRecord} />
          </section>
          <SnapshotPanel departments={departments} canRecord={canRecord} action={recordAction} />
        </div>

        <MetricLogsPanel logs={orderedLogs} canRecord={canRecord} deleteAction={deleteAction} importAction={importAction} exportControl={exportControl} />
      </div>
    </div>
  );
}