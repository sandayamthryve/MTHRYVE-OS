import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PageHeader, TableShell, rowClass, Badge, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { ingestDocument } from "@/lib/knowledge/ingest";
import { isEmbeddingConfigured } from "@/lib/knowledge/embed";
import { extForFilename } from "@/lib/knowledge/extract";
import type {
  DocumentSourceType,
  DocumentStatus,
  DocumentSensitivity,
} from "@/types/database";
import { UploadControl, type UploadState } from "./UploadControl";
import { DocRowActions } from "./DocRowActions";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// Knowledge base — the ingestion + management desk for the RAG document store.
//
// Leadership and department heads upload SOPs, playbooks, contracts and reports
// here; each file is stored privately, chunked (~800 tokens / ~100 overlap) and
// embedded so it becomes retrievable by semantic search (lib/knowledge/search →
// match_document_chunks, permission-aware via RLS). This page is the upload
// form, the per-document status list, and the re-ingest / delete controls.
//
// Uploading is gated to ceo / coo / department_head — the same roles the
// documents_write RLS policy allows. Retrieval permissioning ('leadership' docs
// to ceo/coo only) is enforced entirely in the database, not here.

export const dynamic = "force-dynamic";

const WRITE_ROLES = ["ceo", "coo", "department_head"] as const;
const SOURCE_TYPES: DocumentSourceType[] = ["sop", "playbook", "contract", "report", "other"];
const SENSITIVITIES: DocumentSensitivity[] = ["org", "leadership"];
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

type DocRow = {
  id: string;
  title: string;
  source_type: string;
  sensitivity: string;
  status: string;
  chunk_count: number;
  department_id: string | null;
  storage_path: string | null;
  uploaded_by: string | null;
  created_at: string;
  archived_at: string | null;
};

// ── Server action: upload a file, create the document row, ingest it ──────────
async function uploadDocument(_prev: UploadState, formData: FormData): Promise<UploadState> {
  "use server";
  const profile = await requireRole([...WRITE_ROLES]);

  const file = formData.get("file");
  const title = String(formData.get("title") ?? "").trim();
  const sourceType = String(formData.get("source_type") ?? "").trim();
  const sensitivity = String(formData.get("sensitivity") ?? "").trim();
  const departmentId = String(formData.get("department_id") ?? "").trim() || null;

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a file to upload." };
  }
  if (!title) return { ok: false, message: "Give the document a title." };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "File is too large (20 MB max)." };
  }
  const ext = extForFilename(file.name);
  if (!ext) {
    return { ok: false, message: "Unsupported file type — use PDF, DOCX, TXT or MD." };
  }
  if (!SOURCE_TYPES.includes(sourceType as DocumentSourceType)) {
    return { ok: false, message: "Pick a valid source type." };
  }
  if (!SENSITIVITIES.includes(sensitivity as DocumentSensitivity)) {
    return { ok: false, message: "Pick a valid sensitivity." };
  }

  const supabase = createServerSupabaseClient();

  // Generate the id up front so the storage path can nest under it; the file's
  // real extension is preserved so ingestion can pick the right extractor.
  const documentId = crypto.randomUUID();
  const storagePath = `${profile.org_id}/${documentId}/source.${ext}`;

  // Upload the original under the caller's RLS (Storage policy: write roles,
  // own org folder).
  const { error: uploadErr } = await supabase.storage
    .from("documents")
    .upload(storagePath, file, {
      contentType: file.type || undefined,
      upsert: false,
    });
  if (uploadErr) {
    console.error("[knowledge] upload failed", uploadErr.message);
    return { ok: false, message: "Upload failed — please try again." };
  }

  // Create the document row (status 'processing'). RLS re-checks org + role.
  const { error: insertErr } = await supabase.from("documents").insert({
    id: documentId,
    org_id: profile.org_id,
    title,
    source_type: sourceType,
    sensitivity,
    department_id: departmentId,
    storage_path: storagePath,
    status: "processing",
    chunk_count: 0,
    uploaded_by: profile.id,
  } as never);
  if (insertErr) {
    console.error("[knowledge] document insert failed", insertErr.message);
    // Roll back the orphaned file so a retry with the same name is clean.
    await supabase.storage.from("documents").remove([storagePath]);
    return { ok: false, message: "Could not save the document record." };
  }

  // Run the pipeline now so the list reflects the final state on refresh. The
  // heavy chunk writes inside use the service role.
  const result = await ingestDocument(documentId);
  revalidatePath("/knowledge");

  if (result.status === "ready") {
    return {
      ok: true,
      message: `"${title}" ingested — ${result.chunkCount} chunk${
        result.chunkCount === 1 ? "" : "s"
      } embedded and ready to search.`,
    };
  }
  return {
    ok: false,
    message: `"${title}" was uploaded but ingestion failed (${result.error ?? "error"}). Use Re-ingest to retry.`,
  };
}

// ── Server action: re-run ingestion for an existing document ──────────────────
async function reingestDocument(formData: FormData): Promise<void> {
  "use server";
  await requireRole([...WRITE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // Confirm visibility under the caller's RLS before the service-role pipeline.
  const supabase = createServerSupabaseClient();
  const { data: doc } = await supabase.from("documents").select("id").eq("id", id).maybeSingle();
  if (!doc) return;

  await ingestDocument(id);
  revalidatePath("/knowledge");
}

// ── Server action: delete a document (chunks cascade) + its stored file ───────
async function deleteDocument(formData: FormData): Promise<void> {
  "use server";
  await requireRole([...WRITE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createServerSupabaseClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("id, storage_path")
    .eq("id", id)
    .maybeSingle();
  if (!doc) return;

  const path = (doc as { storage_path: string | null }).storage_path;
  if (path) {
    await supabase.storage.from("documents").remove([path]);
  }
  // Deleting the row cascades document_chunks (ON DELETE CASCADE). RLS scopes
  // the delete to the caller's org + write role.
  await supabase.from("documents").delete().eq("id", id);
  revalidatePath("/knowledge");
}

// ── Presentational helpers ────────────────────────────────────────────────────
const STATUS_TONE: Record<DocumentStatus, BadgeTone> = {
  processing: "amber",
  ready: "teal",
  failed: "red",
};
const STATUS_LABEL: Record<DocumentStatus, string> = {
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

function whenLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const archived = searchParams?.archived === "1";
  const profile = await requireModule("/knowledge");
  const supabase = createServerSupabaseClient();

  const docsQ = supabase
    .from("documents")
    .select(
      "id, title, source_type, sensitivity, status, chunk_count, department_id, storage_path, uploaded_by, created_at, archived_at"
    )
    .order("created_at", { ascending: false });
  const [docsRes, deptRes, usersRes] = await Promise.all([
    archived ? docsQ.not("archived_at", "is", null) : docsQ.is("archived_at", null),
    supabase.from("departments").select("id, name").order("name"),
    supabase.from("users").select("id, full_name"),
  ]);

  const docs = (docsRes.data ?? []) as unknown as DocRow[];
  const departments = (deptRes.data ?? []) as unknown as { id: string; name: string }[];
  const users = (usersRes.data ?? []) as unknown as { id: string; full_name: string }[];
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const userName = new Map(users.map((u) => [u.id, u.full_name]));

  const readyCount = docs.filter((d) => d.status === "ready").length;
  const embeddingReady = isEmbeddingConfigured();

  return (
    <AppShell breadcrumb={["Mthryve OS", "Knowledge"]} profile={profile}>
      <PageHeader
        title="Knowledge Base"
        subtitle={
          docs.length === 0
            ? "Upload SOPs, playbooks, contracts and reports to make them searchable by the AI."
            : `${docs.length} document${docs.length === 1 ? "" : "s"} · ${readyCount} ready to search.`
        }
      />

      {!embeddingReady && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          <span className="font-semibold">Embeddings not configured.</span> Set{" "}
          <code className="font-mono text-xs">OPENAI_API_KEY</code> so uploads can be chunked and
          embedded. Uploads will save but ingestion will fail until it's set.
        </div>
      )}

      {/* Upload */}
      <Card className="mb-6">
        <h2 className="mb-1 text-sm font-semibold text-ink">Add a document</h2>
        <p className="mb-4 text-xs text-ink-muted">
          Leadership and department heads only. Files are stored privately and never exposed to the
          browser.
        </p>
        <UploadControl action={uploadDocument} departments={departments} />
      </Card>

      {/* Document list */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">
          {archived ? "Archived documents" : "Documents"}
        </h2>
        <ArchivedToggle basePath="/knowledge" archived={archived} />
      </div>

      {docs.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">
            {archived
              ? "No archived documents."
              : "No documents yet — upload one above to get started."}
          </p>
        </Card>
      ) : (
        <TableShell
          columns={["Document", "Type", "Sensitivity", "Department", "Chunks", "Status", "Added", "", "Manage"]}
        >
          {docs.map((d) => {
            const status = (d.status as DocumentStatus) ?? "processing";
            const uploader = d.uploaded_by ? userName.get(d.uploaded_by) : null;
            return (
              <tr key={d.id} className={rowClass}>
                <td className="p-3">
                  <p className="font-medium text-ink">{d.title}</p>
                  <p className="font-mono text-[10px] text-ink-dim">
                    {uploader ? `by ${uploader}` : "—"}
                  </p>
                </td>
                <td className="p-3 text-ink-muted">{titleCase(d.source_type)}</td>
                <td className="p-3">
                  {d.sensitivity === "leadership" ? (
                    <Badge tone="violet">Leadership</Badge>
                  ) : (
                    <Badge tone="muted">Org</Badge>
                  )}
                </td>
                <td className="p-3 text-ink-muted">
                  {d.department_id ? deptName.get(d.department_id) ?? "—" : "—"}
                </td>
                <td className="p-3 font-mono text-xs text-ink-muted">{d.chunk_count}</td>
                <td className="p-3">
                  <Badge tone={STATUS_TONE[status] ?? "muted"}>
                    {STATUS_LABEL[status] ?? titleCase(d.status)}
                  </Badge>
                </td>
                <td className="p-3 font-mono text-[11px] text-ink-dim">{whenLabel(d.created_at)}</td>
                <td className="p-3 text-right">
                  <DocRowActions
                    id={d.id}
                    reingestAction={reingestDocument}
                    deleteAction={deleteDocument}
                  />
                </td>
                <td className="p-3">
                  <RowActions
                    {...rowActionProps("documents", d as unknown as Record<string, unknown>, profile)}
                  />
                </td>
              </tr>
            );
          })}
        </TableShell>
      )}
    </AppShell>
  );
}
