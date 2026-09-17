import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENTITY_TYPES = new Set(["metric_entry", "daily_report", "live_session"]);
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024; // 25 MB — covers short capture videos
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = { from: (t: string) => any };

// POST /api/quick-entry/evidence — attach one piece of evidence recorded from the
// Quick-Entry grid to the metric_entry (or report / session) it substantiates.
// Multipart form:
//   • file? (photo/video/screenshot) OR source_url? (a link) OR storage_path?
//     (a bucket object ALREADY uploaded — the "Snap to fill" image the vision
//     route stored) — at least one;
//   • kind (photo|video|screenshot|link) — a hint; inferred from the file/link
//     when absent or invalid;
//   • entity_type (default 'metric_entry'), entity_id (uuid — the row just saved);
//   • vision_extract? (JSON) — the machine reading, kept as a SUGGESTION trail.
//
// A file lands in the private 'evidence' bucket under "<org_id>/quick-entry/<file>"
// (the flat quick-entry folder the schema expects), and an evidence_attachments
// row records it at ORG level (org_id + uploaded_by = the signed-in user). RLS is
// the real write boundary; any authenticated org member may attach.
export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const entityType = String(form.get("entity_type") ?? "metric_entry");
  if (!ENTITY_TYPES.has(entityType)) {
    return NextResponse.json({ error: "Unknown entity_type." }, { status: 400 });
  }

  const entityId = String(form.get("entity_id") ?? "");
  if (!UUID_RE.test(entityId)) {
    return NextResponse.json({ error: "A valid entity_id is required." }, { status: 400 });
  }

  const file = form.get("file");
  const sourceUrl =
    typeof form.get("source_url") === "string" ? (form.get("source_url") as string).trim() : "";
  const rawKind = String(form.get("kind") ?? "").trim();
  const hasFile = file instanceof File && file.size > 0;

  // A bucket object already uploaded by the vision route ("Snap to fill" image). We
  // record a row against it WITHOUT re-uploading. Guard it to the caller's own org
  // prefix so a client can never point an attachment at another org's object.
  const storagePath =
    typeof form.get("storage_path") === "string" ? (form.get("storage_path") as string).trim() : "";
  const hasStoragePath =
    storagePath !== "" &&
    !/^https?:\/\//i.test(storagePath) &&
    storagePath.startsWith(`${profile.org_id}/`);
  if (storagePath !== "" && !hasStoragePath) {
    return NextResponse.json({ error: "Invalid storage_path." }, { status: 400 });
  }

  if (!hasFile && !sourceUrl && !hasStoragePath) {
    return NextResponse.json({ error: "Attach a file or a link." }, { status: 400 });
  }
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
    return NextResponse.json({ error: "A link must start with http:// or https://." }, { status: 400 });
  }

  // The machine reading the user saw, echoed back as a SUGGESTION trail. A bad
  // blob is simply "no reading" — never a hard error.
  let visionExtract: Record<string, unknown> | null = null;
  const rawExtract = form.get("vision_extract");
  if (typeof rawExtract === "string" && rawExtract.trim() !== "") {
    try {
      const parsed = JSON.parse(rawExtract);
      if (parsed && typeof parsed === "object") visionExtract = parsed as Record<string, unknown>;
    } catch {
      visionExtract = null;
    }
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  let url = "";
  let kind = normalizeKind(rawKind, hasFile ? (file as File).type : null, Boolean(sourceUrl));

  if (hasStoragePath) {
    // Already in the bucket — just record the row against the existing object.
    url = storagePath;
  } else if (hasFile) {
    const f = file as File;
    if (f.size > MAX_EVIDENCE_BYTES) {
      return NextResponse.json({ error: "Capture is too large (max 25 MB)." }, { status: 413 });
    }
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "capture";
    // Flat quick-entry folder, exactly as the schema expects: <org_id>/quick-entry/<file>.
    const path = `${profile.org_id}/quick-entry/${Date.now()}_${safe}`;
    const buf = Buffer.from(await f.arrayBuffer());
    const { error: upErr } = await supabase.storage
      .from("evidence")
      .upload(path, buf, { contentType: f.type || "application/octet-stream", upsert: false });
    if (upErr) {
      return NextResponse.json({ error: upErr.message || "Could not store the capture." }, { status: 502 });
    }
    url = path;
  } else {
    url = sourceUrl;
    kind = "link";
  }

  const { data: inserted, error: insErr } = await db
    .from("evidence_attachments")
    // `as never` per the codebase's @supabase/ssr write-inference convention.
    .insert({
      org_id: profile.org_id,
      entity_type: entityType,
      entity_id: entityId,
      url,
      kind,
      source_url: sourceUrl || null,
      vision_extract: visionExtract,
      uploaded_by: profile.id,
    } as never)
    .select("id")
    .maybeSingle();

  if (insErr) {
    // Roll back the stored object so we never orphan it (only bucket paths, not links).
    if (hasFile && url && !/^https?:\/\//i.test(url)) {
      try {
        await supabase.storage.from("evidence").remove([url]);
      } catch {
        /* best-effort */
      }
    }
    return NextResponse.json({ error: insErr.message || "Could not record the evidence." }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    evidence_id: (inserted as { id: string } | null)?.id ?? null,
    kind,
  });
}

// Kind is one of photo/video/screenshot/link. A caller hint wins when valid; else
// infer from the mime type (video/* → video, image/* → photo) or link presence.
function normalizeKind(
  hint: string,
  mime: string | null,
  isLink: boolean
): "photo" | "video" | "screenshot" | "link" {
  if (hint === "photo" || hint === "video" || hint === "screenshot" || hint === "link") return hint;
  if (mime && mime.startsWith("video/")) return "video";
  if (mime && mime.startsWith("image/")) return "photo";
  if (isLink) return "link";
  return "photo";
}
