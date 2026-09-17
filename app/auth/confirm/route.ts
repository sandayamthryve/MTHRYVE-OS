import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Auth callback for every email link: invite, magic link, signup confirmation
// and password recovery. Supabase can deliver these two ways depending on the
// email-template configuration:
//   • token_hash + type  → verifyOtp             (templates using {{ .TokenHash }})
//   • code               → exchangeCodeForSession (default PKCE ConfirmationURL)
// We handle both so the session is established regardless of how the link was
// built. On success we route invite/recovery to /set-password (those users
// have no usable password yet) and everything else home (or ?next=).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);

  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = searchParams.get("next");

  const supabase = createServerSupabaseClient();

  let verifyError: { message: string } | null = null;
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    verifyError = error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    verifyError = error;
  } else {
    return NextResponse.redirect(new URL("/login?error=missing_token", origin));
  }

  if (verifyError) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(verifyError.message)}`, origin)
    );
  }

  // Invited users have no password, and recovery is a deliberate reset — both
  // must land on the set-password screen before entering the app.
  if (type === "invite" || type === "recovery") {
    return NextResponse.redirect(new URL("/set-password", origin));
  }

  // magiclink / signup (or a bare code) already have a usable account → the role
  // dispatcher, honoring an explicit ?next when it's a safe same-origin path.
  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/home";
  return NextResponse.redirect(new URL(safeNext, origin));
}
