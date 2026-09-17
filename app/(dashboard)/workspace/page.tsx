import Link from "next/link";

import { modulesForRole, workspaceRoleForProfile } from "@/lib/auth/module-access";
import { requireProfile } from "@/lib/auth/session";

const MODULE_ICONS: Record<string, string> = {
  campaigns: "CM",
  orders: "TO",
  ads: "AO",
  records: "OR",
  clients: "CL",
  "ecommerce-analytics": "EA",
  creative: "CS",
  "vesper-studio": "VS",
  calendar: "CC",
  "creative-analytics": "CA",
  warehouse: "WO",
  "products-intelligence": "PI",
  products: "PM",
  stock: "ST",
  rts: "RT",
  cases: "CM",
  "warehouse-analytics": "WA",
  "live-wall": "VW",
  "live-selling": "LS",
  "live-operations": "LO",
  "live-analytics": "LA",
  "host-attendance": "HA",
  "affiliate-campaigns": "AC",
  creators: "CR",
  leads: "LD",
  outreach: "BD",
  delivery: "CD",
  "affiliate-reach": "AR",
  "affiliate-analytics": "AA",
  finance: "FN",
  expenses: "EX",
  "expense-records": "ER",
  budgets: "BG",
  "expense-audit": "EA",
  payroll: "PY",
  leaderboard: "LB",
  people: "PP",
  probation: "PB",
  "daily-logs": "DL",
  recruitment: "RC",
  moderation: "MQ",
  lms: "LM",
};

export default async function WorkspacePage() {
  const profile = await requireProfile();
  const role = workspaceRoleForProfile(profile);
  const modules = modulesForRole(role);

  return (
    <main className="min-h-screen bg-[#080b11] px-6 py-8 text-[#e6eef3] md:px-10 md:py-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-teal-300">M-THRYVE OS</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight">Your workspace</h1>
          <p className="mt-2 max-w-2xl text-sm text-[#8b9aa8]">
            Open a module available to your current role. Access is enforced again on each destination.
          </p>
        </div>

        {modules.length === 0 ? (
          <section className="rounded-2xl border border-[#20313c] bg-[#0b1319] p-8">
            <h2 className="text-lg font-extrabold">No modules assigned</h2>
            <p className="mt-2 text-sm text-[#8b9aa8]">
              Your profile does not currently have a workspace role with assigned modules.
            </p>
          </section>
        ) : (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map((module) => (
              <Link
                key={`${module.id}-${module.href}`}
                href={module.href}
                className="group rounded-2xl border border-[#20313c] bg-[#0b1319] p-5 transition hover:border-teal-300/40 hover:bg-[#0d171e] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
              >
                <div className="flex items-start gap-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[#243741] bg-[#080e13] text-[10px] font-black tracking-wide text-teal-300">
                    {MODULE_ICONS[module.id] ?? module.label.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-extrabold text-[#e6eef3] group-hover:text-teal-200">
                      {module.label}
                    </h2>
                    <p className="mt-1 truncate text-xs text-[#6f8491]">{module.href}</p>
                  </div>
                </div>
                <div className="mt-5 text-[10px] font-black uppercase tracking-[0.14em] text-[#6f8491] group-hover:text-teal-300">
                  Open module →
                </div>
              </Link>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
