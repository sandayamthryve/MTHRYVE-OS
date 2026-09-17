"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { modulesForRole, type WorkspaceRole } from "@/lib/auth/module-access";

const SEARCH_ITEMS = [
  { title: "Home", desc: "Command center and operating overview", href: "/", icon: "⌂" },
  { title: "Tasks", desc: "Work queue and execution", href: "/tasks", icon: "✓" },
  { title: "My Workspace", desc: "Your personal dashboard and daily report", href: "/employee", icon: "◉" },
  { title: "People", desc: "Team, roles, and access", href: "/people", icon: "◉" },
  { title: "Review Gate", desc: "People decisions awaiting approval", href: "/reviewgate", icon: "◉" },
  { title: "Tony", desc: "Open the AI copilot", href: "/tony", icon: "✦" },
  { title: "Metrics", desc: "Performance and operating metrics", href: "/metrics", icon: "▥" },
  { title: "Daily Tap", desc: "Daily operating pulse", href: "/daily-tap", icon: "◷" },
  { title: "Updates", desc: "Latest updates and activity", href: "/updates", icon: "↻" },
  { title: "Warehouse", desc: "Warehouse and fulfillment overview", href: "/warehouse/overview", icon: "▣" },
  { title: "Creative Studio", desc: "Creative production workspace", href: "/creative-studio", icon: "✧" },
  { title: "Reports", desc: "Reports and review surfaces", href: "/reports", icon: "▤" },
  { title: "Live", desc: "Live selling workspace", href: "/live", icon: "◫" },
  { title: "Live Wall", desc: "Live command wall", href: "/live-wall", icon: "▦" },
  { title: "Quick Entry", desc: "Fast metric and record entry", href: "/quick-entry", icon: "+" },
];

export function DevGlobalSearch({ role = "operator" }: { role?: WorkspaceRole }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const items = role === "operator" ? SEARCH_ITEMS : modulesForRole(role).map((module) => ({
      title: module.label, desc: "Open module", href: module.href, icon: "↗",
    }));
    return items.filter((item) => `${item.title} ${item.desc}`.toLowerCase().includes(q)).slice(0, 7);
  }, [query, role]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    router.push(href);
  };

  const askTony = () => {
    const q = query.trim();
    setOpen(false);
    setQuery("");
    router.push(q ? `/tony?q=${encodeURIComponent(q)}` : "/tony");
  };

  const overlay = open && typeof document !== "undefined"
    ? createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search M-THRYVE OS"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
          className="fixed inset-0 z-[9999] flex items-start justify-center overflow-y-auto bg-[#020508]/80 px-3 pb-8 pt-[calc(74px+env(safe-area-inset-top))] backdrop-blur-[5px] sm:px-7 sm:pt-[106px]"
        >
          <div className="w-full max-w-[680px] animate-[searchPop_.32s_cubic-bezier(.2,.8,.2,1)] rounded-[17px] border border-[#293845] bg-[#0d141b]/[.99] p-2 shadow-[0_28px_80px_rgba(0,0,0,.68),inset_0_1px_0_rgba(255,255,255,.035)]">
            <div className="flex h-11 items-center gap-[10px] rounded-[14px] border border-[#1e2a35] bg-[#091016] pl-[13px] pr-[9px] focus-within:border-[#2dd4bf]/55 focus-within:shadow-[0_0_0_3px_rgba(45,212,191,.08)]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-[19px] w-[19px] shrink-0 text-[#8b9aa8]">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && results[0]) go(results[0].href);
                }}
                autoComplete="off"
                spellCheck={false}
                placeholder="Search pages, workspaces, records..."
                className="min-w-0 flex-1 bg-transparent text-[14px] font-semibold text-[#e9f0f6] outline-none placeholder:font-semibold placeholder:text-[#60707d]"
              />
              <button type="button" aria-label="Close search" onClick={() => setOpen(false)} className="grid h-[31px] w-[31px] place-items-center rounded-[9px] text-[19px] text-[#8b9aa8] transition hover:bg-[#111820] hover:text-[#e9f0f6]">×</button>
            </div>

            <div className="flex items-center justify-between gap-[10px] px-[5px] pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-[.35px] text-[#8b9aa8]">
              {role === "operator" && <button type="button" onClick={askTony} className="flex h-6 items-center gap-1.5 rounded-full border border-[#a78bfa]/20 bg-[#a78bfa]/[.07] px-[9px] text-[9.5px] font-extrabold normal-case text-[#b9a8ff] transition hover:-translate-y-px hover:border-[#a78bfa]/50 hover:bg-[#a78bfa]/15 hover:text-[#ddd5ff]">
                <span>🧠</span><span>Ask Tony</span>
              </button>}
              <kbd className="rounded-md border border-[#1e2a35] bg-[#091016] px-1.5 py-[3px] font-mono text-[9px] normal-case text-[#71818e]">Esc to close</kbd>
            </div>

            {query.trim() && (
              <div className="max-h-[min(350px,45dvh)] overflow-y-auto p-0.5">
                {results.length ? results.map((item, index) => (
                  <button
                    key={item.href}
                    type="button"
                    onClick={() => go(item.href)}
                    className={`grid w-full grid-cols-[38px_1fr_auto] items-center gap-[10px] rounded-xl p-[10px] text-left transition hover:bg-[#111b24] ${index === 0 ? "bg-[#111b24]" : ""}`}
                  >
                    <span className="grid h-9 w-9 place-items-center rounded-[11px] border border-[#1e2a35] bg-[#091016] text-[15px] text-[#8b9aa8]">{item.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-extrabold text-[#e9f0f6]">{item.title}</span>
                      <span className="mt-0.5 block truncate text-[10.5px] text-[#8b9aa8]">{item.desc}</span>
                    </span>
                    <span className="pr-[3px] text-[17px] text-[#536674]">›</span>
                  </button>
                )) : (
                  <div className="px-4 py-8 text-center text-xs text-[#8b9aa8]"><b className="mb-1 block text-[13px] text-[#e9f0f6]">No matching pages</b>Try another search.</div>
                )}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        type="button"
        aria-label="Search M-THRYVE OS"
        onClick={() => setOpen(true)}
        className="absolute left-1/2 top-1/2 hidden h-9 w-[280px] -translate-x-1/2 -translate-y-1/2 items-center justify-start gap-[9px] rounded-full border border-white/[.045] bg-[#080c11]/55 px-[14px] text-[11.5px] font-bold text-[#8b9aa8] shadow-[inset_0_1px_5px_rgba(0,0,0,.24)] transition hover:-translate-y-[52%] hover:border-[#1e2a35] hover:bg-[#0d141b] hover:text-[#e9f0f6] md:flex"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 shrink-0">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span>Search</span>
      </button>

      <button
        type="button"
        aria-label="Search M-THRYVE OS"
        onClick={() => setOpen(true)}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/[.045] bg-[#080c11]/55 text-[#8b9aa8] transition hover:border-[#1e2a35] hover:bg-[#0d141b] hover:text-[#e9f0f6] md:hidden"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-[17px] w-[17px]">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </button>

      {overlay}

      <style jsx global>{`
        @keyframes searchPop {
          from { opacity: 0; transform: translateY(-22px) scale(.88); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </>
  );
}
