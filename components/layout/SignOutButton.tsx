"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Tooltip } from "@/components/ui/Tooltip";

// Small client island inside the otherwise-server AppShell. Signs the user out
// via Supabase (clears the auth cookie) and returns them to /login.
export function SignOutButton({ devMode = false }: { devMode?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    if (devMode) {
      await fetch("/api/dev/role", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "operator" }),
      }).catch(() => undefined);
      document.cookie = "mthryve_dev_demo=; Path=/; Max-Age=0; SameSite=Lax";
      window.location.assign("/login");
      return;
    }
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const button = (
    <button
      onClick={handleSignOut}
      disabled={busy}
      aria-label="Sign out"
      className="flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink disabled:opacity-60"
    >
      {/* Icon-only below lg (dense mobile/tablet top bar); label appears at lg+. */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="shrink-0 lg:hidden"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="M16 17l5-5-5-5" />
        <path d="M21 12H9" />
      </svg>
      <span className="hidden lg:inline">{busy ? "Signing out…" : "Sign out"}</span>
    </button>
  );

  return <Tooltip content="Sign out" position="bottom" delay={150}>{button}</Tooltip>;
}
