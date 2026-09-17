import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { CopilotChat } from "@/components/copilot/CopilotChat";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readCopilot } from "@/lib/copilot/members";

// One copilot's persistent chat. Loads the copilot's roster row + this user's
// existing thread for it (ai_conversations scoped by copilot_key, self-only via
// RLS) so the conversation resumes across visits. The client component sends via
// /api/copilot/[key]/chat, where the Sonnet call + grounding + gating live.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };
type ChatMessage = { role: "user" | "assistant"; content: string };

export default async function CopilotChatPage({ params }: { params: { key: string } }) {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const member = await readCopilot(db, params.key);
  if (!member) notFound();

  // The user's most recent thread for THIS copilot. copilot_key isn't in the
  // generated types yet (added by the DB owner), so the ref is cast — same
  // pattern the codebase uses for not-yet-typed columns.
  const { data: convData } = await supabase
    .from("ai_conversations" as never)
    .select("id")
    .eq("copilot_key", params.key)
    .order("updated_at", { ascending: false })
    .limit(1);
  const conversationId = ((convData ?? []) as unknown as { id: string }[])[0]?.id ?? null;

  let initialMessages: ChatMessage[] = [];
  if (conversationId) {
    const { data: msgData } = await supabase
      .from("ai_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    initialMessages = ((msgData ?? []) as unknown as { role: string; content: string }[]).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
  }

  return (
    <AppShell breadcrumb={["Mthryve OS", "AI Platform", "Copilots", member.name]} profile={profile}>
      <div className="mb-2">
        <Link href="/copilots" className="text-xs text-ink-muted underline hover:text-teal-400">
          ← All copilots
        </Link>
      </div>
      <PageHeader
        title={member.name}
        subtitle={
          <>
            {member.title} · {member.domain}. Grounded in this domain&apos;s live metrics and your
            project docs. It can propose an action for your approval — it never executes on its own.
          </>
        }
      />
      <CopilotChat
        copilotKey={member.key}
        copilotName={member.name}
        initialConversationId={conversationId}
        initialMessages={initialMessages}
      />
    </AppShell>
  );
}
