import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Global search across the OS: brands, leads, campaigns, events.
// RLS keeps every query org-scoped automatically. Read-only.

type Hit = { href: string; title: string; sub: string; group: string };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const profile = await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const q = (searchParams.q ?? "").trim();
  const supabase = createServerSupabaseClient();
  const hits: Hit[] = [];

  if (q.length >= 2) {
    // Strip characters that would break PostgREST's or() filter grammar.
    const safe = q.replace(/[,()%]/g, " ").trim();
    const like = `%${safe}%`;

    const [brands, leads, campaigns, events] = await Promise.all([
      supabase.from("brands").select("id, name, category, status").ilike("name", like).limit(20),
      supabase
        .from("leads")
        .select("id, name, company, stage")
        .or(`name.ilike.${like},company.ilike.${like},email.ilike.${like}`)
        .limit(20),
      supabase.from("campaigns").select("id, name, status, department").ilike("name", like).limit(20),
      supabase
        .from("events")
        .select("id, title, kind, severity")
        .or(`title.ilike.${like},body.ilike.${like}`)
        .limit(20),
    ]);

    for (const b of (brands.data ?? []) as unknown as { id: string; name: string; category: string | null; status: string | null }[]) {
      hits.push({ href: "/", title: b.name, sub: [b.category, b.status].filter(Boolean).join(" · ") || "Brand", group: "Brands" });
    }
    for (const l of (leads.data ?? []) as unknown as { id: string; name: string; company: string | null; stage: string }[]) {
      hits.push({ href: "/leads", title: l.name, sub: [l.company, l.stage].filter(Boolean).join(" · ") || "Lead", group: "Leads" });
    }
    for (const c of (campaigns.data ?? []) as unknown as { id: string; name: string; status: string | null; department: string | null }[]) {
      hits.push({ href: "/campaigns", title: c.name, sub: [c.department, c.status].filter(Boolean).join(" · ") || "Campaign", group: "Campaigns" });
    }
    for (const e of (events.data ?? []) as unknown as { id: string; title: string; kind: string | null; severity: string | null }[]) {
      hits.push({ href: "/updates", title: e.title, sub: [e.kind, e.severity].filter(Boolean).join(" · ") || "Update", group: "Updates" });
    }
  }

  const groups = Array.from(new Set(hits.map((h) => h.group)));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Search"]} profile={profile}>
      <PageHeader
        title="Search"
        subtitle="Find brands, leads, campaigns, and updates across the OS."
      />

      <form action="/search" method="get" className="mb-6 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="Search brands, leads, campaigns, updates…"
          className="w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
        />
        <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
          Search
        </button>
      </form>

      {q.length < 2 ? (
        <p className="text-sm text-ink-muted">Type at least 2 characters to search.</p>
      ) : hits.length === 0 ? (
        <p className="text-sm text-ink-muted">No matches for &ldquo;{q}&rdquo;.</p>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g}>
              <h2 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">{g}</h2>
              <div className="overflow-hidden rounded-lg border border-charcoal-700 bg-charcoal-900">
                {hits
                  .filter((h) => h.group === g)
                  .map((h, i) => (
                    <Link
                      key={`${g}-${i}`}
                      href={h.href}
                      className="flex items-center justify-between border-b border-charcoal-700/60 px-4 py-3 last:border-0 hover:bg-charcoal-800"
                    >
                      <span className="text-sm text-ink">{h.title}</span>
                      <span className="text-xs text-ink-muted">{h.sub}</span>
                    </Link>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}
