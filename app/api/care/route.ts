import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";
import { buildCareSystemPrompt } from "@/lib/care/persona";
import { buildCareTools, runCareTool, CARE_TOOL_NAMES } from "@/lib/care/tools";
import type { CareToolContext } from "@/lib/care/tools";
import { UNTRUSTED_DATA_SYSTEM_PROMPT, wrapToolResult } from "@/lib/security/untrusted";
import { guardToolCall, loadToolPolicyDenies } from "@/lib/security/tool-tiers";
import { filterOutput } from "@/lib/security/output-filter";
import { recordAiUsage, recordSecurityEvent } from "@/lib/security/events";
import { parseJsonBody } from "@/lib/security/api";
import { buildMockAgentResponse, isAgentMockModeEnabled } from "@/lib/ai/agent-mock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_INPUT_CHARS = 4000;
const DAILY_MESSAGE_LIMIT = 100;
const MAX_TOOL_ROUNDS = 5;

const CareSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().max(MAX_INPUT_CHARS * 2).optional(),
});

type MessageRow = { role: string; content: string };
type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };
type AnthropicMessage = { role: "user" | "assistant"; content: unknown };
type AnthropicResponse = { content?: ContentBlock[]; stop_reason?: string; error?: { message?: string }; usage?: { input_tokens?: number; output_tokens?: number } };

function textOf(content: ContentBlock[] | undefined): string {
  return (content ?? []).filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("").trim();
}

export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsed = await parseJsonBody(request, CareSchema, "care");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const message = (body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "Message is empty." }, { status: 400 });
  if (message.length > MAX_INPUT_CHARS) return NextResponse.json({ error: `Message too long (max ${MAX_INPUT_CHARS} characters).` }, { status: 400 });
  if (isAgentMockModeEnabled()) {
    return NextResponse.json(buildMockAgentResponse("care", message, body.conversationId ?? undefined, profile.role), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Care isn't configured yet. Add ANTHROPIC_API_KEY in Vercel." }, { status: 503 });

  const supabase = createServerSupabaseClient();
  const model = TIER_MODEL[defaultTierFor(profile.role)];

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase.from("ai_messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", since);
  if ((count ?? 0) >= DAILY_MESSAGE_LIMIT) return NextResponse.json({ error: "Daily message limit reached. Try again tomorrow." }, { status: 429 });

  let conversationId = body.conversationId ?? null;
  if (!conversationId) {
    const convInsert: Database["public"]["Tables"]["ai_conversations"]["Insert"] = { org_id: profile.org_id, user_id: profile.id, title: `Care — ${message.slice(0, 48)}` };
    const { data: created, error: convErr } = await supabase.from("ai_conversations").insert(convInsert as never).select("id").single();
    if (convErr || !created) return NextResponse.json({ error: "Could not start a conversation." }, { status: 500 });
    conversationId = (created as { id: string }).id;
  }
  const convId = conversationId as string;
  const userInsert: Database["public"]["Tables"]["ai_messages"]["Insert"] = { conversation_id: convId, role: "user", content: message };
  const { error: userMsgErr } = await supabase.from("ai_messages").insert(userInsert as never);
  if (userMsgErr) return NextResponse.json({ error: "Could not save your message." }, { status: 500 });

  const { data: historyData } = await supabase.from("ai_messages").select("role, content").eq("conversation_id", convId).order("created_at", { ascending: true });
  const history = (historyData ?? []) as unknown as MessageRow[];
  const messages: AnthropicMessage[] = history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

  const systemPrompt = [buildCareSystemPrompt(profile.role, profile.full_name), UNTRUSTED_DATA_SYSTEM_PROMPT].join("\n\n");
  const tools = buildCareTools(profile.role);
  const toolCtx: CareToolContext = { supabase, profile };
  const revalidate = new Set<string>();
  let assistantText = "";
  const deniedTools = await loadToolPolicyDenies(supabase, profile.org_id);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    for (let round = 0; ; round++) {
      const allowTools = round < MAX_TOOL_ROUNDS;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 2048, system: systemPrompt, messages, ...(allowTools ? { tools } : {}) }),
      });
      if (!res.ok) {
        const detail = await res.text();
        console.error("Anthropic API error (care)", res.status, detail);
        return NextResponse.json({ error: "Care is temporarily unavailable." }, { status: 502 });
      }
      const data = (await res.json()) as AnthropicResponse;
      totalInputTokens += data.usage?.input_tokens ?? 0;
      totalOutputTokens += data.usage?.output_tokens ?? 0;

      if (allowTools && data.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: data.content ?? [] });
        const toolUses = (data.content ?? []).filter((b): b is ToolUseBlock => b.type === "tool_use");
        const toolResults = await Promise.all(
          toolUses.map(async (block) => {
            const guard = guardToolCall(block.name, profile.role, deniedTools);
            let result: unknown;
            if (!guard.ok) result = { error: guard.reason, denied: true, tier: guard.tier };
            else if ((CARE_TOOL_NAMES as Set<string>).has(block.name)) {
              result = await runCareTool(block.name as any, block.input, toolCtx);
            } else result = { error: `Unknown tool: ${block.name}` };
            if (block.name === "log_wellbeing_pulse" && (result as { ok?: boolean }).ok) revalidate.add("/care");
            if (block.name === "propose_check_in" && (result as { ok?: boolean }).ok) { revalidate.add("/approvals"); revalidate.add("/care"); }
            return { type: "tool_result" as const, tool_use_id: block.id, content: wrapToolResult(block.name, result) };
          })
        );
        messages.push({ role: "user", content: toolResults });
        continue;
      }
      assistantText = textOf(data.content) || "I wasn't able to generate a response.";
      break;
    }
  } catch (err) {
    console.error("Care request failed", err);
    return NextResponse.json({ error: "Care is temporarily unavailable." }, { status: 502 });
  }

  const filtered = filterOutput(assistantText);
  const safeText = filtered.text;
  if (!filtered.safe) {
    void recordSecurityEvent(supabase, { orgId: profile.org_id, userId: profile.id, eventType: "output_redacted", severity: "critical", detail: { agent: "care", findings: filtered.findings.map((f) => ({ kind: f.kind, label: f.label })) } });
  }
  void recordAiUsage(supabase, { orgId: profile.org_id, userId: profile.id, feature: "care", model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens });

  const assistantInsert = { conversation_id: convId, role: "assistant", content: safeText, model };
  await supabase.from("ai_messages").insert(assistantInsert as never);
  await supabase.from("ai_conversations").update({ updated_at: new Date().toISOString() } as never).eq("id", convId);
  for (const path of revalidate) { try { revalidatePath(path); } catch {} }

  return NextResponse.json({ conversationId: convId, assistant: { role: "assistant", content: safeText }, model });
}
