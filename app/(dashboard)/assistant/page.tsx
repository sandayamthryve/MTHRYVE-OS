import { AppShell } from "@/components/layout/AppShell";
import { AssistantChat } from "@/components/assistant/AssistantChat";
import { PageHeader } from "@/components/ui";
import { TonyNorthStarPage } from "@/components/tony/TonyNorthStarPage";
import { normalizeTone, type ToneSettings } from "@/lib/assistant/tone";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { type ModelTier, tierForModel } from "@/lib/ai/models";

type ChatMessage = { role: "user" | "assistant"; content: string; tier?: ModelTier };

// Company AI assistant (AI_AGENTS.md Agent 1). Loads the user's most recent
// conversation so the thread persists across visits; the client component
// handles sending via the /api/assistant route (Claude call is server-side).
export default async function AssistantPage({searchParams}:{searchParams?:{view?:string}}) {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  const { data: convData } = await supabase
    .from("ai_conversations")
    .select("id")
    .order("updated_at", { ascending: false })
    .limit(1);
  const conversations = (convData ?? []) as unknown as { id: string }[];
  const conversationId = conversations[0]?.id ?? null;

  let initialMessages: ChatMessage[] = [];
  if (conversationId) {
    // `model` was added in migration 0016 and isn't in the generated types yet,
    // so cast the table ref to bypass select-string validation (same pattern the
    // codebase uses for not-yet-typed columns).
    const { data: msgData } = await supabase
      .from("ai_messages" as never)
      .select("role, content, model")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    initialMessages = (
      (msgData ?? []) as unknown as { role: string; content: string; model: string | null }[]
    ).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
      tier: tierForModel(m.model) ?? undefined,
    }));
  }

  if(searchParams?.view === "chat") return <AppShell breadcrumb={["Mthryve OS", "Assistant"]} profile={profile}>
    <PageHeader title="Company assistant" />
    <AssistantChat initialConversationId={conversationId} initialMessages={initialMessages}
      role={profile.role} orgId={profile.org_id} userId={profile.id}/>
  </AppShell>;

  const { data: tone } = await supabase.from("assistant_settings" as never)
    .select("preset, directness, warmth, humor, brevity").eq("user_id", profile.id).maybeSingle();

  return <TonyNorthStarPage
    initialConversationId={conversationId}
    initialMessages={initialMessages}
    orgId={profile.org_id}
    userId={profile.id}
    tone={normalizeTone(tone as Partial<ToneSettings> | null)}
  />;
}
