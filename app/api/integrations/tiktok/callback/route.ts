import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireRole } from "@/lib/auth/session";
import {
  TIKTOK_API_BASE,
  TIKTOK_SHOPS_PATH,
  TIKTOK_STATE_COOKIE,
  TIKTOK_TOKEN_GET_URL,
  tiktokAppKey,
  tiktokAppSecret,
} from "@/lib/tiktok/config";
import { signGet } from "@/lib/tiktok/sign";
import { upsertConnection, upsertShops, type TikTokShopInput } from "@/lib/tiktok/vault";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";

// GET /api/integrations/tiktok/callback — finish the TikTok Shop Partner
// authorization flow.
//
// TikTok redirects here with ?code&state (or ?error). We verify state against
// the cookie set in /connect, exchange the code for tokens at the UNSIGNED
// token/get endpoint, upsert the org's connection into the locked vault, then
// do a SIGNED read of the authorized shops and upsert those. Every failure
// funnels to a NAMED ?tiktok_error=<reason> flag the settings page renders, a
// soft shops failure to ?tiktok_warn=shops_fetch_failed (connection kept), and
// success to ?tiktok_connected=1 — so the flow is never silent. Every step logs.
//
// ⚠️ Confirm the token/get and shops endpoints against Partner Center → your
// App → API guide; TikTok versions these hosts/paths.

// TikTok's token/get success payload (the `data` object).
interface TokenGetData {
  access_token?: string;
  refresh_token?: string;
  access_token_expire_in?: number; // absolute unix seconds
  refresh_token_expire_in?: number; // absolute unix seconds
  open_id?: string;
  seller_name?: string;
  seller_base_region?: string;
  granted_scopes?: string[];
}

// Absolute unix seconds → ISO timestamptz, or null if absent/not a number.
function unixToIso(v: unknown): string | null {
  return typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : null;
}

// Fetch the shops authorized by this token (SIGNED). Returns the normalized
// shop list, or null on any failure (caller keeps the connection and warns).
async function fetchAuthorizedShops(accessToken: string): Promise<TikTokShopInput[] | null> {
  const appKey = tiktokAppKey();
  const appSecret = tiktokAppSecret();
  if (!appKey || !appSecret) return null;
  try {
    const { params } = signGet(appKey, appSecret, TIKTOK_SHOPS_PATH);
    const url = new URL(`${TIKTOK_API_BASE}${TIKTOK_SHOPS_PATH}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, {
      method: "GET",
      headers: { "x-tts-access-token": accessToken, "content-type": "application/json" },
    });
    const json = (await res.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: {
        shops?: { id?: string; cipher?: string; name?: string; region?: string }[];
      };
    } | null;
    console.info("[tiktok] shops fetch", { status: res.status, code: json?.code });
    if (!res.ok || !json || json.code !== 0) {
      console.error("[tiktok] shops fetch failed", res.status, json?.code, json?.message);
      return null;
    }
    return (json.data?.shops ?? [])
      .filter((s) => s.id)
      .map((s) => ({
        id: s.id as string,
        cipher: s.cipher ?? null,
        name: s.name ?? null,
        region: s.region ?? null,
      }));
  } catch (e) {
    console.error("[tiktok] shops fetch threw", e);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const profile = await requireRole(["ceo", "coo", "department_head"]);

  const origin = new URL(request.url).origin;

  // Every outcome returns to settings; the page renders the flag.
  const back = (query: string): NextResponse =>
    NextResponse.redirect(new URL(`/settings?${query}`, origin));

  // Clear the one-shot state cookie no matter how this turns out.
  const clear = (res: NextResponse) => {
    res.cookies.set(TIKTOK_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };

  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const returnedState = searchParams.get("state");
    const oauthError = searchParams.get("error");

    const storedState = cookies().get(TIKTOK_STATE_COOKIE)?.value;

    // (a) TikTok returned an error — surface exactly what it said.
    if (oauthError) {
      console.error("[tiktok] callback oauth error", oauthError);
      return clear(back(`tiktok_error=${encodeURIComponent(oauthError)}`));
    }

    // (b) CSRF: the returned state must match the cookie we set in /connect,
    // and a code must be present.
    if (!code || !storedState || !returnedState || storedState !== returnedState) {
      console.error("[tiktok] callback bad state", {
        hasCode: Boolean(code),
        hasStored: Boolean(storedState),
        hasReturned: Boolean(returnedState),
        match: storedState === returnedState,
      });
      return clear(back("tiktok_error=bad_state"));
    }

    const appKey = tiktokAppKey();
    const appSecret = tiktokAppSecret();
    if (!appKey || !appSecret) {
      console.error("[tiktok] callback missing app credentials");
      return clear(back("tiktok_error=missing_service_id"));
    }

    // (c) Exchange the auth code for tokens — UNSIGNED (app_key/app_secret in
    // the query). TikTok returns { code, message, data }; code 0 = success.
    const tokenUrl = new URL(TIKTOK_TOKEN_GET_URL);
    tokenUrl.searchParams.set("app_key", appKey);
    tokenUrl.searchParams.set("app_secret", appSecret);
    tokenUrl.searchParams.set("auth_code", code);
    tokenUrl.searchParams.set("grant_type", "authorized_code");

    const tokenRes = await fetch(tokenUrl, { method: "GET" });
    const tokenJson = (await tokenRes.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: TokenGetData;
    } | null;
    console.info("[tiktok] token/get", { status: tokenRes.status, code: tokenJson?.code });
    if (!tokenRes.ok || !tokenJson || tokenJson.code !== 0 || !tokenJson.data?.access_token) {
      console.error("[tiktok] token exchange failed", tokenRes.status, tokenJson?.code, tokenJson?.message);
      return clear(back("tiktok_error=exchange_failed"));
    }

    // (d) Pull the connection fields out of the token payload.
    const data = tokenJson.data;
    const openId = data.open_id;
    if (!openId) {
      console.error("[tiktok] token payload missing open_id");
      return clear(back("tiktok_error=exchange_failed"));
    }

    const connectionId = await upsertConnection({
      org_id: profile.org_id,
      open_id: openId,
      seller_name: data.seller_name ?? null,
      region: data.seller_base_region ?? null,
      access_token: data.access_token as string,
      refresh_token: data.refresh_token ?? null,
      access_token_expires_at: unixToIso(data.access_token_expire_in),
      refresh_token_expires_at: unixToIso(data.refresh_token_expire_in),
      granted_scopes: Array.isArray(data.granted_scopes) ? data.granted_scopes : null,
      connected_by: profile.id,
    });
    if (!connectionId) {
      console.error("[tiktok] connection save failed");
      return clear(back("tiktok_error=save_failed"));
    }
    console.info("[tiktok] connection saved", { openId, region: data.seller_base_region });

    // (e) SIGNED read of authorized shops. On failure keep the connection and
    // surface a soft warning rather than failing the whole connect.
    const shops = await fetchAuthorizedShops(data.access_token as string);
    if (shops === null) {
      return clear(back("tiktok_warn=shops_fetch_failed"));
    }
    const written = await upsertShops(connectionId, profile.org_id, shops);
    console.info("[tiktok] shops saved", { count: written });

    // (f) Done.
    return clear(back("tiktok_connected=1"));
  } catch (e) {
    // redirect() throws by design, but that only happens inside requireRole
    // (outside this block). Any real error here → a named exception flag.
    console.error("[tiktok] callback exception", e);
    return clear(back("tiktok_error=exception"));
  }
}
