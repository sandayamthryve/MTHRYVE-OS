import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { listSkills } from "@/lib/skills/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/skills — the discovery endpoint for the Skill Library (Layer 4).
// Returns the enabled skills the signed-in user's role may see, read through the
// caller's RLS-scoped client (org-scoped by Postgres, role-filtered in listSkills).
// This is how the Executive Brain (Tony) will later enumerate what reasoning it
// can invoke; for now it simply exposes the catalogue — running a skill is not
// part of this endpoint.
export async function GET() {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  const skills = await listSkills(supabase, profile.role);

  return NextResponse.json({ skills });
}
