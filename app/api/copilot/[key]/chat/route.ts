import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readCompartmentScope } from "@/lib/cognition/scope";
import { logCognitionUsage } from "@/lib/cognition/usage";
import { searchKnowledge } from "@/lib/knowledge/search";
import { readCopilot } from "@/lib/copilot/members";
import {
  COPILOT_MODEL,
  ACTION_QUEUED_NOTE,
  ACTION_BLOCKED_NOTE,
  buildScopeText,
  buildCopilotSystemPrompt,
  callCopilot,
  parseProposedAction,
  requiredRoleForMember,
  copilotActionDraft,
  type CopilotMessage,
} from "@/lib/copilot/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/copilot/[key]/chat — the Copilot Fleet's conversational endpoint.
//
// Each copilot IS a council_members row made persistent + chatty: same persona /
// domain / compartment_codes, now grounded in that compartment's LIVE metrics
// (the Cognition Loop's READ half — read only, nothing filed from grounding),
// RAG-augmented over project docs, Sonnet-backed, and approval-gated. It reuses
// the existing spine end to end — ai_conversations + ai_messages for the thread
// and memory, action_requests for any proposed action, ai_usage_log for spend —
// and adds no parallel engine. It NEVER executes: a proposed action becomes ONE
// pending action_requests row a human must approve.
//
// Guards: auth required; RLS scopes the conversation self-only (user_id =
// auth.uid()) and every grounded read to what the caller may see.

const MAX_INPUT_CHARS = 4000;

// The client sends `conversationId: null` on the first turn (its state starts
// null before the server assigns a thread), so this must accept null as well as
// undefined — `.optional()` alone rejects null and would fail EVERY first send.
// `message` is what the client posts (not `content`/`text`); it's validated
// non-empty below. `[key]` comes from the URL param, never the body.
const ChatSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().max(MAX_INPUT_CHARS * 2).optional(),
});

type Shim = { from: (t: string) => any };
type MessageRow = { role: string; content: string };

export async function POST(request: Request, { params }: { params: { key: string } }) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Copilots aren't configured yet. Add ANTHROPIC_API_KEY in Vercel." },
      { status: 503 }
    );
  }

  // Parse inline (not via the shared parseJsonBody) so a schema mismatch returns
  // the FAILING FIELD, not a bare "Invalid request payload" — debuggable next
  // time a client↔server payload drifts. Field names + zod messages only; no raw
  // values are echoed back.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body (expected JSON)." }, { status: 400 });
  }
  const result = ChatSchema.safeParse(raw);
  if (!result.success) {
    const flat = result.error.flatten();
    console.warn("[copilot] payload validation failed", flat);
    const fieldErrors = Object.entries(flat.fieldErrors)
      .map(([field, errs]) => `${field}: ${(errs ?? []).join(", ")}`)
      .join("; ");
    return NextResponse.json(
      { error: `Invalid request payload${fieldErrors ? ` — ${fieldErrors}` : "."}` },
      { status: 400 }
    );
  }
  const body = result.data;

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
  const db = supabase as unknown as Shim;

  // Resolve the copilot by key (its persona, domain and compartment_codes).
  const member = await readCopilot(db, params.key);
  if (!member) {
    return NextResponse.json({ error: "No such copilot." }, { status: 404 });
  }

  // --- Resolve or create THIS copilot's conversation --------------------------
  // Scoped by (copilot_key, user_id). RLS already enforces user_id = auth.uid();
  // we filter by copilot_key so each copilot keeps its own thread. copilot_key was
  // added to ai_conversations by the DB owner and isn't in the generated types
  // yet, so those refs are cast (same pattern the codebase uses for new columns).
  let conversationId = body.conversationId ?? null;

  if (conversationId) {
    // Trust a passed id only if it's this copilot's thread (and the user's — RLS).
    const { data: owned } = await supabase
      .from("ai_conversations" as never)
      .select("id, copilot_key")
      .eq("id", conversationId)
      .maybeSingle();
    const row = owned as { id: string; copilot_key: string | null } | null;
    if (!row || row.copilot_key !== params.key) conversationId = null;
  }

  if (!conversationId) {
    const { data: existing } = await supabase
      .from("ai_conversations" as never)
      .select("id")
      .eq("copilot_key", params.key)
      .order("updated_at", { ascending: false })
      .limit(1);
    const row = ((existing ?? []) as unknown as { id: string }[])[0];
    conversationId = row?.id ?? null;
  }

  if (!conversationId) {
    const { data: created, error: convErr } = await supabase
      .from("ai_conversations")
      .insert({
        org_id: profile.org_id,
        user_id: profile.id,
        title: member.name,
        copilot_key: params.key,
      } as never)
      .select("id")
      .single();
    if (convErr || !created) {
      return NextResponse.json({ error: "Could not start this copilot chat." }, { status: 500 });
    }
    conversationId = (created as { id: string }).id;
  }

  const convId = conversationId as string;

  // Persist the user's message before reasoning (so the thread is durable even if
  // the model call fails).
  const { error: userMsgErr } = await supabase
    .from("ai_messages")
    .insert({ conversation_id: convId, role: "user", content: message } as never);
  if (userMsgErr) {
    return NextResponse.json({ error: "Could not save your message." }, { status: 500 });
  }

  // The full thread (ascending) → the model's memory. Only final text is stored,
  // so history is plain user/assistant turns.
  const { data: historyData } = await supabase
    .from("ai_messages")
    .select("role, content")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: true });
  const history = (historyData ?? []) as unknown as MessageRow[];
  const messages: CopilotMessage[] = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  // --- Grounding (READ ONLY) + RAG, in parallel ------------------------------
  // The scope read is the Cognition Loop's own READ half over this copilot's
  // compartments — current health vs targets, honest "—" for empties. NOTHING is
  // filed from grounding. RAG pulls citable project-doc chunks for the question.
  const [scope, hits] = await Promise.all([
    readCompartmentScope(db, member.compartment_codes),
    searchKnowledge(message, 6).catch(() => []),
  ]);

  const systemPrompt = buildCopilotSystemPrompt({
    member,
    scopeText: buildScopeText(scope, member),
    hits,
  });

  // --- The single Sonnet call over the thread --------------------------------
  let reply: { text: string; usage: { inputTokens: number; outputTokens: number } };
  try {
    reply = await callCopilot({
      model: COPILOT_MODEL,
      system: systemPrompt,
      messages,
      maxTokens: 2048,
    });
  } catch (err) {
    console.error("Copilot generation failed", err);
    return NextResponse.json({ error: "This copilot is temporarily unavailable." }, { status: 502 });
  }

  // Log the call regardless of what happens next — it cost money. feature carries
  // the copilot key so per-copilot spend is attributable in ai_usage_log.
  await logCognitionUsage(db, {
    orgId: profile.org_id,
    userId: profile.id,
    model: COPILOT_MODEL,
    usage: reply.usage,
    feature: `copilot:${member.key}`,
  });

  // --- Action path -----------------------------------------------------------
  // If the reply proposes a concrete action, strip the protocol block from what
  // the user sees and file ONE pending action_requests row. proposed_action is
  // null — recommendation-only, nothing auto-executes. required_role is decided
  // by the copilot's DOMAIN (money/finance → leadership), so gating can't be
  // talked down by the model.
  const { cleanedText, action } = parseProposedAction(reply.text);
  let assistantText = cleanedText || "I wasn't able to generate a response.";
  let actionQueued = false;

  if (action) {
    const draft = copilotActionDraft(member, action, requiredRoleForMember(member));
    const { data: inserted, error: actErr } = await db
      .from("action_requests")
      .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
      .select("id")
      .single();
    if (!actErr && (inserted as { id?: string } | null)?.id) {
      actionQueued = true;
      assistantText = `${assistantText}\n\n${ACTION_QUEUED_NOTE}`;
    } else {
      // RLS INSERT on action_requests is ceo/coo/department_head — a member's
      // proposal can't be filed. Stay honest about that instead of pretending.
      assistantText = `${assistantText}\n\n${ACTION_BLOCKED_NOTE}`;
    }
  }

  // Persist the assistant turn (tagged with the model) and bump the conversation.
  await supabase
    .from("ai_messages")
    .insert({ conversation_id: convId, role: "assistant", content: assistantText, model: COPILOT_MODEL } as never);
  await supabase
    .from("ai_conversations")
    .update({ updated_at: new Date().toISOString() } as never)
    .eq("id", convId);

  return NextResponse.json({
    conversationId: convId,
    assistant: { role: "assistant", content: assistantText },
    model: COPILOT_MODEL,
    ...(actionQueued ? { actionQueued: true } : {}),
  });
}
