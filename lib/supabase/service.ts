import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// Service-role Supabase client — BYPASSES Row Level Security. Use ONLY in
// trusted server contexts that must reach RLS-locked data the user client can't
// (e.g. the Canva token vault: public.canva_connections has RLS on with no
// policy, so it is reachable only with this key). NEVER import this into a
// "use client" component, and never return its rows' secrets to the browser.
//
// The key lives in SUPABASE_SERVICE_ROLE_KEY (server-only, never NEXT_PUBLIC_*).
// See DECISIONS.md D-006 and SECURITY.md.
export function createServiceRoleClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}
