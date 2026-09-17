import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";

// Client-side Supabase client — used in "use client" components only.
// Never place the service role key here; only the public anon key belongs
// in NEXT_PUBLIC_* env vars (see DECISIONS.md D-006).
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
