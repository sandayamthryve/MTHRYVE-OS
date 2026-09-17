import { requireModule } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, Card, Badge, TableShell, rowClass } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasVesperStudioAccess } from "@/lib/vesper/access";
import { isCloudinaryConfigured } from "@/lib/cloudinary/config";
import { readJobs } from "@/lib/vesper/jobs";
import { JOB_STATUS_LABEL, jobStatusTone, type ClipJob } from "@/lib/vesper/types";
import { VesperUploadCard } from "@/components/vesper/VesperUploadCard";

// Vesper Studio ▸ Ingest surface (Phase 1). Upload a TikTok LIVE replay via a
// SIGNED DIRECT Cloudinary upload (browser → Cloudinary, never through Vercel),
// which then creates a vesper_clip_jobs row. Below the uploader is a read-only
// list of recent jobs with their HONEST state — everything stays 'queued' until
// the Phase 2 clipping worker exists.
//
// Gate: Creative department members + department_head + ceo/coo (the shared
// Vesper access gate). Others are bounced to their own home.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

type Brand = { id: string; name: string; status: string | null };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function VesperStudioPage() {
  const profile = await requireModule("/studio/vesper");
  const supabase = createServerSupabaseClient();

  // Gate: only Creative dept + leadership. Bounce everyone else to their home.
  if (!profile.preview_role && !(await hasVesperStudioAccess(supabase, profile))) redirect("/");

  const configured = isCloudinaryConfigured();

  // Load brands (RLS-scoped to the org). We read status so the picker offers only
  // ACTIVE brands, while still resolving names for jobs tied to archived brands
  // (archive-aware). status defaults to 'active'; 'archived' is the retired state.
  const { data: brandsData } = await supabase
    .from("brands")
    .select("id, name, status")
    .order("name");
  const allBrands = (brandsData ?? []) as unknown as Brand[];
  const activeBrands = allBrands
    .filter((b) => (b.status ?? "active") !== "archived")
    .map((b) => ({ id: b.id, name: b.name }));
  const brandName = new Map(allBrands.map((b) => [b.id, b.name] as const));

  // Recent jobs (RLS-scoped). Read-only — honest live state.
  const jobs: ClipJob[] = await readJobs(supabase, { limit: 25 });

  return (
    <AppShell breadcrumb={["Mthryve OS", "Creative", "Vesper Studio"]} profile={profile}>
      <PageHeader
        title="Vesper Studio — Ingest"
        subtitle="Upload a TikTok LIVE replay to queue it for auto-clipping. The file uploads straight to Cloudinary (never through the app), then a clip job is created for the pipeline to process."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <SectionCard title="Upload a replay">
            {configured ? (
              <VesperUploadCard brands={activeBrands} />
            ) : (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <p className="text-sm text-ink">
                  Cloudinary isn&apos;t configured yet.
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  Add <code className="font-mono text-ink-dim">CLOUDINARY_CLOUD_NAME</code>,{" "}
                  <code className="font-mono text-ink-dim">CLOUDINARY_API_KEY</code> and{" "}
                  <code className="font-mono text-ink-dim">CLOUDINARY_API_SECRET</code> in Vercel, then
                  reload. Uploads use a signed direct-to-Cloudinary flow — the API secret never
                  reaches the browser.
                </p>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Recent jobs"
            action={
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                {jobs.length} shown
              </span>
            }
          >
            {jobs.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No jobs yet. Upload a replay above to create the first one — it&apos;ll appear here as{" "}
                <span className="text-ink">Queued</span>.
              </p>
            ) : (
              <TableShell columns={["Replay", "Brand", "Status", "Stage", "Created"]}>
                {jobs.map((j) => (
                  <tr key={j.id} className={rowClass}>
                    <td className="p-3 text-ink">
                      <span className="line-clamp-1">{j.source_title || "Untitled replay"}</span>
                    </td>
                    <td className="p-3 text-ink-muted">
                      {j.brand_id ? brandName.get(j.brand_id) ?? "—" : "—"}
                    </td>
                    <td className="p-3">
                      <Badge tone={jobStatusTone(j.status)}>{JOB_STATUS_LABEL[j.status]}</Badge>
                    </td>
                    <td className="p-3 text-ink-muted">
                      <span className="line-clamp-1">{j.stage_detail || "—"}</span>
                    </td>
                    <td className="p-3 font-mono text-[10px] text-ink-dim">{fmtDate(j.created_at)}</td>
                  </tr>
                ))}
              </TableShell>
            )}
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard title="How it works">
            <ol className="space-y-3 text-sm text-ink-muted">
              <li>
                <span className="font-medium text-ink">1. Upload.</span> Your browser gets a short-lived
                signed signature, then sends the replay directly to Cloudinary — the large file never
                passes through the app.
              </li>
              <li>
                <span className="font-medium text-ink">2. Queue.</span> A clip job is created pointing at
                the stored replay. It stays <span className="text-ink">Queued</span> until the clipping
                worker runs.
              </li>
              <li>
                <span className="font-medium text-ink">3. Clip.</span> The pipeline transcribes, finds
                highlights and cuts short-form drafts for review in Creative Studio.
              </li>
            </ol>
          </SectionCard>

          <Card className="border-charcoal-700/40">
            <p className="text-xs text-ink-dim">
              Signed upload only — <code className="font-mono">CLOUDINARY_API_SECRET</code> stays on the
              server and never reaches your browser. Job states are honest: nothing shows{" "}
              <span className="text-ink-muted">Done</span> until the worker has actually produced clips.
            </p>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
