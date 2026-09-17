import { describe, expect, it } from "vitest";
import { buildMockAgentResponse, isAgentMockModeEnabled } from "@/lib/ai/agent-mock";

describe("agent mock mode", () => {
  it("is enabled only by the exact true flag", () => {
    expect(isAgentMockModeEnabled("true")).toBe(true);
    expect(isAgentMockModeEnabled("TRUE")).toBe(false);
    expect(isAgentMockModeEnabled("false")).toBe(false);
    expect(isAgentMockModeEnabled(undefined)).toBe(false);
  });

  it.each(["atlas", "care", "herald", "oracle", "prospector"] as const)(
    "returns a clearly labelled, non-persistent %s response",
    (agent) => {
      const response = buildMockAgentResponse(agent, "test the agent", undefined, "ceo");
      expect(response.mock).toBe(true);
      expect(response.model).toBe("mock-no-api");
      expect(response.conversationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.assistant.content).toContain("MOCK DATA");
      expect(response.assistant.content).toMatch(/not|no /i);
    }
  );

  it("keeps Herald drafts deterministic and unsent", () => {
    const first = buildMockAgentResponse("herald", "Draft a message", "11111111-1111-4111-8111-111111111111");
    const second = buildMockAgentResponse("herald", "Draft a message", "11111111-1111-4111-8111-111111111111");
    expect(first).toEqual(second);
    expect(first.assistant.content).toContain("was not sent");
  });

  it("preserves role restrictions in mock mode", () => {
    const oracle = buildMockAgentResponse("oracle", "show budget health", undefined, "team_member");
    const herald = buildMockAgentResponse("herald", "propose send", undefined, "team_member");
    expect(oracle.assistant.content).toContain("restricted to CEO and COO");
    expect(herald.assistant.content).toContain("cannot file a send proposal");
  });
});
