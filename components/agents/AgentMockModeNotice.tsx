import { isAgentMockModeEnabled } from "@/lib/ai/agent-mock";

export function AgentMockModeNotice() {
  if (!isAgentMockModeEnabled()) return null;

  return (
    <div className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
      <strong>Mock mode:</strong> responses use clearly labelled sample data. No AI API calls,
      database writes, approvals, messages, or external actions are performed.
    </div>
  );
}
