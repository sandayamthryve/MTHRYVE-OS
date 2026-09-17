import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { parseJsonBody } from "@/lib/security/api";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";
import {
  type ModelTier,
  TIER_MODEL,
  TIER_ORDER,
  defaultTierFor,
  isModelTier,
} from "@/lib/ai/models";
import {
  ASSISTANT_TOOLS,
  ASSISTANT_SYSTEM_PROMPT,
  TONY_VOICE_AND_TONE,
  buildGroundingContext,
  loadToneModifier,
  runAssistantTool,
  type ToolContext,
} from "@/lib/assistant/tools";
import { isSimpleConversational } from "@/lib/assistant/fastpath";
import {
  consumeAnthropicStream,
  type ToolUseBlock as StreamToolUseBlock,
} from "@/lib/assistant/anthropic-stream";
import {
  NAVIGATE_TOOL,
  buildNavigationPrompt,
  resolveNavigation,
  routesForRole,
  type Navigation,
} from "@/lib/assistant/routes";
import {
  READ_TOOL_NAMES,
  buildReadTools,
  buildReadPrompt,
  runAssistantReadTool,
} from "@/lib/assistant/read";
import {
  ACT_TOOL_NAMES,
  buildActTools,
  buildActPrompt,
  buildIdentityPrompt,
  runAssistantActTool,
  actRevalidatePaths,
} from "@/lib/assistant/act";
import {
  SEARCH_CAPABILITIES_TOOL,
  CREATE_MISSION_TASKS_TOOL,
  CAPABILITY_READ_TOOL_NAMES,
  CAPABILITY_ACT_TOOL_NAMES,
  runCapabilityTool,
  capabilityRevalidatePaths,
  buildCapabilityPrompt,
} from "@/lib/capabilities/tony";
import { UNTRUSTED_DATA_SYSTEM_PROMPT, wrapUntrusted, wrapToolResult, scanForInjection } from "@/lib/security/untrusted";
import { guardToolCall, loadToolPolicyDenies } from "@/lib/security/tool-tiers";
import { filterOutput } from "@/lib/security/output-filter";
import { recordAiUsage, recordSecurityEvent } from "@/lib/security/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Mthryve AI — the grounded company assistant (AI_AGENTS.md Agent 1). Unlike the
// old ungrounded chatbot, this runs an agentic tool-use loop against the
// Anthropic Messages API: the model can only answer from data returned by the
// fixed, read-only tools in @/lib/assistant/tools, each of which queries through
// THIS request's @supabase/ssr client so Postgres RLS scopes every row to the
// asking user (org + per-role visibility, e.g. finance/payroll are ceo/coo-only).
// The Anthropic key is server-only and never reaches the client; the model never
// sees the service key, connection strings, or other users' data.
//
// D-012 (tiered models): which Claude model answers depends on the caller's
// tier. Each role has a default tier (its ceiling without a grant); ceo/coo
// default to premium (Opus). Asking for a higher tier requires a single-use
// grant minted by CEO/COO through the approval queue. The grant is consumed only
// when the call succeeds, so a failed request never burns it.
const MAX_INPUT_CHARS = 4000;
const DAILY_MESSAGE_LIMIT = 100; // simple per-user cost guardrail (BUGS R-004)
const MAX_TOOL_ROUNDS = 6; // cap tool iterations so the loop can't run away

// Payload contract (PASTE 2.4 — Part D). The message length ceiling is enforced
// again below with a user-facing message; here we cap generously to reject junk.
const AssistantSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().max(MAX_INPUT_CHARS * 2).optional(),
  tier: z.string().max(50).optional(),
  stream: z.boolean().optional(),
});

type ModelGrant = { id: string; tier: ModelTier; expires_at: string | null };
type MessageRow = { role: string; content: string };

// Anthropic content blocks we care about in the loop.
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
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "The assistant isn't configured yet. Add ANTHROPIC_API_KEY in Vercel." },
      { status: 503 }
    );
  }

  const parsed = await parseJsonBody(request, AssistantSchema, "assistant");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const message = (body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "Message is empty." }, { status: 400 });
  }
  if (message.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { error: `Message too long (max ${MAX_INPUT_CHARS} characters).` },
      { status: 400 }
    );
  }

  const supabase = createServerSupabaseClient();

  // --- D-012 tier resolution -------------------------------------------------
  const roleDefault = defaultTierFor(profile.role);
  const requested: ModelTier = isModelTier(body.tier) ? body.tier : roleDefault;

  let effectiveTier: ModelTier = requested;
  let grantToConsume: string | null = null;

  if (TIER_ORDER[requested] > TIER_ORDER[roleDefault]) {
    // Above the role ceiling — needs a live single-use grant that covers it.
    const nowIso = new Date().toISOString();
    const { data: grantData } = await supabase
      .from("model_grants" as never)
      .select("id, tier, expires_at")
      .eq("user_id", profile.id)
      .is("used_at", null);

    const grants = ((grantData ?? []) as unknown as ModelGrant[]).filter(
      (g) =>
        TIER_ORDER[g.tier] >= TIER_ORDER[requested] &&
        (g.expires_at === null || g.expires_at > nowIso)
    );
    grants.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
    const grant = grants[0];

    if (!grant) {
      return NextResponse.json(
        {
          error: "That model tier needs CEO/COO approval for this task.",
          needsApproval: true,
          requestedTier: requested,
          roleDefaultTier: roleDefault,
        },
        { status: 403 }
      );
    }
    effectiveTier = grant.tier;
    grantToConsume = grant.id;
  }

  const model = TIER_MODEL[effectiveTier];

  // Rate limit: RLS scopes ai_messages to this user, so this count is per-user.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("ai_messages")
    .select("id", { count: "exact", head: true })
    .eq("role", "user")
    .gte("created_at", since);
  if ((count ?? 0) >= DAILY_MESSAGE_LIMIT) {
    return NextResponse.json(
      { error: "Daily message limit reached. Try again tomorrow." },
      { status: 429 }
    );
  }

  // Resolve or create the conversation.
  let conversationId = body.conversationId ?? null;
  if (!conversationId) {
    const convInsert: Database["public"]["Tables"]["ai_conversations"]["Insert"] = {
      org_id: profile.org_id,
      user_id: profile.id,
      title: message.slice(0, 60),
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

  // Persist the user's message.
  const userInsert: Database["public"]["Tables"]["ai_messages"]["Insert"] = {
    conversation_id: convId,
    role: "user",
    content: message,
  };
  const { error: userMsgErr } = await supabase.from("ai_messages").insert(userInsert as never);
  if (userMsgErr) {
    return NextResponse.json({ error: "Could not save your message." }, { status: 500 });
  }

  // Build the prompt from the full conversation history (ascending). Only the
  // final text of each turn is stored, so history is plain text — the tool-use
  // exchange happens transiently within this request's loop below.
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

  // --- Agentic tool-use loop -------------------------------------------------
  // Repeatedly call Claude; when it asks for tools, run them RLS-scoped and feed
  // the results back. Stop when it returns a final text answer, or after
  // MAX_TOOL_ROUNDS (on the final call we drop the tools to force an answer).
  const toolCtx: ToolContext = { supabase, profile };

  // Part B: tools leadership has switched off org-wide (policy_registry /
  // tool_permission). Best-effort; empty set if none. The per-call guard also
  // enforces least-privilege by role.
  const deniedTools = await loadToolPolicyDenies(supabase, profile.org_id);

  // Part D: accumulate token usage across the tool-loop rounds so the finished
  // turn is recorded once in ai_usage_log (spend + mass-read signal).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Load the org's Projects Log (active + paused) and Tony Memory (pinned +
  // recent) once per request and append it to the system prompt, so Tony can
  // answer "what am I working on / paused / what did we decide" without a tool
  // round-trip. RLS-scoped; returns "" on any read failure.
  // Load the caller's Personality Dial and the org grounding in parallel. The
  // TONE MODIFIER (delivery only — see loadToneModifier / tone.ts) is prepended
  // ABOVE the base prompt so the phrasing steer + its "never change the facts"
  // HARD RULE frame everything below, including the grounded data.
  const [toneModifier, groundingContext] = await Promise.all([
    loadToneModifier(toolCtx),
    buildGroundingContext(toolCtx),
  ]);

  // The `navigate` route registry is role-filtered: leadership-only pages
  // (Finance, Payroll, etc.) are stripped for anyone who isn't ceo/coo, so the
  // model is never even told they exist for that caller. Appended to the system
  // prompt so the model can only pick a path it can actually see.
  const navRoutes = routesForRole(profile.role);
  const navigationPrompt = buildNavigationPrompt(navRoutes);

  // Two-tier identity + act tier (Phase 2, Step C). The identity line (Full Tony
  // for the CEO, mini-Tony for everyone else) and the ACT block (what Tony may DO
  // — direct self-scoped writes vs. queued proposals — scaled by role) are built
  // from the caller's role alone, so every surface frames and gates itself the
  // same way. Identity frames everything below it; the act block sits last.
  const identityPrompt = buildIdentityPrompt(profile.role, profile.full_name);
  const actPrompt = buildActPrompt(profile.role);
  // The READ tier contract (three sources — live DB / knowledge / memory — always
  // grounded + cited). Named tools are role-scoped: the finance snapshot is only
  // mentioned for leadership, matching buildReadTools' omission.
  const readPrompt = buildReadPrompt(profile.role);
  // Vesper Core (capability registry + missions): the honesty-by-status contract
  // and the draft→confirm mission flow. Available to every role — reads are RLS
  // org-scoped and mission-task creation follows the caller's own task rights.
  const capabilityPrompt = buildCapabilityPrompt();
  // TONY_VOICE_AND_TONE (the Jarvis persona baseline — delivery only) sits right
  // under the identity line and above the grounding contract, so every answer
  // reads human + futuristic while the honesty/citation rules below stay hard.
  // The Projects Log + Tony Memory are user-entered content, so they are wrapped
  // as UNTRUSTED DATA — Tony reads them as ground truth for "what are we working
  // on / what did we decide" but never obeys an instruction hidden inside them.
  // The boundary rule (UNTRUSTED_DATA_SYSTEM_PROMPT) sits high, above the data.
  const wrappedGrounding = groundingContext
    ? wrapUntrusted(groundingContext, { source: "projects-log + memory" })
    : "";

  const systemPrompt = [
    toneModifier,
    identityPrompt,
    TONY_VOICE_AND_TONE,
    ASSISTANT_SYSTEM_PROMPT,
    UNTRUSTED_DATA_SYSTEM_PROMPT,
    readPrompt,
    capabilityPrompt,
    wrappedGrounding,
    navigationPrompt,
    actPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  // The tools: the READ tier (three memory sources, role-scoped — finance omitted
  // for non-leadership), the remaining structured reads, the client-side
  // `navigate` action, and the role-scaled act tools (direct self-scoped writes
  // for all; the propose tool only for roles RLS lets create an action_request —
  // ceo/coo/department_head).
  const tools = [
    ...buildReadTools(profile.role),
    ...ASSISTANT_TOOLS,
    SEARCH_CAPABILITIES_TOOL,
    CREATE_MISSION_TASKS_TOOL,
    NAVIGATE_TOOL,
    ...buildActTools(profile.role),
  ];

  // Pages an act tool wrote to this turn, revalidated once at the end so the
  // affected boards reflect the change on the user's next view.
  const revalidate = new Set<string>();

  // A pending navigation captured from a valid `navigate` call. When set we stop
  // the loop and hand { path, label } to the client, which does the router.push.
  let navigation: Navigation | null = null;

  // Fast path (BUGS/latency): plainly conversational messages ("hi", "thanks",
  // "who are you") have nothing to look up, so we skip the tool set entirely and
  // answer in a single call. Same lean system prompt (persona + grounding rules)
  // — the model just isn't handed the tools, which cuts time-to-first-token.
  const fastPath = isSimpleConversational(message);

  // Build the Anthropic request body for a round. `stream` toggles token
  // streaming; `allowTools` drops the tool set on the fast path and the forced
  // final round. `messages` is read at call time so tool rounds see the latest.
  const callBody = (allowTools: boolean, stream: boolean) =>
    JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages,
      ...(allowTools ? { tools } : {}),
      ...(stream ? { stream: true } : {}),
    });

  const anthropicHeaders = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };

  // Resolve a batch of tool_use blocks: run navigate (client-side), READ, ACT,
  // and the remaining structured reads RLS-scoped. Returns the tool_result blocks
  // to feed back to the model, plus the first valid navigation (the caller stores
  // it), and marks any written pages for revalidation. Shared by the streaming
  // and non-streaming loops so behaviour is identical. An arrow const (declared
  // after the auth check) so `profile` stays narrowed non-null inside it.
  const runToolUses = async (
    toolUses: Array<{ id: string; name: string; input: unknown }>
  ) => {
    // `navigate` is a client-side action, not a data read. Resolve the first
    // valid one against this caller's role-filtered registry.
    let nav: Navigation | null = null;
    for (const block of toolUses) {
      if (block.name !== NAVIGATE_TOOL.name) continue;
      const input = (block.input ?? {}) as { path?: unknown; label?: unknown };
      const resolved = resolveNavigation(profile.role, input.path, input.label);
      if (resolved) {
        nav = resolved;
        break;
      }
    }

    const toolResults = await Promise.all(
      toolUses.map(async (block) => {
        const wrap = (result: unknown) => ({
          type: "tool_result" as const,
          tool_use_id: block.id,
          // Part A: every tool result is framed as UNTRUSTED DATA before it
          // re-enters the prompt, and scanned for embedded instructions.
          content: wrapToolResult(block.name, result),
        });

        // Part B: least-privilege gate. A tool disabled by org policy, or one the
        // caller's role may not use, is refused here — it never runs.
        const guard = guardToolCall(block.name, profile.role, deniedTools);
        if (!guard.ok) {
          return wrap({ error: guard.reason, denied: true, tier: guard.tier });
        }

        let result: unknown;
        if (block.name === NAVIGATE_TOOL.name) {
          const input = (block.input ?? {}) as { path?: unknown; label?: unknown };
          const navResolved = resolveNavigation(profile.role, input.path, input.label);
          result = navResolved
            ? { ok: true, navigated_to: navResolved.path, label: navResolved.label }
            : {
                ok: false,
                error:
                  "No page in the registry matches that. Tell the user there's no page for that — do not invent a path.",
              };
        } else if (READ_TOOL_NAMES.has(block.name)) {
          result = await runAssistantReadTool(block.name, block.input, toolCtx);
          // Part A: retrieval (RAG excerpts, memory) can carry injected text —
          // flag it as a security signal so a surge is detectable, and so the
          // wrapped result surfaces it to Tony (who reports, never obeys).
          const hits = scanForInjection(JSON.stringify(result));
          if (hits.length) {
            void recordSecurityEvent(supabase, {
              orgId: profile.org_id,
              userId: profile.id,
              eventType: "injection_flagged",
              detail: { tool: block.name, patterns: hits },
            });
          }
        } else if (CAPABILITY_READ_TOOL_NAMES.has(block.name) || CAPABILITY_ACT_TOOL_NAMES.has(block.name)) {
          // Vesper Core: search_capabilities (read) + create_mission_tasks (act).
          result = await runCapabilityTool(block.name, block.input, toolCtx);
          if ((result as { ok?: boolean }).ok) {
            for (const p of capabilityRevalidatePaths(block.name)) revalidate.add(p);
          }
        } else if (ACT_TOOL_NAMES.has(block.name)) {
          result = await runAssistantActTool(block.name, block.input, toolCtx);
          if ((result as { ok?: boolean }).ok) {
            for (const p of actRevalidatePaths(block.name)) revalidate.add(p);
          }
        } else {
          result = await runAssistantTool(block.name, block.input, toolCtx);
        }

        // Part D: an RLS/permission error surfacing through a tool is a security
        // signal (probe or misconfig) — record it so surges are detectable.
        const errMsg = (result as { error?: unknown })?.error;
        if (typeof errMsg === "string" && /row-level security|permission denied|not authorized|rls/i.test(errMsg)) {
          void recordSecurityEvent(supabase, {
            orgId: profile.org_id,
            userId: profile.id,
            eventType: "rls_denial",
            detail: { tool: block.name },
          });
        }

        return wrap(result);
      })
    );

    return { toolResults, navigation: nav };
  };

  // Persist the finished turn: consume the single-use grant (only now, so a
  // failed request keeps it), save the reply tagged with its model, bump the
  // conversation, and revalidate any pages an act tool wrote. Shared by both
  // response paths. Best-effort revalidation never fails the reply.
  // Returns the SAFE (possibly redacted) reply text — callers use this, not the
  // raw model text, so a leaked secret never reaches the client or the DB.
  const finalizeReply = async (assistantText: string): Promise<string> => {
    // Part C: scan the model's answer for leaked secrets / sensitive numbers and
    // redact before returning or persisting. A hit is recorded as a signal.
    const filtered = filterOutput(assistantText);
    const safeText = filtered.text;
    if (!filtered.safe) {
      void recordSecurityEvent(supabase, {
        orgId: profile.org_id,
        userId: profile.id,
        eventType: "output_redacted",
        severity: "critical",
        detail: { agent: "tony", findings: filtered.findings.map((f) => ({ kind: f.kind, label: f.label })) },
      });
    }

    // Part D: record this turn's AI usage (spend + mass-read signal).
    void recordAiUsage(supabase, {
      orgId: profile.org_id,
      userId: profile.id,
      feature: "tony",
      model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    });

    if (grantToConsume) {
      await supabase
        .from("model_grants" as never)
        .update({ used_at: new Date().toISOString() } as never)
        .eq("id", grantToConsume)
        .is("used_at", null);
    }

    // Plain literal + `as never` because the generated ai_messages Insert type
    // doesn't yet carry the `model` column added in migration 0016.
    const assistantInsert = {
      conversation_id: convId,
      role: "assistant",
      content: safeText,
      model,
    };
    await supabase.from("ai_messages").insert(assistantInsert as never);
    await supabase
      .from("ai_conversations")
      .update({ updated_at: new Date().toISOString() } as never)
      .eq("id", convId);

    for (const path of revalidate) {
      try {
        revalidatePath(path);
      } catch {
        // revalidation is a nicety, not a guarantee.
      }
    }

    return safeText;
  };

  // --- Streaming path (opt-in via { stream: true }) --------------------------
  // Tokens flow to the client the instant they generate — no wait-for-full-reply
  // — so chat renders live and voice can speak sentence-by-sentence. The tool
  // loop is unchanged: intermediate rounds resolve tools server-side, and the
  // terminal answer streams. Guards, grounding, memory and persistence are all
  // identical to the JSON path; only the transport differs.
  if (body.stream === true) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        let assistantText = "";
        try {
          send({ type: "meta", conversationId: convId, tier: effectiveTier, model });

          for (let round = 0; ; round++) {
            const allowTools = !fastPath && round < MAX_TOOL_ROUNDS;
            const res = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: anthropicHeaders,
              body: callBody(allowTools, true),
            });
            if (!res.ok) {
              const detail = await res.text();
              console.error("Anthropic stream error", res.status, detail);
              send({ type: "error", error: "The assistant is temporarily unavailable." });
              break;
            }

            const streamed = await consumeAnthropicStream(res, {
              onText: (t) => send({ type: "delta", text: t }),
            });
            totalInputTokens += streamed.usage.inputTokens;
            totalOutputTokens += streamed.usage.outputTokens;

            if (allowTools && streamed.stopReason === "tool_use") {
              messages.push({ role: "assistant", content: streamed.content });
              // Keep any text the model spoke before calling the tool.
              assistantText += streamed.text;
              const { toolResults, navigation: nav } = await runToolUses(
                streamed.toolUses as StreamToolUseBlock[]
              );
              if (nav) navigation = nav;

              // A valid navigate short-circuits: the client does the router.push,
              // so we replace the reply with the canonical confirmation and stop.
              if (navigation) {
                assistantText = `Taking you to ${navigation.label} →`;
                send({ type: "navigation", path: navigation.path, label: navigation.label });
                break;
              }

              messages.push({ role: "user", content: toolResults });
              continue;
            }

            assistantText += streamed.text;
            break;
          }

          if (!assistantText.trim()) {
            assistantText = "I wasn't able to generate a response.";
            send({ type: "delta", text: assistantText });
          }

          const safeText = await finalizeReply(assistantText);
          // Part C: if the streamed text had to be redacted, tell the client to
          // replace what it rendered with the safe version.
          if (safeText !== assistantText) {
            send({ type: "redacted", text: safeText });
          }
          send({ type: "done", tier: effectiveTier, model });
        } catch (err) {
          console.error("Anthropic stream failed", err);
          try {
            send({ type: "error", error: "The assistant is temporarily unavailable." });
          } catch {
            /* controller already closed */
          }
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
      },
    });
  }

  // --- Non-streaming path (JSON, default — unchanged behaviour) --------------
  let assistantText = "";
  try {
    for (let round = 0; ; round++) {
      const allowTools = !fastPath && round < MAX_TOOL_ROUNDS;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders,
        body: callBody(allowTools, false),
      });

      if (!res.ok) {
        const detail = await res.text();
        console.error("Anthropic API error", res.status, detail);
        return NextResponse.json(
          { error: "The assistant is temporarily unavailable." },
          { status: 502 }
        );
      }

      const data = (await res.json()) as AnthropicResponse;
      totalInputTokens += data.usage?.input_tokens ?? 0;
      totalOutputTokens += data.usage?.output_tokens ?? 0;

      if (allowTools && data.stop_reason === "tool_use") {
        // Echo the assistant's turn (text + tool_use blocks) back verbatim, then
        // answer each tool_use with a tool_result. Order/ids must be preserved.
        messages.push({ role: "assistant", content: data.content ?? [] });

        const toolUses = (data.content ?? []).filter(
          (b): b is ToolUseBlock => b.type === "tool_use"
        );

        const { toolResults, navigation: nav } = await runToolUses(toolUses);
        if (nav) navigation = nav;

        // A valid navigate short-circuits the loop: the client will do the
        // router.push, so Tony just confirms the destination.
        if (navigation) {
          assistantText = `Taking you to ${navigation.label} →`;
          break;
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Final answer (or forced answer on the no-tools last round).
      assistantText = textOf(data.content) || "I wasn't able to generate a response.";
      break;
    }
  } catch (err) {
    console.error("Anthropic request failed", err);
    return NextResponse.json({ error: "The assistant is temporarily unavailable." }, { status: 502 });
  }

  const safeAssistantText = await finalizeReply(assistantText);

  return NextResponse.json({
    conversationId: convId,
    assistant: { role: "assistant", content: safeAssistantText },
    tier: effectiveTier,
    model,
    // Present only when Tony chose to navigate; the client does router.push(path).
    ...(navigation ? { navigation } : {}),
  });
}
