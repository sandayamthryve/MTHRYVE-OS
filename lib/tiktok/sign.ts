import { createHmac } from "crypto";

// TikTok Shop request signing (HMAC-SHA256).
//
// Token get/refresh are UNSIGNED. Every business API call (the authorized-shops
// read here, and any later product/order reads) MUST be signed with this exact
// algorithm — TikTok rejects the request otherwise, usually with a terse
// "invalid signature" that gives no hint which step drifted, so the steps are
// spelled out below.
//
// The algorithm (per the TikTok Shop API guide — confirm against your app's
// API guide, as they version it):
//   1. Collect all query params EXCEPT `sign` and `access_token`.
//   2. Sort the keys alphabetically (ascending).
//   3. Concatenate each as `key + value` (no separators).
//   4. Prepend the API request path (e.g. "/authorization/202309/shops").
//   5. If there's a non-multipart request body, append its raw string. (READ
//      calls here are GETs with no body — kept for completeness.)
//   6. Wrap the whole thing with the app secret on BOTH ends:
//        app_secret + <step 5 string> + app_secret
//   7. HMAC-SHA256 the wrapped string, KEYED by the app secret, hex digest.

export interface SignedResult {
  // The signature to send as the `sign` query param.
  sign: string;
  // The timestamp (unix seconds) that was signed — send the SAME value as the
  // `timestamp` query param so the server recomputes an identical signature.
  timestamp: number;
}

// Compute the `sign` for a business API call.
//
// `params` is every query param the request will carry EXCEPT `sign` and
// `access_token` (those are excluded by the algorithm). Always include
// `app_key` and `timestamp` in it. `body` is the raw request body for
// non-multipart writes; omit for GET reads.
export function signRequest(
  appSecret: string,
  path: string,
  params: Record<string, string | number>,
  body?: string
): string {
  // 1–2: drop excluded keys, sort remaining keys ascending.
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort();

  // 3: concatenate key+value with no separators.
  let base = "";
  for (const key of keys) base += `${key}${params[key]}`;

  // 4: prepend the request path.
  base = `${path}${base}`;

  // 5: append the raw body when present (non-multipart only).
  if (body) base += body;

  // 6: wrap both ends with the app secret.
  const wrapped = `${appSecret}${base}${appSecret}`;

  // 7: HMAC-SHA256 keyed by the app secret, hex.
  return createHmac("sha256", appSecret).update(wrapped, "utf8").digest("hex");
}

// Convenience: build the common query params (app_key + timestamp) and their
// signature for a signed GET. Returns the params to append AND the sign, so the
// caller sends exactly what was signed. `access_token` goes in the header, not
// the query, and is never part of the signature.
export function signGet(
  appKey: string,
  appSecret: string,
  path: string,
  extraParams: Record<string, string | number> = {}
): { params: Record<string, string>; sign: string; timestamp: number } {
  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    app_key: appKey,
    timestamp: String(timestamp),
    ...Object.fromEntries(Object.entries(extraParams).map(([k, v]) => [k, String(v)])),
  };
  const sign = signRequest(appSecret, path, params);
  return { params: { ...params, sign }, sign, timestamp };
}
