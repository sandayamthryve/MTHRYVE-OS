import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveManualCatalogScope } from "@/lib/metrics/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/metrics/catalog — the hand-enterable (lane='manual') metric
// definitions + scope for the Quick-Entry modal (Data Analytics tab). RLS-scoped
// to the caller's org. The SCOPE is decided server-side from the authenticated
// profile via resolveManualCatalogScope — the SAME resolver the standalone
// /quick-entry page uses — so the two surfaces can never scope differently:
//
//   • ceo / coo, OR anyone whose department_id is null → every manual metric
//     across all departments (the client shows a department picker).
//   • Everyone else → locked to their OWN department, resolved by NAME
//     (users.department_id → departments.name → metric_catalog.department). We
//     NEVER compare the department_id uuid against metric_catalog.department
//     (text), and NEVER route the name through a hardcoded code taxonomy —
//     either would match nothing and leave the picker empty.
export async function GET() {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  const { canPickDepartment, ownDepartment, departments, catalog } =
    await resolveManualCatalogScope(supabase, profile);

  return NextResponse.json(
    {
      canPickDepartment,
      department: ownDepartment,
      departments,
      catalog,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
