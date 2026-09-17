import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { templateByKey } from "@/lib/content/templates";
import { buildCreativeSystemSuffix } from "@/lib/content/creative-guides";
import { parseJsonBody, serverError } from "@/lib/security/api";

const GenerateSchema = z.object({
  templateKey: z.string().min(1).max(200),
  inputs: z.record(z.string().max(200), z.string().max(20_000)).optional().default({}),
});

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL_BY_ROLE: Record<string, string> = {
  ceo: "claude-opus-4-8",
  coo: "claude-opus-4-8",
  department_head: "claude-sonnet-5",
  team_member: "claude-haiku-4-5",
};

// Tiered upgrades (D-012): an active model_grant can lift the caller above their
// role default until it expires. Ranks let us compare a grant's tier to the role
// default and only ever upgrade, never downgrade.
const TIER_ORDER: Record<string, number> = { lite: 0, standard: 1, premium: 2 };
const MODEL_BY_TIER: Record<string, string> = {
  lite: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  premium: "claude-opus-4-8",
};
const TIER_BY_MODEL: Record<string, string> = {
  "claude-haiku-4-5": "lite",
  "claude-sonnet-5": "standard",
  "claude-opus-4-8": "premium",
};

export async function POST(req: NextRequest) {
  const profile = (await requireRole([
    "ceo",
    "coo",
    "department_head",
    "team_member",
  ])) as unknown as { role: string; org_id: string; id: string };

  const parsed = await parseJsonBody(req, GenerateSchema, "content-studio/generate");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const tpl = templateByKey(body.templateKey ?? "");
  if (!tpl) return NextResponse.json({ error: "unknown template" }, { status: 400 });

  let model = MODEL_BY_ROLE[profile.role] ?? "claude-haiku-4-5";

  // Honour an active temporary grant if it maps to a higher model than the role
  // default. The role default remains the fallback (no grant, or a lower tier).
  try {
    const supabase = createServerSupabaseClient();
    const { data: grant } = await (
      supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (col: string, v: string) => {
              gt: (col: string, v: string) => {
                order: (
                  col: string,
                  o: { ascending: boolean }
                ) => { limit: (n: number) => { maybeSingle: () => Promise<{ data: { tier?: string } | null }> } };
              };
            };
          };
        };
      }
    )
      .from("model_grants")
      .select("tier")
      .eq("user_id", profile.id)
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const grantedTier = grant?.tier;
    const defaultTier = TIER_BY_MODEL[model] ?? "lite";
    if (
      grantedTier &&
      MODEL_BY_TIER[grantedTier] &&
      (TIER_ORDER[grantedTier] ?? -1) > (TIER_ORDER[defaultTier] ?? -1)
    ) {
      model = MODEL_BY_TIER[grantedTier];
    }
  } catch {
    // Grant lookup is best-effort; fall back to the role default on any failure.
  }

  // Make the selected content pillar (+ format + product context) the PRIMARY
  // constraint on EVERY generation. The suffix is appended to the template's own
  // system prompt so it dominates any default sales tone — this is the single
  // chokepoint every studio surface (Plan panel, standalone Studio) flows through.
  const inputs = body.inputs ?? {};
  const system = tpl.system + buildCreativeSystemSuffix(inputs);

  let output = "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: tpl.buildPrompt(inputs) }],
      }),
    });
    const data = (await res.json()) as {
      content?: { type: string; text: string }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      // Log the upstream detail server-side; never surface it to the client.
      console.error("[content-studio/generate] anthropic error", res.status, data?.error?.message);
      return NextResponse.json({ error: "Generation is temporarily unavailable." }, { status: 502 });
    }
    output = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (e) {
    return serverError("content-studio/generate", e, 502, "Generation is temporarily unavailable.");
  }

  // Best-effort save (content_generations not yet in generated types; never blocks output).
  try {
    const supabase = createServerSupabaseClient();
    await (
      supabase as unknown as {
        from: (t: string) => { insert: (v: Record<string, unknown>) => Promise<unknown> };
      }
    )
      .from("content_generations")
      .insert({
        org_id: profile.org_id,
        created_by: profile.id,
        department: tpl.department,
        template_key: tpl.key,
        inputs: body.inputs ?? {},
        output,
        model,
      });
  } catch {
    // non-blocking
  }

  return NextResponse.json({ output, model });
}
