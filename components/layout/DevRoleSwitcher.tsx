"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { WORKSPACE_ROLES as VIEW_AS_ROLES, type WorkspaceRole as ViewAsRole, isWorkspaceRole as isViewAsRole } from "@/lib/auth/module-access";

const ORDER_STORAGE_KEY = "mthryve:dev:view-as-order";
const DEFAULT_ORDER = VIEW_AS_ROLES.map((role) => role.id) as ViewAsRole[];
const ROLES_PER_PAGE = 3;

function normalizeOrder(values: string[]): ViewAsRole[] {
  const valid = values.filter(isViewAsRole);
  const unique = valid.filter((id, index) => valid.indexOf(id) === index && id !== "operator");
  const remaining = DEFAULT_ORDER.filter((id) => id !== "operator" && !unique.includes(id));
  return ["operator", ...unique, ...remaining];
}

export function DevRoleSwitcher({ activeRoleId = "operator" }: { activeRoleId?: ViewAsRole }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const swipeStartY = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const viewAs = activeRoleId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleOrder, setRoleOrder] = useState<ViewAsRole[]>(DEFAULT_ORDER);
  const [reordering, setReordering] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    try {
      const savedOrder = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? "[]") as string[];
      const normalized = normalizeOrder(savedOrder);
      setRoleOrder(normalized);
      window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      setRoleOrder(DEFAULT_ORDER);
    }
  }, []);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setReordering(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setReordering(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, [open]);

  const orderedRoles = useMemo(
    () => roleOrder.map((id) => VIEW_AS_ROLES.find((role) => role.id === id)).filter(Boolean) as (typeof VIEW_AS_ROLES)[number][],
    [roleOrder]
  );

  const rolePages = useMemo(() => {
    const pages: (typeof VIEW_AS_ROLES)[number][][] = [];
    for (let i = 0; i < orderedRoles.length; i += ROLES_PER_PAGE) pages.push(orderedRoles.slice(i, i + ROLES_PER_PAGE));
    return pages;
  }, [orderedRoles]);

  const activeRole = VIEW_AS_ROLES.find((role) => role.id === viewAs) ?? VIEW_AS_ROLES[0];

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(rolePages.length - 1, 0)));
  }, [rolePages.length]);

  async function setViewAs(roleId: ViewAsRole) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/dev/role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: roleId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not switch role.");
      // A full navigation discards the previous role's prefetched RSC payloads.
      // The server cookie, not localStorage, determines the active permissions.
      window.location.assign(result.href);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not switch role.");
      setBusy(false);
    }
  }

  function quickViewAs(roleId: ViewAsRole) {
    setViewAs(roleId);
  }

  function moveRole(roleId: ViewAsRole, direction: -1 | 1) {
    if (roleId === "operator") return;

    setRoleOrder((current) => {
      const index = current.indexOf(roleId);
      const nextIndex = index + direction;

      if (index < 0 || nextIndex < 1 || nextIndex >= current.length) return current;

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      const normalized = normalizeOrder(next);
      window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    });
  }

  function resetOrder() {
    setRoleOrder(DEFAULT_ORDER);
    setPage(0);
    window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(DEFAULT_ORDER));
  }

  function goToPage(nextPage: number) {
    setPage(Math.max(0, Math.min(nextPage, rolePages.length - 1)));
  }

  function onTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    swipeStartY.current = event.touches[0]?.clientY ?? null;
  }

  function onTouchEnd(event: React.TouchEvent<HTMLDivElement>) {
    const startY = swipeStartY.current;
    const endY = event.changedTouches[0]?.clientY;
    swipeStartY.current = null;
    if (startY == null || endY == null) return;
    const delta = endY - startY;
    if (Math.abs(delta) < 42) return;
    goToPage(page + (delta < 0 ? 1 : -1));
  }

  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (Math.abs(event.deltaY) < 18) return;
    goToPage(page + (event.deltaY > 0 ? 1 : -1));
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Switch role preview, currently viewing as ${activeRole.label}`}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex h-[36px] items-center gap-2 rounded-full border px-3 text-[11px] font-extrabold shadow-[inset_0_1px_0_rgba(255,255,255,.035)] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 ${open ? "border-teal-300/45 bg-[#111b22] text-teal-200" : "border-[#20313c] bg-[#0b1319] text-[#d8e2e9] hover:border-[#2a414e] hover:bg-[#101920]"}`}
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[#243741] bg-[#080e13] text-[12px] leading-none">{activeRole.icon}</span>
        <span className="whitespace-nowrap"><span className="text-[#8b9aa8]">View as:</span>{" "}<span className="text-teal-300">{activeRole.label}</span></span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`ml-0.5 shrink-0 text-[#6f8491] transition-transform duration-200 ${open ? "rotate-180 text-teal-300" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {error && <p role="alert" className="absolute right-0 top-12 z-[80] w-64 rounded-lg border border-red-400/40 bg-[#0b1319] p-3 text-xs text-red-300">{error}</p>}
      {open && (
        <div role="menu" aria-label="View M-THRYVE OS as role" className="absolute right-0 top-[44px] z-[70] w-[min(320px,calc(100vw-1.5rem))] rounded-2xl border border-[#20313c] bg-[#0b1319]/[0.98] p-2 shadow-[0_22px_55px_rgba(0,0,0,.58)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3 px-3 pb-2 pt-1">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-teal-300">Viewing as · {activeRole.label}</p>
              <p className="mt-1 text-[11px] text-ink-dim">{reordering ? "Use the arrows to set your role order" : "Swipe or scroll vertically · 3 roles per snap"}</p>
            </div>
            <button type="button" onClick={() => setReordering((value) => !value)} className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[10px] font-bold transition focus:outline-none focus-visible:ring-1 focus-visible:ring-teal-300 ${reordering ? "border-teal-400/40 bg-teal-400/10 text-teal-200" : "border-[#243741] bg-[#101920] text-ink-muted hover:text-ink"}`}>{reordering ? "Done" : "Reorder"}</button>
          </div>

          <div className="relative h-[174px] overflow-hidden overscroll-contain touch-pan-x" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onWheel={onWheel}>
            <div className="transition-transform duration-300 ease-out" style={{ transform: `translateY(-${page * 174}px)` }}>
              {rolePages.map((roles, pageIndex) => (
                <div key={pageIndex} className="grid h-[174px] shrink-0 content-start gap-1">
                  {roles.map((role) => {
                    const index = orderedRoles.findIndex((item) => item.id === role.id);
                    const active = role.id === viewAs;
                    const isOperator = role.id === "operator";

                    return (
                      <div key={role.id} className={`grid min-h-[54px] w-full ${reordering ? "grid-cols-[minmax(0,1fr)_68px]" : "grid-cols-[minmax(0,1fr)]"} items-center gap-1 rounded-xl transition ${active ? "bg-teal-400/10 text-ink" : "text-ink-muted hover:bg-[#111b23] hover:text-ink"}`}>
                        <button type="button" role="menuitem" disabled={busy} onClick={() => !reordering && quickViewAs(role.id)} aria-disabled={reordering} className={`grid min-w-0 grid-cols-[34px_minmax(0,1fr)_18px] items-center gap-2 rounded-xl px-2.5 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-teal-300 ${reordering ? "cursor-default" : ""}`}>
                          <span className="grid h-8 w-8 place-items-center rounded-lg border border-[#1d2c35] bg-[#080e13] text-base">{role.icon}</span>
                          <span className="min-w-0">
                            <span className="flex items-center gap-1 truncate text-xs font-extrabold"><span className="truncate">{role.label}</span></span>
                            <span className="mt-0.5 block truncate text-[10px] font-medium text-ink-dim">{role.description}</span>
                          </span>
                          <span className={`text-center text-xs text-teal-300 ${active ? "opacity-100" : "opacity-0"}`}>✓</span>
                        </button>

                        {reordering && (
                          isOperator ? (
                            <div className="mr-1 flex items-center justify-center text-[9px] font-bold uppercase tracking-[0.08em] text-ink-dim">Pinned</div>
                          ) : (
                            <div className="mr-1 flex items-center justify-end gap-1">
                              <button type="button" aria-label={`Move ${role.label} up`} title="Move up" disabled={index <= 1} onClick={() => moveRole(role.id, -1)} className="grid h-8 w-8 place-items-center rounded-lg border border-[#22343e] bg-[#0d161c] text-sm text-ink-muted transition hover:text-teal-200 disabled:cursor-not-allowed disabled:opacity-25">↑</button>
                              <button type="button" aria-label={`Move ${role.label} down`} title="Move down" disabled={index === orderedRoles.length - 1} onClick={() => moveRole(role.id, 1)} className="grid h-8 w-8 place-items-center rounded-lg border border-[#22343e] bg-[#0d161c] text-sm text-ink-muted transition hover:text-teal-200 disabled:cursor-not-allowed disabled:opacity-25">↓</button>
                            </div>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 flex-col gap-1.5" aria-hidden="true">
              {rolePages.map((_, index) => <span key={index} className={`w-1.5 rounded-full transition-all ${page === index ? "h-5 bg-teal-300" : "h-1.5 bg-[#34505d]"}`} />)}
            </div>
          </div>

          {reordering && (
            <div className="mt-2 flex justify-end border-t border-[#1a2a33] px-2 pt-2">
              <button type="button" onClick={resetOrder} className="rounded-lg px-2 py-1 text-[10px] font-semibold text-ink-dim transition hover:bg-[#111b23] hover:text-ink">Reset order</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
