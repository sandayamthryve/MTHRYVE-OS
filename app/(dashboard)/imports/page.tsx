import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, HelpHint } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { IMPORTERS, type EntityType } from "@/lib/import/registry";
import { allowedEntities } from "@/lib/import/engine";
import { ImportWizard, type ImporterMeta } from "./ImportWizard";
import { previewImport, commitImport } from "./actions";

// ── Bulk Import (CSV) ───────────────────────────────────────────────────────
// Leadership or the owning team only: products (Warehouse), creators (Business
// Development / Affiliate), historical metrics (leadership). The page shows only
// the importers the caller may actually commit — allowedEntities() mirrors the
// per-type canImport() gate, and both mirror the target tables' RLS. Every
// committed import writes an immutable import_batches audit row, listed below.

export const dynamic = "force-dynamic";

// import_batches / users reads go through this shim — import_batches isn't in the
// generated Supabase types, matching the rest of the OS.
type DbShim = { from: (t: string) => any };

type BatchRow = {
  id: string;
  entity_type: string;
  file_name: string | null;
  total_rows: number;
  imported_rows: number;
  duplicate_rows: number;
  invalid_rows: number;
  notes: string | null;
  created_at: string;
  imported_by: string | null;
};

const ENTITY_LABEL: Record<string, string> = {
  products: "Products",
  creators: "Creators",
  metric_entries: "Historical metrics",
  metrics_snapshots: "Scorecard history",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
}

export default async function ImportsPage({
  searchParams,
}: {
  searchParams?: { entity?: string };
}) {
  const profile = await requireProfile();
  const allowed = allowedEntities(profile);

  // Deep-link support: /imports?entity=products preselects that importer when the
  // caller is allowed to run it (e.g. the Warehouse Products page links here). An
  // unknown or unpermitted value is ignored and the wizard falls back to the first.
  const requested = searchParams?.entity;
  const initialEntity = requested && allowed.includes(requested as EntityType) ? requested : undefined;

  const entities: ImporterMeta[] = allowed.map((e) => {
    const def = IMPORTERS[e];
    return {
      entity: def.entity,
      label: def.label,
      description: def.description,
      ownerHint: def.ownerHint,
      dedupLabel: def.dedupLabel,
      columns: def.columns.map((c) => ({ key: c.key, label: c.label, required: Boolean(c.required), note: c.note })),
    };
  });

  // Recent audit rows (org-scoped by RLS). Cast shim — import_batches isn't in
  // the generated types, matching the rest of the OS.
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  const { data: batchData } = await db
    .from("import_batches")
    .select("id, entity_type, file_name, total_rows, imported_rows, duplicate_rows, invalid_rows, notes, created_at, imported_by")
    .order("created_at", { ascending: false })
    .limit(15);
  const batches = (batchData ?? []) as BatchRow[];

  // Resolve importer names.
  const ids = Array.from(new Set(batches.map((b) => b.imported_by).filter(Boolean))) as string[];
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    const { data: users } = await db.from("users").select("id, full_name").in("id", ids);
    for (const u of (users ?? []) as Array<{ id: string; full_name: string }>) nameById.set(u.id, u.full_name);
  }

  return (
    <AppShell breadcrumb={["Mthryve OS", "Workflow", "Bulk Import"]} profile={profile}>
      <PageHeader
        title={<>Bulk Import (CSV) <HelpHint id="work.bulkImport" /></>}
        subtitle="Upload a CSV, map columns, preview, then commit. Duplicates are blocked, invalid rows are reported, every import is audited."
      />

      {entities.length === 0 ? (
        <SectionCard title="No import access">
          <p className="text-sm text-ink-muted">
            Bulk import is limited to leadership and the owning team of each dataset (Warehouse for products, Business
            Development / Affiliate for creators, leadership for metrics). Ask your team lead if you need access.
          </p>
        </SectionCard>
      ) : (
        <ImportWizard entities={entities} initialEntity={initialEntity} previewAction={previewImport} commitAction={commitImport} />
      )}

      <div className="mt-8">
        <SectionCard title="Import history">
          {batches.length === 0 ? (
            <p className="text-sm text-ink-muted">No imports yet. Committed imports appear here with their row counts.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">File</th>
                    <th className="px-3 py-2 font-medium">By</th>
                    <th className="px-3 py-2 font-medium text-right">Imported</th>
                    <th className="px-3 py-2 font-medium text-right">Dupes</th>
                    <th className="px-3 py-2 font-medium text-right">Invalid</th>
                    <th className="px-3 py-2 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="border-t border-charcoal-800/60">
                      <td className="px-3 py-1.5 text-ink-muted">{fmtWhen(b.created_at)}</td>
                      <td className="px-3 py-1.5 text-ink">{ENTITY_LABEL[b.entity_type] ?? b.entity_type}</td>
                      <td className="px-3 py-1.5 text-ink-muted">{b.file_name ?? "—"}</td>
                      <td className="px-3 py-1.5 text-ink-muted">{b.imported_by ? nameById.get(b.imported_by) ?? "—" : "—"}</td>
                      <td className="px-3 py-1.5 text-right text-teal-300">{b.imported_rows}</td>
                      <td className="px-3 py-1.5 text-right text-amber-300">{b.duplicate_rows}</td>
                      <td className="px-3 py-1.5 text-right text-rose-300">{b.invalid_rows}</td>
                      <td className="px-3 py-1.5 text-right text-ink-dim">{b.total_rows}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </AppShell>
  );
}
