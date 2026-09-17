"use client";

import { useState } from "react";

function enterDemo(remember: boolean) {
  const maxAge = remember ? 60 * 60 * 24 * 7 : 60 * 60 * 8;
  document.cookie = `mthryve_dev_demo=active; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  // Land on Home. A "next" set by the middleware still wins, so anyone bounced
  // here from a deep link returns to the page they asked for -- only the plain
  // sign-in default changed, from /updates to the dashboard.
  const next = new URLSearchParams(window.location.search).get("next");
  window.location.assign(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startDemo(selectedEmail?: string) {
    setError(null);
    if (selectedEmail) setEmail(selectedEmail);
    setBusy(true);
    window.setTimeout(() => enterDemo(remember), 450);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter an email and password, or use Quick Sign In for the operator account.");
      return;
    }
    startDemo();
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#040608] px-5 py-8 text-ink">
      <div aria-hidden className="absolute inset-0" style={{ backgroundImage: "radial-gradient(circle at 14% 18%,rgba(166,233,255,.75) 0 1px,transparent 1.5px),radial-gradient(circle at 72% 12%,rgba(166,233,255,.55) 0 1px,transparent 1.5px),radial-gradient(circle at 83% 64%,rgba(166,233,255,.45) 0 1px,transparent 1.5px),radial-gradient(circle at 32% 78%,rgba(166,233,255,.55) 0 1px,transparent 1.5px),radial-gradient(ellipse at 50% 28%,#101c27 0%,#080c11 55%,#040608 100%)", backgroundSize: "170px 150px,230px 210px,190px 180px,260px 220px,100% 100%" }} />
      <div aria-hidden className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-[58%] rounded-full bg-[radial-gradient(circle,rgba(45,212,191,.14)_0%,rgba(167,139,250,.08)_45%,transparent_72%)]" />

      <section className="relative z-10 w-full max-w-[388px] rounded-2xl border border-charcoal-700 bg-charcoal-900/95 px-6 py-8 sm:px-8 shadow-[0_24px_70px_rgba(0,0,0,.55)] backdrop-blur">
        <header className="mb-6 flex flex-col items-center gap-2.5 text-center">
          <div className="grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-gradient-to-br from-teal-400 to-green-500 text-2xl font-black text-[#04120c] shadow-[0_6px_22px_rgba(45,212,191,.35)]">M</div>
          <div><h1 className="text-base font-extrabold tracking-[.4px]">M-THRYVE OS</h1><p className="mt-0.5 font-mono text-[10px] uppercase tracking-[1.8px] text-ink-muted">Sign in to your workspace</p></div>
        </header>

        {error && <p role="alert" className="mb-4 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-400">{error}</p>}
        <button type="button" disabled={busy} onClick={() => startDemo()} className="mb-[18px] flex w-full items-center justify-center rounded-[10px] border border-purple-400 bg-gradient-to-br from-purple-400/20 to-teal-400/15 px-3 py-3 text-[13px] font-extrabold transition hover:-translate-y-px hover:border-teal-400 disabled:opacity-60">{busy ? "Opening workspace…" : "⚡ Quick Sign In (Operator)"}</button>
        <div className="mb-4 flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[.8px] text-ink-muted before:h-px before:flex-1 before:bg-charcoal-700 after:h-px after:flex-1 after:bg-charcoal-700">or sign in manually</div>

        <form onSubmit={submit} autoComplete="off">
          <label htmlFor="email" className="mb-1.5 block text-[10.5px] font-bold uppercase tracking-[.6px] text-ink-muted">Email</label>
          <div className="relative mb-4 flex items-center"><span aria-hidden className="absolute left-3 text-xs text-ink-muted">✉</span><input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@brand.com" className="w-full rounded-[9px] border border-charcoal-700 bg-charcoal-850 py-2.5 pl-9 pr-3 text-[13px] outline-none transition placeholder:text-ink-dim focus:border-teal-400 focus:ring-2 focus:ring-teal-400/10" /></div>
          <label htmlFor="password" className="mb-1.5 block text-[10.5px] font-bold uppercase tracking-[.6px] text-ink-muted">Password</label>
          <div className="relative mb-3 flex items-center"><span aria-hidden className="absolute left-3 text-xs text-ink-muted">🔒</span><input id="password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" className="w-full rounded-[9px] border border-charcoal-700 bg-charcoal-850 py-2.5 pl-9 pr-14 text-[13px] outline-none transition placeholder:text-ink-dim focus:border-teal-400 focus:ring-2 focus:ring-teal-400/10" /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 text-[10px] font-bold tracking-wide text-ink-muted hover:text-teal-400">{showPassword ? "HIDE" : "SHOW"}</button></div>
          <div className="mb-5 flex items-center justify-between text-xs"><label className="flex cursor-pointer items-center gap-2 text-ink-muted"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="accent-teal-400" />Remember me</label><button type="button" onClick={() => setError("This dev build uses demo sessions. Use Quick Sign In for the operator account.")} className="font-semibold text-teal-400 hover:underline">Forgot password?</button></div>
          <button type="submit" disabled={busy} className="flex w-full items-center justify-center rounded-[10px] bg-gradient-to-br from-teal-400 to-green-500 px-3 py-3 text-[13.5px] font-extrabold tracking-[.3px] text-[#03120b] shadow-[0_8px_24px_rgba(45,212,191,.28)] transition hover:-translate-y-px hover:brightness-105 disabled:opacity-60">{busy ? "Signing in…" : "Sign In"}</button>
        </form>

        <div className="my-4 flex items-start gap-2.5 rounded-[10px] border border-charcoal-700 bg-charcoal-850 px-3 py-2.5 text-[11.5px] leading-5 text-ink-muted"><span aria-hidden>🧠</span><p><b className="text-purple-400">Tony:</b> This is a dev/test build — use Quick Sign In for an instant demo session.</p></div>
        <p className="mt-5 text-center text-[11px] text-ink-muted">Don&apos;t have a workspace yet? <button type="button" onClick={() => setError("Contact your M-THRYVE OS administrator to get set up.")} className="font-bold text-teal-400 hover:underline">Request access</button></p>
      </section>
    </main>
  );
}
