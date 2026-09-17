import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionProfile, homeRouteFor } from "@/lib/auth/session";
import { HomeUnavailable } from "./HomeUnavailable";

// Post-login home router. Every sign-in / callback lands here and is dispatched
// to the caller's role cockpit (see homeRouteFor / app/(dashboard)/page.tsx,
// which branches by role). Keeping the dispatch in one server route means the
// login form, the OAuth callbacks and set-password all route by role without
// each re-deriving it.
//
// HARD INVARIANT: this route must NEVER redirect to /login. The production
// incident was a 307 loop — the middleware (edge) resolved the user and sent
// /login → /home, then /home's guard failed to resolve that same session and
// sent /home → /login, forever. So dispatch here NEVER calls requireProfile
// (which would redirect("/login") on a null profile). Instead:
//   • no auth user at all → the middleware already guards /home for that and
//     redirects unauthenticated visitors to /login before this page ever runs;
//     if we somehow still see no user, we render the error state rather than
//     bounce, because a middleware-vs-page disagreement is precisely the loop;
//   • valid auth user but no resolvable profile → render an honest error state;
//   • profile resolves → redirect to their role home.
export const dynamic = "force-dynamic";

export default async function HomeRouterPage() {
  const supabase = createServerSupabaseClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    console.error("[/home] auth.getUser() failed:", userError.message);
  }

  if (!user) {
    // Deliberately NOT redirect("/login"): if middleware routed a user here but
    // this pass can't see them, redirecting would re-open the loop. Show the
    // dead-end instead — it's a rare, honest state, not an infinite bounce.
    console.error(
      "[/home] no auth user resolved on the page pass — rendering HomeUnavailable"
    );
    return <HomeUnavailable />;
  }

  const profile = await getSessionProfile();
  if (!profile) {
    // Valid auth user, but no profile row to route by. Render the error state
    // instead of redirecting to /login (the required invariant above).
    // getSessionProfile() has already console.error'd the underlying cause
    // (auth error, PostgREST embed/RLS error, or genuine missing row); this
    // line records that /home took the dead-end fallback for this user.
    console.error(
      `[/home] profile unresolved for auth user ${user.id} (${user.email ?? "no-email"}) — rendering HomeUnavailable`
    );
    return <HomeUnavailable email={user.email} />;
  }

  redirect(homeRouteFor(profile));
}
