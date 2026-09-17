// Cloudinary configuration + signed-upload signing — the ONE place the app
// talks to Cloudinary. Vesper replay files are large (a full TikTok LIVE replay
// can be gigabytes), so the browser uploads the file DIRECTLY to Cloudinary; the
// Vercel runtime never proxies the bytes. To let the browser do that safely we
// hand it a short-lived SIGNED upload signature computed HERE, server-side.
//
// The API SECRET is read at CALL TIME (never at module load) so Vercel
// "Sensitive" runtime-only vars are seen fresh per request and nothing captures
// the secret into a build artifact. This module runs ONLY server-side — never
// import it into a "use client" component. CLOUDINARY_API_SECRET must never
// reach the browser and is never logged.
//
// Signing algorithm (per Cloudinary docs): take every param that will be sent to
// the upload endpoint EXCEPT file, cloud_name, resource_type and api_key; sort by
// key; join as `key=value` pairs with `&`; append the api secret; SHA-1 the
// result and hex-encode it. The browser then POSTs the file plus the exact same
// params + this signature to the upload endpoint.

import { createHash } from "crypto";

// Read fresh each call, trimmed. Undefined when unset.
export function cloudinaryCloudName(): string | undefined {
  const raw = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  return raw ? raw : undefined;
}
export function cloudinaryApiKey(): string | undefined {
  const raw = process.env.CLOUDINARY_API_KEY?.trim();
  return raw ? raw : undefined;
}
export function cloudinaryApiSecret(): string | undefined {
  const raw = process.env.CLOUDINARY_API_SECRET?.trim();
  return raw ? raw : undefined;
}

// True only when every piece needed to sign + upload is present. The UI uses
// this to fall back to a calm "not set up yet" state instead of attempting a
// signature call that would fail. The secret is required to sign; cloud name +
// api key are the non-secret values the browser needs to build the request.
export function isCloudinaryConfigured(): boolean {
  return Boolean(cloudinaryCloudName() && cloudinaryApiKey() && cloudinaryApiSecret());
}

// The direct-upload endpoint for a given cloud. resource_type=video — replays
// are always video, and this is what the browser POSTs the file to.
export function cloudinaryVideoUploadUrl(cloudName: string): string {
  return `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/video/upload`;
}

// Compute the Cloudinary upload signature for a set of params. `params` must be
// EXACTLY the params the browser will send (minus file / cloud_name /
// resource_type / api_key) — most commonly { folder, timestamp }. Empty / null /
// undefined values are dropped, matching Cloudinary's own signing rules, so the
// browser must likewise omit them. Returns the hex SHA-1 digest.
export function signUploadParams(
  params: Record<string, string | number | undefined | null>,
  apiSecret: string
): string {
  const toSign = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHash("sha1")
    .update(toSign + apiSecret)
    .digest("hex");
}
