import { type NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// PKCE code-flow callback. Supabase's default email links (ConfirmationURL)
// arrive here with a `code` query param; we exchange it for a session cookie,
// then send the user to ?next (if it's a safe same-origin path) or home.
// The token_hash/verifyOtp variant lives in /auth/confirm — keeping both means
// the session is established no matter how the dashboard email templates are
// configured.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  const code = searchParams.get("code");
  const next = searchParams.get("next");

  if (code) {
    const supabase = createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const safeNext =
        next && next.startsWith("/") && !next.startsWith("//") ? next : "/home";
      return NextResponse.redirect(new URL(safeNext, origin));
    }
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, origin)
    );
  }

  return NextResponse.redirect(new URL("/login?error=missing_code", origin));
}
