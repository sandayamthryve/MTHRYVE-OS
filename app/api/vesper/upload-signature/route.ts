import { NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasVesperStudioAccess } from "@/lib/vesper/access";
import {
  cloudinaryApiKey,
  cloudinaryCloudName,
  cloudinaryApiSecret,
  isCloudinaryConfigured,
  signUploadParams,
} from "@/lib/cloudinary/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/vesper/upload-signature — mint a short-lived Cloudinary SIGNED-upload
// signature so the browser can upload a large replay file DIRECTLY to Cloudinary
// (client → Cloudinary), never proxying the bytes through Vercel.
//
// Gate: Creative department members + department_head + ceo/coo (the shared
// Vesper access gate). Everyone else is rejected.
//
// The signature covers exactly the params the browser will send with the file:
//   folder    — "vesper/<org_id>", derived HERE from the session (never trusted
//               from the client) so uploads are always scoped to the caller's org
//   timestamp — unix seconds, stamped HERE
// We return { signature, timestamp, apiKey, cloudName, folder }. CLOUDINARY_API_
// SECRET is used only to compute the signature and NEVER leaves the server.
export async function POST() {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  if (!(await hasVesperStudioAccess(supabase, profile))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  if (!isCloudinaryConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_configured",
        detail:
          "Cloudinary isn't set up yet. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in Vercel.",
      },
      { status: 503 }
    );
  }

  const cloudName = cloudinaryCloudName()!;
  const apiKey = cloudinaryApiKey()!;
  const apiSecret = cloudinaryApiSecret()!;

  // Org-scoped folder + a fresh timestamp are the only signed params. The browser
  // MUST send these exact values back alongside the file, or Cloudinary rejects
  // the signature.
  const folder = `vesper/${profile.org_id}`;
  const timestamp = Math.round(Date.now() / 1000);

  const signature = signUploadParams({ folder, timestamp }, apiSecret);

  return NextResponse.json({
    ok: true,
    signature,
    timestamp,
    apiKey,
    cloudName,
    folder,
  });
}
