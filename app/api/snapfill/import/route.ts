import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { sanitizeClientSchema } from "@/lib/snapfill/schema";
import { parseImportFile, isImportError } from "@/lib/snapfill/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/snapfill/import — parse a dropped/uploaded spreadsheet (.csv / .xlsx /
// .xlsm) on the SERVER through the SAME exceljs path the bulk import uses, and hand
// the mapped records back to a SnapFill mount (multipart form: `file`, `schema` (the
// mount's field whitelist)). This is what a dropped .xlsx routes to — the file is
// never read as text in the browser (which would dump its raw "PK…" ZIP bytes).
//
// It never writes: the mount fills its form from the returned records (SnapFill uses
// the first row for a single-record fill), and the host's own role-gated path
// commits. Auth-gated; the shared parser enforces size + row caps.
export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid form data." }, { status: 400 });
  }

  const file = form.get("file");
  const fields = sanitizeClientSchema(String(form.get("schema") ?? ""));
  if (fields.length === 0) {
    return NextResponse.json({ ok: false, error: "A non-empty field whitelist is required." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "No file received." }, { status: 400 });
  }

  const parsed = await parseImportFile(file, fields);
  if (isImportError(parsed)) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 200 });
  }

  return NextResponse.json(
    {
      ok: true,
      records: parsed.records,
      ignoredHeaders: parsed.ignoredHeaders,
      skippedRows: parsed.skippedRows,
      truncated: parsed.truncated,
      totalRows: parsed.totalRows,
      format: parsed.format,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
