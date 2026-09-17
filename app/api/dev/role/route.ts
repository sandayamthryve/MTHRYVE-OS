import { NextRequest, NextResponse } from "next/server";
import { isDevChannelAuthBypassEnabled } from "@/lib/auth/dev-channel";
import { isWorkspaceRole, workspaceHome } from "@/lib/auth/module-access";
import { DEV_SESSION_COOKIE, DEV_ROLE_COOKIE } from "@/lib/auth/preview-access";

export const dynamic = "force-dynamic";

// Only the existing perimeter-protected operator demo session may switch views.
// This endpoint never operates on a Supabase user or membership.
export async function POST(request: NextRequest) {
  if (!isDevChannelAuthBypassEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (request.cookies.get(DEV_SESSION_COOKIE)?.value !== "active") {
    return NextResponse.json({ error: "Sign in as operator first." }, { status: 401 });
  }
  // Next may normalize request.nextUrl to its internal hostname. Compare the
  // browser Origin against the incoming Host, not that rewritten URL.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  try {
    if (!origin || !["http:", "https:"].includes(new URL(origin).protocol) || new URL(origin).host !== host ||
        request.headers.get("sec-fetch-site") === "cross-site") {
      return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
    }
  } catch { return NextResponse.json({ error: "Invalid request origin." }, { status: 403 }); }

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const role = body && typeof body === "object" && "role" in body ? body.role : null;
  if (!isWorkspaceRole(role)) return NextResponse.json({ error: "Unknown role." }, { status: 400 });

  const response = NextResponse.json({ role, href: workspaceHome(role) });
  response.headers.set("Cache-Control", "no-store");
  // Lax, not Strict: the session cookie (mthryve_dev_demo) is Lax, so a
  // top-level cross-site entry — clicking the deployment link from the Vercel
  // dashboard, chat or email — carries the session but would drop a Strict role
  // cookie. Middleware then reads an absent role as operator and serves "/",
  // while the next same-site reload sends the role again and redirects to
  // /workspace. Both cookies must have the same send rules or the landing page
  // flips between the two. CSRF on this endpoint is the Origin + sec-fetch-site
  // check above, not the cookie's SameSite.
  response.cookies.set(DEV_ROLE_COOKIE, role, {
    httpOnly: true, secure: request.nextUrl.protocol === "https:",
    sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
