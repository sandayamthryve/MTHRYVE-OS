"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { SessionProfile } from "@/lib/auth/session";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "M";
}

export function DevProfileMenu({ profile }: { profile?: SessionProfile }) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const name = profile?.full_name || "M-THRYVE User";
  const email = profile?.email || "dev@mthryve.co";

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setNotificationsOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setNotificationsOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    await fetch("/api/dev/role", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "operator" }),
    }).catch(() => undefined);
    document.cookie = "mthryve_dev_demo=; Path=/; Max-Age=0; SameSite=Lax";
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch {
      // Dev-channel bypass may not have a Supabase session. Clearing the dev
      // cookie is enough; keep logout deterministic either way.
    }
    router.push("/login");
    router.refresh();
  }

  function toggleNotifications() {
    setOpen(false);
    setNotificationsOpen((value) => !value);
  }

  function toggleAccountMenu() {
    setNotificationsOpen(false);
    setOpen((value) => !value);
  }

  return (
    <div ref={rootRef} className="relative flex items-center gap-[2px] rounded-full border border-white/[.035] bg-[#080c11]/55 p-[4px_5px] shadow-[inset_0_1px_5px_rgba(0,0,0,.28)]">
      <button
        type="button"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={notificationsOpen}
        aria-controls="dev-notification-popover"
        title="Notifications"
        onClick={toggleNotifications}
        className={`grid h-9 w-9 place-items-center rounded-full border-0 transition ${notificationsOpen ? "bg-[#151e27] text-[#e9f0f6]" : "bg-transparent text-[#8b9aa8] hover:bg-[#0d141b] hover:text-[#e9f0f6]"}`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4" />
        </svg>
      </button>

      {notificationsOpen && (
        <div
          id="dev-notification-popover"
          role="dialog"
          aria-label="Notifications"
          className="absolute right-[54px] top-[calc(100%+14px)] z-[650] w-[390px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[22px] border border-[#1e2a35] bg-[#0d141b]/[.99] shadow-[0_22px_55px_rgba(0,0,0,.58)] backdrop-blur-[16px]"
        >
          <span aria-hidden className="absolute -top-[7px] right-[25px] h-[14px] w-[14px] rotate-45 border-l border-t border-[#1e2a35] bg-[#0d141b]" />
          <div className="relative flex items-center justify-between border-b border-[#1e2a35] px-5 py-4">
            <div>
              <h2 className="text-[13px] font-extrabold tracking-[.1px] text-[#e9f0f6]">Notifications</h2>
              <p className="mt-0.5 text-[10.5px] text-[#6f8190]">Recent M-THRYVE OS activity</p>
            </div>
          </div>

          {/* Keep the header popover intentionally compact: render at most three notification rows here. */}
          <div className="relative grid min-h-[168px] place-items-center px-6 py-8 text-center">
            <div>
              <div className="mx-auto mb-3 grid h-9 w-9 place-items-center rounded-full border border-[#1e2a35] bg-[#111820] text-[#6f8190]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                  <path d="M10 21h4" />
                </svg>
              </div>
              <p className="text-[11.5px] font-bold text-[#aab6c0]">No new notifications</p>
              <p className="mt-1 text-[10px] text-[#657786]">Updates will appear here when they arrive.</p>
            </div>
          </div>

          <div className="border-t border-[#1e2a35] p-3">
            <Link
              href="/notifications"
              onClick={() => setNotificationsOpen(false)}
              className="flex h-9 w-full items-center justify-center rounded-[11px] border border-[#263441] bg-[#111820] text-[11px] font-extrabold text-[#aab6c0] transition hover:border-[#2dd4bf]/50 hover:bg-[#151e27] hover:text-[#2dd4bf]"
            >
              View more
            </Link>
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleAccountMenu}
        className={`ml-[2px] flex h-9 items-center gap-[6px] rounded-full border-0 px-2 py-[3px] pl-1 text-[#8b9aa8] transition ${open ? "bg-[#151e27] text-[#e9f0f6]" : "bg-[#111820] hover:bg-[#151e27] hover:text-[#e9f0f6]"}`}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-[#a78bfa] to-[#2dd4bf] text-[10px] font-black text-[#071015] shadow-[0_0_0_1px_rgba(255,255,255,.08)]">
          {initials(name)}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-3 w-3 transition-transform duration-150 ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+10px)] z-[600] w-[min(222px,calc(100vw-2rem))] rounded-[14px] border border-[#1e2a35] bg-[#0d141b]/[.98] p-[7px] shadow-[0_18px_45px_rgba(0,0,0,.52)] backdrop-blur-[14px]">
          <div className="mb-[5px] min-w-0 border-b border-[#1e2a35] px-[10px] pb-[10px] pt-[9px]">
            <b className="block truncate text-[11.5px] font-extrabold text-[#e9f0f6]">{name}</b>
            <span className="mt-[2px] block truncate text-[10px] text-[#8b9aa8]">{email}</span>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={busy}
            className="flex w-full items-center gap-[9px] rounded-[9px] border-0 bg-transparent px-[10px] py-[9px] text-left text-[11.5px] font-bold text-[#8b9aa8] transition hover:bg-[rgba(242,109,109,.09)] hover:text-[#f26d6d] disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] shrink-0" aria-hidden>
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            </svg>
            <span>{busy ? "Logging out…" : "Log out"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
