import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isVisionConfigured, readFields } from "@/lib/snapfill/vision";
import { sanitizeClientSchema } from "@/lib/snapfill/schema";
import { recordAiUsage } from "@/lib/security/events";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";
// Headroom for the single Haiku vision call; the client downscales the image first.
export const maxDuration = 30;

// Only still images can be read.
const READABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// The client downscales to a few hundred KB; this guard stays safely below the
// ~4.5 MB serverless body limit so an oversized body degrades gracefully.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

type Db = { from: (t: string) => any };

// POST /api/snapfill/vision — the generalized "photo snap → fill" reader (multipart
// form: `image`, `schema` (JSON array of the mount's field whitelist), `target`
// (a short context label), `retain` ("1" to keep the image as an evidence object)).
//
// It reads ONLY the whitelisted fields off the image and returns { key: value } for
// the ones it can confidently read — text kept verbatim, numbers coerced, unread
// keys omitted (honest nulls). It NEVER saves a record: the host commits the values
// through its own already-role-gated write path, so a metric cluster's snap still
// travels the sanctioned manual lane and can never overwrite an API-synced value.
//
// Graceful by construction — never throws out to a 502: an unset key → 503
// {ok:false,error:"not-configured"}; any model/parse/runtime failure → 200
// {ok:false,error:"failed",reason}. Either way the client shows "enter manually".
export async function POST(request: Request) {
  try {
    return await handle(request);
  } catch {
    return NextResponse.json(
      { ok: false, error: "failed", reason: "Couldn't read that image — enter the details manually." },
      { status: 200 }
    );
  }
}

async function handle(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!isVisionConfigured()) {
    return NextResponse.json(
      { ok: false, error: "not-configured", reason: "Snap to fill isn't set up yet — enter the details manually." },
      { status: 503 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const file = form.get("image");
  const target = String(form.get("target") ?? "").trim().slice(0, 120) || "record";
  const retain = String(form.get("retain") ?? "") === "1";
  const fields = sanitizeClientSchema(String(form.get("schema") ?? ""));

  if (fields.length === 0) {
    return NextResponse.json({ error: "A non-empty field whitelist is required." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No image received." }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: "image-too-large",
        reason: "The photo is too large to read. Try snapping again — it will be compressed automatically.",
      },
      { status: 413 }
    );
  }
  const mediaType = file.type || "image/jpeg";
  if (!READABLE.has(mediaType)) {
    return NextResponse.json({ error: "unsupported-media" }, { status: 415 });
  }

  const supabase = createServerSupabaseClient();
  const buf = Buffer.from(await file.arrayBuffer());

  // Only KEEP the image when the host wants an evidence trail (e.g. the metric grid
  // attaches it to the metric_entry it read). For a one-off form fill (creators /
  // leads) we read from memory and never leave an orphaned object in the bucket.
  let storagePath: string | null = null;
  if (retain) {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "snap";
    storagePath = `${profile.org_id}/quick-entry/${Date.now()}_${safe}`;
    const { error: upErr } = await supabase.storage
      .from("evidence")
      .upload(storagePath, buf, { contentType: mediaType, upsert: false });
    if (upErr) {
      // Don't fail the read over a storage hiccup — just skip the evidence trail.
      storagePath = null;
    }
  }

  const base64 = buf.toString("base64");
  const result = await readFields(base64, mediaType, target, fields);

  if (!result.ok) {
    if (retain && storagePath) {
      try {
        await supabase.storage.from("evidence").remove([storagePath]);
      } catch {
        /* best-effort */
      }
    }
    if (result.error === "not-configured") {
      return NextResponse.json(
        { ok: false, error: "not-configured", reason: "Snap to fill isn't set up yet — enter the details manually." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { ok: false, error: "failed", reason: "Couldn't read that image — enter the details manually." },
      { status: 200 }
    );
  }

  // Log the call — fire-and-forget, never blocks the user path.
  void recordAiUsage(supabase as unknown as Db, {
    orgId: profile.org_id,
    userId: profile.id,
    feature: "snapfill_vision",
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });

  const readCount = Object.keys(result.values).length;

  // Nothing legible — don't keep an image no row references (best-effort).
  if (readCount === 0 && retain && storagePath) {
    try {
      await supabase.storage.from("evidence").remove([storagePath]);
    } catch {
      /* best-effort */
    }
    storagePath = null;
  }

  return NextResponse.json(
    {
      ok: true,
      suggestion: true,
      values: result.values,
      extract: result.extract,
      model: result.model,
      storage_path: storagePath,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
