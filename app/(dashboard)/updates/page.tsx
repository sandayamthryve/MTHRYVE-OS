import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { FeatureUpdates } from "@/components/updates/FeatureUpdates";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

type EventRow = {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  event_date: string | null;
  created_at: string;
  scope: string;
};

async function postUpdate(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as {
    id: string;
    org_id: string;
  };
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const supabase = createServerSupabaseClient();
  await (
    supabase as unknown as {
      from: (t: string) => { insert: (v: Record<string, unknown>) => Promise<unknown> };
    }
  )
    .from("events")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      scope: "org",
      kind: String(formData.get("kind") ?? "update"),
      severity: String(formData.get("severity") ?? "info"),
      title,
      body: String(formData.get("body") ?? "") || null,
      event_date: String(formData.get("event_date") ?? "") || null,
    });
  revalidatePath("/updates");
}

const SEV_STYLES: Record<string, string> = {
  info: "border-charcoal-700",
  warning: "border-gold-400/40",
  critical: "border-red-500/40",
};
const SEV_TEXT: Record<string, string> = {
  info: "text-teal-300",
  warning: "text-gold-400",
  critical: "text-red-400",
};

export default async function UpdatesPage() {
  const profile = await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const canPost = ["ceo", "coo", "department_head"].includes(profile.role);
  const supabase = createServerSupabaseClient();
  const res = await supabase
    .from("events")
    .select("id, kind, severity, title, body, event_date, created_at, scope")
    .order("created_at", { ascending: false });
  const events = (res.data ?? []) as unknown as EventRow[];

  return (
    <AppShell breadcrumb={["Mthryve OS", "Updates"]} profile={profile}>
      <PageHeader title={<>Updates</>} />

      <FeatureUpdates />

      <div className="mb-3 mt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal-400">Company feed</p>
        <h2 className="mt-1 text-xl font-semibold text-ink">Updates &amp; alerts</h2>
      </div>

      {canPost && (
        <form action={postUpdate} className="mb-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              name="title"
              required
              placeholder="Title"
              className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink sm:col-span-2"
            />
            <textarea
              name="body"
              placeholder="Details (optional)"
              className="min-h-[70px] rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink sm:col-span-2"
            />
            <select name="kind" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
              <option value="update">Update</option>
              <option value="event">Event</option>
              <option value="alert">Alert</option>
            </select>
            <select name="severity" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
            <input
              name="event_date"
              type="date"
              className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            />
          </div>
          <button
            type="submit"
            className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
          >
            Post update
          </button>
        </form>
      )}

      <ul className="space-y-3">
        {events.length === 0 && <li className="text-sm text-ink-muted">No updates yet.</li>}
        {events.map((e) => (
          <li key={e.id} className={`rounded-lg border bg-charcoal-900 p-4 ${SEV_STYLES[e.severity] ?? SEV_STYLES.info}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-ink">{e.title}</span>
              <span className={`font-mono text-[10px] uppercase tracking-wider ${SEV_TEXT[e.severity] ?? SEV_TEXT.info}`}>
                {e.kind}
                {e.severity !== "info" ? ` · ${e.severity}` : ""}
              </span>
            </div>
            {e.body && <p className="mt-1 text-sm text-ink-muted">{e.body}</p>}
            <p className="mt-2 font-mono text-[10px] text-ink-muted">
              {e.event_date ? `${e.event_date} · ` : ""}
              {new Date(e.created_at).toLocaleDateString()}
            </p>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
