"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionProfile } from "@/lib/auth/session";
import { AGENTS, AgentPlanet } from "./agent-planets";

const SYSTEM_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
const card = "rounded-[22px] border border-[#1e2a35] bg-[#111820] shadow-[inset_0_1px_0_rgba(255,255,255,.04),0_10px_26px_rgba(0,0,0,.28)]";

type RailView = "live" | "dailyTap" | "quickEntry" | "report";

type QuickEntryMetric = { name: string; unit: string };

const QUICK_ENTRY_DEPTS: Record<string, QuickEntryMetric[]> = {
  "Business Development": [
    { name: "Qualified Leads", unit: "leads" },
    { name: "Meetings Booked", unit: "meetings" },
    { name: "Close Rate", unit: "%" },
    { name: "Pipeline Value", unit: "₱" },
    { name: "New Clients", unit: "clients" },
  ],
  "E-Commerce Ops": [
    { name: "GMV", unit: "₱" },
    { name: "Orders", unit: "orders" },
    { name: "Conversion Rate", unit: "%" },
    { name: "ROAS", unit: "x" },
    { name: "Average Order Value", unit: "₱" },
  ],
  Creative: [
    { name: "Assets Completed", unit: "assets" },
    { name: "Approval Rate", unit: "%" },
    { name: "Turnaround Time", unit: "hrs" },
    { name: "Revisions", unit: "count" },
    { name: "Content Score", unit: "/100" },
  ],
  "Warehouse & Fulfillment": [
    { name: "Orders Fulfilled", unit: "orders" },
    { name: "On-time Dispatch", unit: "%" },
    { name: "Pick Accuracy", unit: "%" },
    { name: "Returns", unit: "orders" },
    { name: "Backlog", unit: "orders" },
  ],
  "Customer Service": [
    { name: "Response Rate", unit: "%" },
    { name: "Resolution Time", unit: "hrs" },
    { name: "CSAT", unit: "/5" },
    { name: "Open Tickets", unit: "tickets" },
    { name: "Resolved Tickets", unit: "tickets" },
  ],
  "Live Operations": [
    { name: "Live GMV", unit: "₱" },
    { name: "Peak Viewers", unit: "viewers" },
    { name: "Conversion Rate", unit: "%" },
    { name: "Live Hours", unit: "hrs" },
    { name: "Orders", unit: "orders" },
  ],
  "Affiliate Marketing": [
    { name: "Affiliate GMV", unit: "₱" },
    { name: "Active Affiliates", unit: "people" },
    { name: "Posts Live", unit: "posts" },
    { name: "Conversion Rate", unit: "%" },
    { name: "Commission", unit: "₱" },
  ],
  Finance: [
    { name: "Cash Collected", unit: "₱" },
    { name: "Expenses", unit: "₱" },
    { name: "Receivables", unit: "₱" },
    { name: "Payables", unit: "₱" },
    { name: "Variance", unit: "%" },
  ],
};

function LiveClock() {
  const [time, setTime] = useState("");
  useEffect(() => {
    const update = () => setTime(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span>{time || "--:--:--"}</span>;
}

function CardTitle({ children, icon, tight = false }: { children: React.ReactNode; icon?: string; tight?: boolean }) {
  return (
    <div className={`${tight ? "mb-[10px]" : "mb-4"} flex items-center justify-between`}>
      <h2 className="text-[13px] font-bold tracking-[.1px] text-[#8b9aa8]">{children}</h2>
      {icon && <span className="text-[18px] leading-none">{icon}</span>}
    </div>
  );
}

function RangePill({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex h-[18px] items-center justify-center rounded-full border border-[#1e2a35] bg-[#0d141b] px-3 text-[11.5px] font-extrabold text-[#e9f0f6]">{children}</span>;
}

function ResourceRow({ label, value, width }: { label: string; value: string; width: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[12px] font-semibold text-[#8b9aa8]"><span>{label}</span><span>{value}</span></div>
      <div className="h-1 overflow-hidden rounded-full bg-[#0d141b]"><div className="h-full rounded-full bg-gradient-to-r from-[#5aa9e6] to-[#a78bfa]" style={{ width }} /></div>
    </div>
  );
}

function QuickActionButton({ mode, active, label, onClick, children }: { mode: RailView; active: boolean; label: string; onClick: (mode: RailView) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={() => onClick(mode)}
      className={`grid h-8 w-8 place-items-center rounded-full border transition hover:-translate-y-0.5 ${active ? "border-[#2dd4bf]/35 bg-[#111820] text-[#2dd4bf] shadow-[0_5px_16px_rgba(0,0,0,.32),inset_0_0_0_1px_rgba(45,212,191,.06)]" : "border-transparent bg-transparent text-[#8b9aa8] hover:bg-[#111820] hover:text-[#2dd4bf]"}`}
    >
      {children}
    </button>
  );
}

function LiveVideoRail() {
  return (
    <>
      <section className="relative flex h-[242px] min-h-0 flex-none flex-col">
        <h3 className="flex items-center gap-[7px] text-[10.5px] font-extrabold uppercase tracking-[.8px] text-[#8b9aa8]"><span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#f26d6d] shadow-[0_0_7px_#f26d6d]" />Live Selling</h3>
        <Link href="/live" className="relative mt-[7px] min-h-0 flex-1 overflow-hidden rounded-[11px] bg-[linear-gradient(150deg,#0d141b,#0a0f14)]">
          <div className="absolute inset-0 bg-[linear-gradient(115deg,transparent_30%,#f26d6d_40%,transparent_60%)] bg-[length:220%_220%] opacity-20" />
          <span className="absolute left-[7px] top-[7px] rounded-full bg-[#f26d6d]/90 px-[7px] py-[3px] text-[11.5px] font-extrabold uppercase tracking-[.4px] text-white">● Live</span>
          <span className="absolute right-[7px] top-[7px] rounded-full bg-black/45 px-[7px] py-[3px] text-[11.5px] font-bold text-white">❤️ 5.4K&nbsp;&nbsp; 👁 1.2K</span>
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-b from-transparent to-black/85 px-2 pb-[7px] pt-4"><div className="truncate text-[11.5px] font-extrabold text-white">FML Official</div><div className="mt-0.5 truncate text-[10px] text-white/75">Payday Mega Sale — Hero Bundle</div></div>
          <div className="absolute inset-x-0 bottom-[6px] z-10 flex justify-center gap-[5px]"><i className="h-[5px] w-[14px] rounded bg-[#2dd4bf]" /><i className="h-[5px] w-[5px] rounded-full bg-[#1e2a35]" /><i className="h-[5px] w-[5px] rounded-full bg-[#1e2a35]" /></div>
        </Link>
      </section>
      <section className="relative mt-4 flex h-[242px] min-h-0 flex-none flex-col">
        <h3 className="flex items-center gap-[7px] text-[10.5px] font-extrabold uppercase tracking-[.8px] text-[#8b9aa8]"><span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#5aa9e6] shadow-[0_0_7px_#5aa9e6]" />Posted Videos</h3>
        <Link href="/live-wall" className="relative mt-[7px] min-h-0 flex-1 overflow-hidden rounded-[11px] bg-[linear-gradient(150deg,#0d141b,#0a0f14)]">
          <span className="absolute left-[7px] top-[7px] rounded-full bg-[#5aa9e6]/90 px-[7px] py-[3px] text-[11.5px] font-extrabold uppercase tracking-[.4px] text-white">Video</span>
          <span className="absolute right-[7px] top-[7px] rounded-full bg-black/45 px-[7px] py-[3px] text-[11.5px] font-bold text-white">❤️ 2.1K&nbsp;&nbsp; 👁 8.3K</span>
          <span className="absolute inset-0 grid place-items-center text-[22px] text-white/80">▶</span>
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-b from-transparent to-black/85 px-2 pb-[7px] pt-4"><div className="truncate text-[11.5px] font-extrabold text-white">Unboxing: Crayola Back-to-School Set</div><div className="mt-0.5 truncate text-[10px] text-white/75">By Crayola PH</div></div>
          <div className="absolute inset-x-0 bottom-[6px] z-10 flex justify-center gap-[5px]"><i className="h-[5px] w-[14px] rounded bg-[#2dd4bf]" /><i className="h-[5px] w-[5px] rounded-full bg-[#1e2a35]" /></div>
        </Link>
      </section>
    </>
  );
}

function DailyTapRail({ firstName }: { firstName: string }) {
  const taps = [
    {
      day: "Jul 20",
      copy: "Operating score sits at a weak 32/100, with four of five graded metrics off-target or at risk. Customer Service is the sharpest fire — 2.2 against a 4.5 target — closely trailed by Fulfilment & Logistics at 3.1/4.5 and...",
    },
    {
      day: "Jul 19",
      copy: "Operating score is sitting at a weak 32/100, with four of five metrics off target. The fire to look at first is Response Rate, cratered at 30% against a 75% target — the widest gap on the board — followed closely by...",
    },
  ];
  return (
    <div className="h-full min-h-0 overflow-y-auto pr-1 [scrollbar-color:rgba(139,154,168,.42)_transparent] [scrollbar-width:thin]">
      <div className="px-px pb-[10px]">
        <div className="text-[15px] font-extrabold leading-[1.15] text-[#e9f0f6]">Daily Tap</div>
        <div className="mt-1 text-[12px] leading-[1.4] text-[#8b9aa8]">Your morning brief — grounded in today&apos;s real numbers. A read, never an action.</div>
      </div>
      <div className="rounded-[10px] border border-[#1e2a35] bg-[#0d141b] p-[10px_11px] text-[12px] leading-[1.45] text-[#91c3cf]">No tap yet today. Your morning brief lands around 10 AM — grounded in the day&apos;s real numbers.</div>
      <div className="mx-px mb-[7px] mt-[13px] text-[11px] font-extrabold uppercase leading-none tracking-[1px] text-[#6c90a7]">Earlier taps</div>
      <div className="flex flex-col gap-[7px]">
        {taps.map((tap) => (
          <article key={tap.day} className="rounded-[10px] border border-[#1e2a35] bg-[#0d141b] p-[10px_11px]">
            <div className="mb-[6px] flex flex-wrap items-center gap-[5px]">
              <strong className="mr-px text-[10.5px] font-extrabold text-[#e9f0f6]">{tap.day}</strong>
              <span className="rounded-full border border-[#a78bfa]/45 bg-[#a78bfa]/[.07] px-[5px] py-0.5 font-mono text-[10px] font-bold uppercase tracking-[.25px] text-[#c6b7ff]">Leadership Digest</span>
              <span className="rounded-full border border-[#a78bfa]/45 bg-[#a78bfa]/[.07] px-[5px] py-0.5 font-mono text-[10px] font-bold uppercase text-[#c6b7ff]">AI</span>
              <span className="rounded-full border border-[#2a3945] bg-[#17222a] px-[5px] py-0.5 font-mono text-[10px] font-bold uppercase text-[#8098a8]">No action</span>
            </div>
            <div className="mb-[6px] text-[11.5px] text-[#64879d]">Good morning, {firstName.toLowerCase()}.</div>
            <p className="line-clamp-3 text-[11.5px] leading-[1.45] text-[#64879d]">{tap.copy}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function QuickEntryRail() {
  const [department, setDepartment] = useState("Business Development");
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [snap, setSnap] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const snapRef = useRef<HTMLTextAreaElement>(null);
  const metrics = QUICK_ENTRY_DEPTS[department] ?? [];

  const fillFields = () => {
    const parsed: Record<string, string> = {};
    const lines = snap.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length >= 2 && lines[0]?.includes(",")) {
      const heads = lines[0].split(",").map((x) => x.trim().toLowerCase());
      const vals = lines[1].split(",").map((x) => x.trim());
      heads.forEach((head, index) => { parsed[head] = vals[index] ?? ""; });
    } else {
      lines.forEach((line) => {
        const match = line.match(/^([^:=]+)\s*[:=]\s*(.+)$/);
        if (match) parsed[match[1].trim().toLowerCase()] = match[2].trim();
      });
    }
    setValues((current) => {
      const next = { ...current };
      metrics.forEach((metric) => {
        const value = parsed[metric.name.toLowerCase()];
        if (value) next[metric.name] = value;
      });
      return next;
    });
  };

  const save = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const placeholder = useMemo(() => `Paste a row (with headers) or “Label: value” lines, or drop a .csv / .xlsx here. Maps to: ${metrics.slice(0, 5).map((metric) => metric.name).join(", ")}${metrics.length > 5 ? ", …" : ""}`, [metrics]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="grid flex-none grid-cols-[minmax(0,1fr)_92px] gap-[7px] rounded-[10px] border border-[#1e2a35] bg-[#0d141b] p-2">
        <label><span className="mb-[5px] ml-0.5 block text-[10.5px] font-bold uppercase leading-none tracking-[.6px] text-[#6f8fa2]">Department</span><select value={department} onChange={(event) => { setDepartment(event.target.value); setValues({}); }} className="h-[30px] w-full rounded-lg border border-[#2b3a46] bg-[#111a21] px-[9px] text-[11.5px] font-bold text-[#e9f0f6] outline-none focus:border-[#2dd4bf]">{Object.keys(QUICK_ENTRY_DEPTS).map((name) => <option key={name}>{name}</option>)}</select></label>
        <label><span className="mb-[5px] ml-0.5 block text-[10.5px] font-bold uppercase leading-none tracking-[.6px] text-[#6f8fa2]">Day</span><input type="date" value={day} onChange={(event) => setDay(event.target.value)} className="h-[30px] w-full rounded-lg border border-[#2b3a46] bg-[#111a21] px-[6px] text-[11px] font-bold text-[#e9f0f6] outline-none focus:border-[#2dd4bf]" /></label>
      </div>

      <div className="flex-none rounded-[10px] border border-[#1e2a35] bg-[#0d141b] p-2">
        <div className="mb-[6px] flex items-center justify-between gap-2"><span className="text-[10.5px] font-bold uppercase tracking-[.6px] text-[#6f8fa2]">Snap to Fill</span><div className="flex gap-1"><button type="button" onClick={() => snapRef.current?.focus()} className="h-5 rounded-full border border-[#2dd4bf] bg-[#2dd4bf]/80 px-2 text-[10.5px] font-bold text-[#03231f]">Paste / drop</button><button type="button" title="Photo import placeholder" className="h-5 rounded-full border border-[#2a3945] bg-[#111a21] px-2 text-[10.5px] font-bold text-[#9cb0bd]">Photo</button></div></div>
        <textarea ref={snapRef} value={snap} onChange={(event) => setSnap(event.target.value)} placeholder={placeholder} className="h-[46px] w-full resize-none rounded-lg border border-dashed border-[#2b3a46] bg-[#0f171d] p-[7px_8px] text-[11px] leading-[1.4] text-[#91a8b7] outline-none placeholder:text-[#648092] focus:border-[#2dd4bf]" />
        <div className="mt-[5px] flex items-center justify-between gap-2"><span className="max-w-[180px] truncate text-[10px] font-bold text-[#2dd4bf]">or choose a .csv / .xlsx file</span><button type="button" onClick={fillFields} className="h-5 rounded-full border-0 bg-[#174f4c] px-[9px] text-[10px] font-bold text-[#9de2d9]">Fill fields</button></div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-[10px] border border-[#1e2a35] bg-[#0d141b]/40 [scrollbar-color:rgba(139,154,168,.38)_transparent] [scrollbar-width:thin]">
        {metrics.map((metric) => (
          <div key={metric.name} className="grid min-h-[39px] grid-cols-[minmax(0,1fr)_58px] items-center gap-[6px] border-b border-[#2a3945]/75 px-[7px] py-[5px] last:border-b-0">
            <div className="min-w-0 truncate text-[11px] font-bold text-[#e9f0f6]">{metric.name}<span className="ml-[3px] text-[10px] font-medium text-[#7892a2]">{metric.unit}</span></div>
            <input value={values[metric.name] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [metric.name]: event.target.value }))} placeholder="—" className="h-[27px] w-[58px] rounded-lg border border-[#2b3a46] bg-[#111a21] px-[5px] text-center text-[11px] font-bold text-[#e9f0f6] outline-none placeholder:text-[#648092] focus:border-[#2dd4bf]" />
          </div>
        ))}
      </div>

      <div className="flex min-h-[38px] flex-none items-center justify-between gap-2 rounded-[10px] border border-[#1e2a35] bg-[#0d141b] p-[6px_7px]"><span className="text-[10px] text-[#8799a5]">Blank rows are left untouched.</span>{saved && <span className="ml-auto text-[10px] text-[#3ecf8e]">Saved</span>}<button type="button" onClick={save} className="h-[27px] rounded-lg border-0 bg-[#145b56] px-[11px] text-[10.5px] font-bold text-[#c6eee8]">Save entry</button></div>
    </div>
  );
}

function ReportRail({ firstName, onQuickEntry }: { firstName: string; onQuickEntry: () => void }) {
  const [deliverables, setDeliverables] = useState("");
  const [summary, setSummary] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(false);

  const submit = () => {
    if (!deliverables.trim()) {
      setError(true);
      window.setTimeout(() => setError(false), 1200);
      return;
    }
    setSubmitted(true);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto pr-0.5 [scrollbar-color:rgba(139,154,168,.42)_transparent] [scrollbar-width:thin]">
      <div className="px-px pb-[10px]"><div className="text-[15px] font-extrabold leading-[1.15] text-[#e9f0f6]">Good to see you, {firstName.toLowerCase()}</div><div className="mt-1 text-[11.5px] leading-[1.45] text-[#8fbac7]">Your day at a glance — tasks, your daily report, and how your department is tracking.</div><button type="button" onClick={onQuickEntry} className="mt-[10px] inline-flex h-[30px] items-center gap-1.5 rounded-[10px] border border-[#2dd4bf]/35 bg-[#2dd4bf]/80 px-[11px] text-[11.5px] font-extrabold text-[#03211e]">⚡ Quick Entry</button></div>
      <div className="mx-px mb-[7px] mt-[9px] text-[11.5px] font-extrabold text-[#e9f0f6]">Business Development — key metrics</div>
      <div className="grid grid-cols-3 gap-[6px]">
        {["Efficiency", "Quality Score", "Capacity"].map((label, index) => <div key={label} className="flex min-h-[63px] flex-col justify-between rounded-[10px] border border-[#1e2a35] bg-[#0d141b] p-[9px_8px]"><div className="truncate font-mono text-[10px] font-bold uppercase tracking-[.55px] text-[#82a7b9]">{label}</div><div className={`text-[16px] font-extrabold leading-none ${index === 0 ? "text-[#3ecf8e]" : index === 1 ? "text-[#f5b942]" : "text-[#2dd4bf]"}`}>—</div></div>)}
      </div>
      <section className="mt-[9px] rounded-[10px] border border-[#1e2a35] bg-[#0d141b] p-[10px_11px]"><div className="mb-2 text-[11.5px] font-extrabold text-[#e9f0f6]">Today&apos;s tasks</div><div className="text-[11.5px] leading-[1.45] text-[#8fbac7]">No open tasks assigned to you. You&apos;re clear.</div></section>
      <section className="mt-[9px] rounded-[10px] border border-[#1e2a35] bg-[#0d141b] p-[10px_11px]">
        <div className="mb-2 text-[11.5px] font-extrabold text-[#e9f0f6]">Daily Report</div>
        <div className={`rounded-[9px] border p-[8px_9px] text-[11.5px] font-extrabold ${submitted ? "border-[#3ecf8e]/35 bg-[#3ecf8e]/[.07] text-[#a9e7c9]" : "border-[#f5b942]/35 bg-[#f5b942]/[.06] text-[#f1dfba]"}`}>{submitted ? "✓ Daily Report submitted" : "○ Daily Report not filed yet"}</div>
        <label className="mt-[9px] block"><span className="mb-[5px] block text-[10.5px] font-bold uppercase tracking-[.45px] text-[#8fbac7]">Deliverables completed</span><textarea value={deliverables} onChange={(event) => setDeliverables(event.target.value)} placeholder="One per line — the concrete outputs you finished today" className={`min-h-[58px] w-full resize-y rounded-[9px] border bg-[#0f171d] p-[8px_9px] text-[11.5px] leading-[1.4] text-[#e9f0f6] outline-none placeholder:text-[#7893a2] ${error ? "border-[#f5b942]" : "border-[#2b3a46] focus:border-[#2dd4bf]"}`} /></label>
        <label className="mt-[9px] block"><span className="mb-[5px] block text-[10.5px] font-bold uppercase tracking-[.45px] text-[#8fbac7]">Summary <small className="normal-case text-[#70899a]">context, next steps</small></span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Context, blockers, next steps" className="min-h-[48px] w-full resize-y rounded-[9px] border border-[#2b3a46] bg-[#0f171d] p-[8px_9px] text-[11.5px] leading-[1.4] text-[#e9f0f6] outline-none placeholder:text-[#7893a2] focus:border-[#2dd4bf]" /></label>
        <div className="mt-[9px] flex items-center justify-between gap-2"><span className="text-[10.5px] text-[#8fbac7]">Required to complete the workday.</span><button type="button" onClick={submit} className="h-[29px] rounded-[9px] border-0 bg-[#25aaa7] px-3 text-[11px] font-extrabold text-[#04201f]">{submitted ? "Submitted" : "Submit Daily Report"}</button></div>
      </section>
    </div>
  );
}

/* The Activity card walks Tony's roster one agent at a time — ‹ / › move
   through the same nodes his orbit renders, so each step swaps in that agent's
   own planet (Commerce is the terran blue-green world, Governance keeps its
   ring) along with its name and what it does. Wraps in both directions. */
function ActivityCarousel() {
  const [index, setIndex] = useState(0);
  const [size, setSize] = useState(110);
  const agent = AGENTS[index];

  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const sync = () => setSize(query.matches ? 110 : 84);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const step = (delta: number) => setIndex((current) => (current + delta + AGENTS.length) % AGENTS.length);

  return (
    <>
      <div className="flex flex-1 flex-wrap items-center justify-center gap-x-[18px] gap-y-3 px-0.5 pb-2 pt-1 lg:flex-nowrap lg:items-stretch lg:justify-start">
        <button type="button" onClick={() => step(-1)} aria-label="Previous agent" className="my-auto grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border border-[#1e2a35] bg-[#0d141b] text-[16px] font-extrabold text-[#8b9aa8] transition-colors hover:border-[#2dd4bf]/45 hover:text-[#e9f0f6]">‹</button>
        <div className="flex shrink-0 flex-col items-center gap-[10px]"><div className="grid h-[84px] w-[84px] place-items-center sm:h-[110px] sm:w-[110px]"><AgentPlanet agent={agent} size={size} /></div><div className="text-center text-[13px] font-extrabold leading-[1.15] text-[#e9f0f6]">{agent.name}</div></div>
        <div className="order-last flex w-full min-w-0 items-center lg:order-none lg:w-auto lg:flex-1"><p className="text-center text-[12.5px] leading-[1.55] text-[#8b9aa8] lg:text-justify">{agent.desc}</p></div>
        <button type="button" onClick={() => step(1)} aria-label="Next agent" className="my-auto grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full border border-[#1e2a35] bg-[#0d141b] text-[16px] font-extrabold text-[#8b9aa8] transition-colors hover:border-[#2dd4bf]/45 hover:text-[#e9f0f6]">›</button>
      </div>
      <div className="mt-[10px] flex flex-wrap justify-center gap-[5px]">{AGENTS.map((item, dot) => <button key={item.name} type="button" onClick={() => setIndex(dot)} aria-label={item.name} aria-current={dot === index} className={`h-1.5 w-1.5 rounded-full ${dot === index ? "bg-[#2dd4bf] shadow-[0_0_6px_#2dd4bf]" : "bg-[#1e2a35]"}`} />)}</div>
    </>
  );
}

export function DevBentoDashboard({ profile }: { profile: SessionProfile }) {
  const firstName = profile.full_name.split(/\s+/)[0] || "User";
  const [railView, setRailView] = useState<RailView>("live");

  const openRailView = (mode: RailView) => {
    if (mode === "live") {
      setRailView("live");
      return;
    }
    setRailView((current) => current === mode ? "live" : mode);
  };

  return (
    <div className="w-full text-[#e9f0f6]" style={{ fontFamily: SYSTEM_FONT }}>
      <div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-3 px-1 pb-[10px] sm:px-4">
        <div className="min-w-0">
          <h1 className="text-[clamp(22px,6vw,32px)] font-extrabold leading-[1.04] tracking-[-.8px] text-[#e9f0f6]">Welcome Back, <span className="font-medium text-[#8b9aa8]">{firstName.toLowerCase()}</span></h1>
          <p className="mt-2 flex items-center gap-[7px] text-[12.5px] font-bold leading-[1.2] tracking-[.25px] text-[#8b9aa8]"><span className="text-[13px] leading-none text-[#2dd4bf]">◷</span><LiveClock /></p>
        </div>

        <div className="flex items-center gap-[5px] rounded-full border border-white/[.055] bg-[#0d141b]/80 p-[4px_6px] shadow-[inset_0_1px_0_rgba(255,255,255,.035),0_4px_14px_rgba(0,0,0,.16)]">
          <QuickActionButton mode="dailyTap" label="Daily Tap" active={railView === "dailyTap"} onClick={openRailView}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]"><path d="M12 2v6"/><path d="m8.5 5.5 3.5 3.5 3.5-3.5"/><rect x="5" y="10" width="14" height="10" rx="3"/><path d="M9 15h6"/></svg></QuickActionButton>
          <QuickActionButton mode="quickEntry" label="Quick Entry" active={railView === "quickEntry"} onClick={openRailView}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-[15px] w-[15px]"><path d="M12 5v14M5 12h14"/></svg></QuickActionButton>
          <QuickActionButton mode="report" label="Report" active={railView === "report"} onClick={openRailView}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg></QuickActionButton>
          <QuickActionButton mode="live" label="Video" active={railView === "live"} onClick={openRailView}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg></QuickActionButton>
        </div>
      </div>

      <div className="grid w-full grid-cols-1 items-start gap-4 pt-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-x-[18px]">
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-[minmax(200px,280px)_minmax(0,1fr)] lg:h-[500px]">
          <section className={`${card} relative flex flex-col overflow-hidden p-5 lg:h-[500px]`}>
            <div className="relative space-y-[17px]">
              <div><div className="flex items-center gap-2 text-[10px] font-semibold leading-[1.2] text-[#8b9aa8]"><span>Gross Merchandise Value</span><RangePill>Monthly</RangePill></div><div className="mt-[5px] truncate text-[24px] font-extrabold leading-none tracking-[-.6px] lg:text-[28px] text-[#2dd4bf]">₱15,329,268</div></div>
              <div><div className="text-[10px] font-semibold leading-[1.2] text-[#8b9aa8]">Agents Live</div><div className="mt-[5px] truncate text-[24px] font-extrabold leading-none tracking-[-.6px] lg:text-[28px]">10 / 12</div></div>
              <div><div className="flex items-center gap-2 text-[10px] font-semibold leading-[1.2] text-[#8b9aa8]"><span>In Review Gate</span><RangePill>Monthly</RangePill></div><div className="mt-[5px] truncate text-[24px] font-extrabold leading-none tracking-[-.6px] lg:text-[28px]">6</div></div>
              <div><div className="flex items-center gap-2 text-[10px] font-semibold leading-[1.2] text-[#8b9aa8]"><span>Leads</span><RangePill>Today</RangePill></div><div className="mt-[5px] truncate text-[24px] font-extrabold leading-none tracking-[-.6px] lg:text-[28px]">11</div></div>
            </div>
            <div className="absolute inset-x-0 bottom-0 h-[120px] bg-gradient-to-t from-[rgba(45,212,191,.20)] to-transparent" />
            <div className="relative mt-auto text-[14px] font-semibold text-[#2dd4bf]">System Optimal</div>
          </section>

          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:h-[500px] lg:grid-cols-[1.25fr_1fr] lg:grid-rows-[242px_242px]">
            <section className={`${card} flex min-h-[242px] min-w-0 flex-col lg:h-[242px] p-5`}>
              <CardTitle icon="🪐">Activity</CardTitle>
              <ActivityCarousel />
            </section>

            <section className={`${card} flex min-h-[242px] min-w-0 flex-col lg:h-[242px] px-5 py-4`}>
              <CardTitle icon="🔄" tight>Workflow Activity</CardTitle>
              <div className="flex flex-1 flex-col items-center justify-center"><div className="relative h-[118px] w-[118px]"><svg viewBox="0 0 100 100" className="h-full w-full -rotate-90"><circle cx="50" cy="50" r="45" fill="none" stroke="#0d141b" strokeWidth="10"/><circle cx="50" cy="50" r="45" fill="none" stroke="#2dd4bf" strokeWidth="10" strokeDasharray="165 283" strokeDashoffset="0" strokeLinecap="round"/><circle cx="50" cy="50" r="45" fill="none" stroke="#a78bfa" strokeWidth="10" strokeDasharray="83 283" strokeDashoffset="-165" strokeLinecap="round"/><circle cx="50" cy="50" r="45" fill="none" stroke="#f5b942" strokeWidth="10" strokeDasharray="35 283" strokeDashoffset="-248" strokeLinecap="round"/></svg><div className="absolute inset-0 grid place-items-center text-center"><div><div className="text-[20px] font-extrabold leading-none">48</div><div className="mt-1 text-[12px] font-semibold text-[#8b9aa8]">Total Tasks</div></div></div></div><div className="mt-3 flex flex-wrap justify-center gap-3 text-[11px] font-bold text-[#8b9aa8]"><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[#2dd4bf]"/>Completed 28</span><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[#a78bfa]"/>Queued 14</span><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[#f5b942]"/>In Progress 6</span></div></div>
            </section>

            <section className={`${card} flex min-h-[242px] min-w-0 flex-col lg:h-[242px] p-[18px_20px]`}>
              <CardTitle icon="💸">Gross Merchandise Value</CardTitle>
              <div className="flex min-h-0 flex-1 flex-col"><div className="mb-2 shrink-0 truncate text-[20px] font-semibold leading-none text-[#e9f0f6] sm:text-[22px] lg:text-[28px]">₱15,329,268</div><div className="min-h-[72px] w-full flex-1"><svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-label="GMV trend"><defs><linearGradient id="dev-spend-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a78bfa" stopOpacity=".3"/><stop offset="100%" stopColor="#a78bfa" stopOpacity="0"/></linearGradient></defs><path d="M0,40 L16.7,34.4 L33.3,37.2 L50,23.2 L66.7,15.8 L83.3,18.6 L100,0 L100,40 Z" fill="url(#dev-spend-grad)"/><path d="M0,40 L16.7,34.4 L33.3,37.2 L50,23.2 L66.7,15.8 L83.3,18.6 L100,0" fill="none" stroke="#a78bfa" strokeWidth="2.4" vectorEffect="non-scaling-stroke"/></svg></div><div className="mt-3 flex shrink-0 flex-wrap gap-3 text-[11px] font-bold text-[#8b9aa8]"><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[#f472b6]"/>TikTok 46%</span><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[#f5b942]"/>Shopee 33%</span><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-[#5aa9e6]"/>Lazada 21%</span></div></div>
            </section>

            <section className={`${card} flex min-h-[242px] min-w-0 flex-col lg:h-[242px] p-[18px_20px]`}><CardTitle icon="⚡" tight>System Resources</CardTitle><div className="flex flex-col gap-[9px]"><ResourceRow label="Tokens Today" value="428.5k" width="75%"/><ResourceRow label="Audio processing" value="1.2h" width="30%"/><ResourceRow label="Vision queries" value="842" width="55%"/></div></section>
          </div>
        </div>

        <aside className={`${card} flex min-h-[529px] min-w-0 flex-col overflow-y-auto border-dashed p-[15px] xl:h-[529px] xl:min-h-0`}>
          {railView === "dailyTap" ? <DailyTapRail firstName={firstName} /> : railView === "quickEntry" ? <QuickEntryRail /> : railView === "report" ? <ReportRail firstName={firstName} onQuickEntry={() => setRailView("quickEntry")} /> : <LiveVideoRail />}
        </aside>
      </div>
    </div>
  );
}
