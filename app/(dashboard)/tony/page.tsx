import { TonyAnimatedPage } from "@/components/tony/TonyAnimatedPage";
import { TonyChatBlock } from "@/components/tony/TonyChatBlock";
import { TonyChatHeaderControls } from "@/components/tony/TonyChatHeaderControls";
import { TonyChatPlanetRelay } from "@/components/tony/TonyChatPlanetRelay";
import { TonySideRail } from "@/components/tony/TonySideRail";
import { normalizeTone, type ToneSettings } from "@/lib/assistant/tone";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { type ModelTier, tierForModel } from "@/lib/ai/models";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  tier?: ModelTier;
};

export const dynamic = "force-dynamic";

// Tony's primary surface. Keep /tony on the same conversation + personality
// state as the assistant so text and voice remain one continuous Tony session.
export default async function TonyPage() {
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
    const { data: msgData } = await supabase
      .from("ai_messages" as never)
      .select("role, content, model")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    initialMessages = (
      (msgData ?? []) as unknown as {
        role: string;
        content: string;
        model: string | null;
      }[]
    ).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
      tier: tierForModel(message.model) ?? undefined,
    }));
  }

  const { data: tone } = await supabase
    .from("assistant_settings" as never)
    .select("preset, directness, warmth, humor, brevity")
    .eq("user_id", profile.id)
    .maybeSingle();

  return (
    <>
      <TonyAnimatedPage
        initialConversationId={conversationId}
        initialMessages={initialMessages}
        orgId={profile.org_id}
        userId={profile.id}
        tone={normalizeTone(tone as Partial<ToneSettings> | null)}
      />
      <TonyChatBlock
        initialConversationId={conversationId}
        initialMessages={initialMessages}
      />
      <TonyChatHeaderControls />
      <TonyChatPlanetRelay />
      {/* HR sees its own rail here; every other role keeps Tony's. */}
      <TonySideRail role={profile.preview_role} />
    </>
  );
}
