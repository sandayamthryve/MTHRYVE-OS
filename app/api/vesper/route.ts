import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { parseJsonBody } from "@/lib/security/api";
import type { Database } from "@/types/database";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";
import {
  buildVesperSystemPrompt,
  buildVesperTools,
  runVesperTool,
  VESPER_TOOL_NAMES,
  type VesperToolContext,
} from "@/lib/vesper/persona";
import { UNTRUSTED_DATA_SYSTEM_PROMPT, wrapToolResult } from "@/lib/security/untrusted";
import { guardToolCall, loadToolPolicyDenies } from "@/lib/security/tool-tiers";
import { filterOutput } from "@/lib/security/output-filter";
import { recordAiUsage, recordSecurityEvent } from "@/lib/security/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vesper — the Operator agent (a second persona). This route MIRRORS
// /api/assistant's agentic tool-use loop against the Anthropic Messages API, but
// with Vesper's persona and Vesper's tools (lib/vesper/persona). Same shape:
// RLS-scoped @supabase/ssr client for every tool, model resolved from the
// caller's role tier (lib/ai/models), conversation persisted to
// ai_conversations / ai_messages. Vesper is internal only — its one write tool
// (propose_play) files a PENDING action_request; a human approves before
// anything runs.
const MAX_INPUT_CHARS = 4000;
const DAILY_MESSAGE_LIMIT = 100;
const MAX_TOOL_ROUNDS = 5;

const VesperSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().max(MAX_INPUT_CHARS * 2).optional(),
});

type MessageRow = { role: string; content: string };
type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };
type AnthropicMessage = { role: "user" | "assistant"; content: unknown };
type AnthropicResponse = {
  content?: ContentBlock[];
  stop_reason?: string;
  error?: { message?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
};

function textOf(content: ContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Vesper isn't configured yet. Add ANTHROPIC_API_KEY in Vercel." },
      { status: 503 }
    );
  }

  const parsed = await parseJsonBody(request, VesperSchema, "vesper");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const message = (body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "Message is empty." }, { status: 400 });
  if (message.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { error: `Message too long (max ${MAX_INPUT_CHARS} characters).` },
      { status: 400 }
    );
  }

  const supabase = createServerSupabaseClient();
  const model = TIER_MODEL[defaultTierFor(profile.role)];

  // Per-user daily guardrail (RLS scopes ai_messages to this user).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("ai_messages")
    .select("id", { count: "exact", head: true })
    .eq("role", "user")
    .gte("created_at", since);
  if ((count ?? 0) >= DAILY_MESSAGE_LIMIT) {
    return NextResponse.json({ error: "Daily message limit reached. Try again tomorrow." }, { status: 429 });
  }

  // Resolve or create the conversation (Vesper reuses the assistant tables).
  let conversationId = body.conversationId ?? null;
  if (!conversationId) {
    const convInsert: Database["public"]["Tables"]["ai_conversations"]["Insert"] = {
      org_id: profile.org_id,
      user_id: profile.id,
      title: `Vesper — ${message.slice(0, 48)}`,
    };
    const { data: created, error: convErr } = await supabase
      .from("ai_conversations")
      .insert(convInsert as never)
      .select("id")
      .single();
    if (convErr || !created) {
      return NextResponse.json({ error: "Could not start a conversation." }, { status: 500 });
    }
    conversationId = (created as { id: string }).id;
  }
  const convId = conversationId as string;

  const userInsert: Database["public"]["Tables"]["ai_messages"]["Insert"] = {
    conversation_id: convId,
    role: "user",
    content: message,
  };
  const { error: userMsgErr } = await supabase.from("ai_messages").insert(userInsert as never);
  if (userMsgErr) return NextResponse.json({ error: "Could not save your message." }, { status: 500 });

  const { data: historyData } = await supabase
    .from("ai_messages")
    .select("role, content")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: true });
  const history = (historyData ?? []) as unknown as MessageRow[];
  const messages: AnthropicMessage[] = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  // Part A: the instruction-source boundary sits above Vesper's persona so any
  // tool result (scoreboard notes, play params) is read as data, never obeyed.
  const systemPrompt = [buildVesperSystemPrompt(profile.role, profile.full_name), UNTRUSTED_DATA_SYSTEM_PROMPT].join("\n\n");
  const tools = buildVesperTools();
  const toolCtx: VesperToolContext = { supabase, profile };
  const revalidate = new Set<string>();
  let assistantText = "";

  // Part B: org-disabled tools (policy_registry / tool_permission).
  const deniedTools = await loadToolPolicyDenies(supabase, profile.org_id);
  // Part D: token accumulators for ai_usage_log.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    for (let round = 0; ; round++) {
      const allowTools = round < MAX_TOOL_ROUNDS;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: systemPrompt,
          messages,
          ...(allowTools ? { tools } : {}),
        }),
      });

      if (!res.ok) {
        const detail = await res.text();
        console.error("Anthropic API error (vesper)", res.status, detail);
        return NextResponse.json({ error: "Vesper is temporarily unavailable." }, { status: 502 });
      }

      const data = (await res.json()) as AnthropicResponse;
      totalInputTokens += data.usage?.input_tokens ?? 0;
      totalOutputTokens += data.usage?.output_tokens ?? 0;

      if (allowTools && data.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: data.content ?? [] });
        const toolUses = (data.content ?? []).filter((b): b is ToolUseBlock => b.type === "tool_use");
        const toolResults = await Promise.all(
          toolUses.map(async (block) => {
            // Part B: least-privilege gate before any tool runs.
            const guard = guardToolCall(block.name, profile.role, deniedTools);
            let result: unknown;
            if (!guard.ok) {
              result = { error: guard.reason, denied: true, tier: guard.tier };
            } else if (VESPER_TOOL_NAMES.has(block.name)) {
              result = await runVesperTool(block.name, block.input, toolCtx);
            } else {
              result = { error: `Unknown tool: ${block.name}` };
            }
            if (block.name === "propose_play" && (result as { ok?: boolean }).ok) {
              revalidate.add("/approvals");
              revalidate.add("/vesper");
            }
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              // Part A: frame the tool result as untrusted data.
              content: wrapToolResult(block.name, result),
            };
          })
        );
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      assistantText = textOf(data.content) || "I wasn't able to generate a response.";
      break;
    }
  } catch (err) {
    console.error("Vesper request failed", err);
    return NextResponse.json({ error: "Vesper is temporarily unavailable." }, { status: 502 });
  }

  // Part C: redact any leaked secret / sensitive number before persisting/returning.
  const filtered = filterOutput(assistantText);
  const safeText = filtered.text;
  if (!filtered.safe) {
    void recordSecurityEvent(supabase, {
      orgId: profile.org_id,
      userId: profile.id,
      eventType: "output_redacted",
      severity: "critical",
      detail: { agent: "vesper", findings: filtered.findings.map((f) => ({ kind: f.kind, label: f.label })) },
    });
  }

  // Part D: record this turn's usage.
  void recordAiUsage(supabase, {
    orgId: profile.org_id,
    userId: profile.id,
    feature: "vesper",
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  });

  const assistantInsert = { conversation_id: convId, role: "assistant", content: safeText, model };
  await supabase.from("ai_messages").insert(assistantInsert as never);
  await supabase
    .from("ai_conversations")
    .update({ updated_at: new Date().toISOString() } as never)
    .eq("id", convId);

  for (const path of revalidate) {
    try {
      revalidatePath(path);
    } catch {
      // best-effort
    }
  }

  return NextResponse.json({
    conversationId: convId,
    assistant: { role: "assistant", content: safeText },
    model,
  });
}
