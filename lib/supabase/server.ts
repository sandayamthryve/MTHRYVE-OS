import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database";

// Server-side Supabase client — used in Server Components, Route Handlers,
// and Server Actions. Reads/writes the auth cookie via Next's cookies().
//
// MUST use the getAll/setAll cookie interface, exactly like middleware.ts. The
// deprecated per-cookie get/set/remove interface reads the session DIFFERENTLY
// than getAll under @supabase/ssr 0.5+ (chunked, base64url-encoded auth
// cookies): the edge middleware would resolve the user while this Node client
// resolved nobody, so /home's requireProfile() saw a null profile and fired
// redirect("/login") — the /login ⇄ /home 307 loop. Keeping both clients on the
// SAME cookie contract is what makes them agree about a session. Do not revert
// to get/set/remove.
export function createServerSupabaseClient() {
  const cookieStore = cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Called from a Server Component, where cookies() is read-only and
            // set() throws. Safe to ignore: the middleware refreshes and writes
            // the session cookie on its own pass (see middleware.ts).
          }
        },
      },
    }
  );
}
