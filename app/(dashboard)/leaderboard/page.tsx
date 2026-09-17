import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

// M5 — Gamification. Points recognize good work; the leaderboard makes it
// visible. Heads and above award points; everyone sees the standings.

type UserRow = { id: string; full_name: string; role: string; avatar_url: string | null };
type Award = { id: string; user_id: string; points: number; reason: string | null; created_at: string };

type DbShim = {
  from: (t: string) => { insert: (v: Record<string, unknown>) => Promise<unknown> };
};

async function awardPoints(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as {
    id: string;
    org_id: string;
  };
  const user_id = String(formData.get("user_id") ?? "");
  const points = Math.round(Number(formData.get("points") ?? 0));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!user_id || !points) return;

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("points_awards").insert({
    org_id: profile.org_id,
    awarded_by: profile.id,
    user_id,
    points,
    reason: reason || null,
  });
  revalidatePath("/leaderboard");
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

const MEDAL = ["🥇", "🥈", "🥉"];

export default async function LeaderboardPage() {
  const profile = await requireModule("/leaderboard");
  const canAward = profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const supabase = createServerSupabaseClient();

  const [usersRes, awardsRes] = await Promise.all([
    supabase.from("users").select("id, full_name, role, avatar_url").order("full_name"),
    supabase.from("points_awards").select("id, user_id, points, reason, created_at").order("created_at", { ascending: false }).limit(100),
  ]);

  const users = (usersRes.data ?? []) as unknown as UserRow[];
  const awards = (awardsRes.data ?? []) as unknown as Award[];
  const userById = new Map(users.map((u) => [u.id, u]));

  const totals = new Map<string, number>();
  for (const a of awards) totals.set(a.user_id, (totals.get(a.user_id) ?? 0) + Number(a.points ?? 0));

  const board = users
    .map((u) => ({ user: u, points: totals.get(u.id) ?? 0 }))
    .sort((a, b) => b.points - a.points);
  const maxPoints = Math.max(1, ...board.map((b) => b.points));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Leaderboard"]} profile={profile}>
      <PageHeader
        title="Leaderboard"
        subtitle="Recognition for the work that moves the needle. Points are earned, not bought."
      />

      <div className="mb-8 overflow-hidden rounded-lg border border-charcoal-700 bg-charcoal-900">
        {board.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-muted">No team members yet.</p>
        ) : (
          board.map((row, i) => (
            <div key={row.user.id} className="flex items-center gap-3 border-b border-charcoal-700/60 px-4 py-3 last:border-0">
              <span className="w-6 text-center font-mono text-sm text-ink-muted">{MEDAL[i] ?? i + 1}</span>
              <span
                aria-hidden
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-500/15 text-xs font-medium text-teal-400 ring-1 ring-teal-500/30"
              >
                {initials(row.user.full_name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center justify-between">
                  <span className="truncate text-sm text-ink">{row.user.full_name}</span>
                  <span className="font-mono text-sm font-semibold text-teal-300">{row.points} pts</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal-800">
                  <div className="h-full rounded-full bg-teal-500" style={{ width: `${(row.points / maxPoints) * 100}%` }} />
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {canAward && (
        <form action={awardPoints} className="mb-8 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
          <h2 className="mb-3 text-sm font-semibold text-ink">Award points</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <select name="user_id" required className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
              <option value="">Team member…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
            <input name="points" type="number" required placeholder="Points (e.g. 10)" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
            <input name="reason" placeholder="Reason (e.g. hit GMV target)" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
          </div>
          <button type="submit" className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
            Award
          </button>
        </form>
      )}

      <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Recent awards</h2>
      <div className="overflow-hidden rounded-lg border border-charcoal-700 bg-charcoal-900">
        {awards.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-muted">No awards yet.</p>
        ) : (
          awards.slice(0, 25).map((a) => (
            <div key={a.id} className="flex items-center justify-between border-b border-charcoal-700/60 px-4 py-2.5 last:border-0">
              <span className="text-sm text-ink">
                {userById.get(a.user_id)?.full_name ?? "Someone"}
                {a.reason ? <span className="text-ink-muted"> — {a.reason}</span> : ""}
              </span>
              <span className="font-mono text-sm text-teal-300">+{a.points}</span>
            </div>
          ))
        )}
      </div>
    </AppShell>
  );
}
