import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { canManageExpense } from "@/lib/expenses/types";
import {
  attachmentPath,
  checkAttachment,
  isAttachmentKind,
  safeFilename,
} from "@/lib/expenses/attachments";

// POST /api/finance/expenses/attachments — attach a supporting document.
//
// Multipart: expense_id, kind, file. Validation is the allowlist in
// lib/expenses/attachments.ts, which treats the EXTENSION as authoritative and
// the browser's MIME as a hint — a forged content type must not admit a file
// the extension already bans.
//
// Two ownership checks, deliberately both: this handler confirms the expense is
// in the caller's org before spending the upload, and the insert policy
// re-checks it. RLS is the authority; the check here just avoids writing bytes
// we would then have to delete.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "evidence";

// GET /api/finance/expenses/attachments?id=<attachment> — open one document.
//
// The bucket is private, so the row is resolved under RLS first and a short
// signed URL is minted only for an attachment the caller can already read. The
// storage path never reaches the client: handing it out would let someone try
// paths directly, and a listable prefix is a listable org.
export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "Missing attachment." }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as { from: (t: string) => any };

  const { data } = await db
    .from("expense_attachments")
    .select("storage_path, file_name")
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .maybeSingle();

  const row = data as { storage_path: string; file_name: string } | null;
  // Not found and not permitted are the same answer on purpose: a distinct
  // "exists but forbidden" would confirm the row to someone who cannot read it.
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const { data: signed, error } = await supabase.storage
    .from(BUCKET)
    // Two minutes: long enough to click through, short enough that a leaked
    // link is worthless by the time it travels.
    .createSignedUrl(row.storage_path, 120, { download: row.file_name });

  if (error || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not open that file." }, { status: 502 });
  }

  return NextResponse.redirect(signed.signedUrl, { status: 302 });
}

export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!canManageExpense(profile.role)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const expenseId = String(form.get("expense_id") ?? "").trim();
  const kindRaw = String(form.get("kind") ?? "other").trim();
  const file = form.get("file");

  if (!expenseId) return NextResponse.json({ error: "Missing expense." }, { status: 400 });
  if (!isAttachmentKind(kindRaw)) {
    return NextResponse.json({ error: "Unknown document type." }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Attach a file." }, { status: 400 });
  }

  const check = checkAttachment(file.name, file.size, file.type);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as { from: (t: string) => any };

  // The expense must exist in the caller's org before we store anything.
  const { data: expense } = await db
    .from("expenses")
    .select("id")
    .eq("id", expenseId)
    .eq("org_id", profile.org_id)
    .maybeSingle();
  if (!expense) {
    return NextResponse.json({ error: "That expense does not exist." }, { status: 404 });
  }

  const path = attachmentPath(profile.org_id, expenseId, file.name);
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    // The canonical type from the allowlist, not file.type: a stored object
    // must never carry a content type the caller chose.
    .upload(path, buffer, { contentType: check.contentType, upsert: false });
  if (uploadError) {
    return NextResponse.json({ error: "Could not store that file." }, { status: 502 });
  }

  const { data: row, error: rowError } = await db
    .from("expense_attachments")
    .insert({
      org_id: profile.org_id,
      expense_id: expenseId,
      kind: kindRaw,
      file_name: safeFilename(file.name),
      content_type: check.contentType,
      byte_size: file.size,
      storage_path: path,
      uploaded_by: profile.id,
    })
    .select("id, file_name, kind, byte_size, created_at")
    .maybeSingle();

  if (rowError || !row) {
    // Never orphan bytes we cannot point at: if the row lost (RLS, a race, a
    // constraint) the object goes with it.
    await supabase.storage.from(BUCKET).remove([path]);
    return NextResponse.json(
      { error: rowError?.message || "Could not record that attachment." },
      { status: 400 }
    );
  }

  return NextResponse.json({ attachment: row }, { status: 201 });
}
