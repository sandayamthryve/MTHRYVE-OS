export type MockAgentName =
  | "atlas"
  | "care"
  | "herald"
  | "oracle"
  | "prospector";

export function isAgentMockModeEnabled(
  value = process.env.AGENT_MOCK_MODE
): boolean {
  return value === "true";
}

function mockReply(agent: MockAgentName, message: string, role?: string): string {
  const normalized = message.toLowerCase();
  const prefix = "MOCK DATA — no API call, database write, approval, or external action occurred.\n\n";
  const canFile = role === "ceo" || role === "coo" || role === "department_head";

  if (agent === "atlas") {
    if (normalized.includes("capabilit")) {
      return `${prefix}Demo capability snapshot:\n• TikTok Shop operations — Active\n• Creator outreach — Active\n• Finance forecasting — Pilot\n\nThese are test fixtures, not live company records.`;
    }
    if (normalized.includes("capture") || normalized.includes("propose")) {
      if (!canFile) {
        return `${prefix}Permission test passed: your role can explore Atlas but cannot file a knowledge-capture proposal.`;
      }
      return `${prefix}I simulated an Atlas knowledge-capture proposal. In live mode this would enter Approvals; mock mode deliberately created nothing.`;
    }
    return `${prefix}Demo graph snapshot:\n• 7 departments\n• 10 brands\n• Knowledge and capability links available\n\nAsk for “capabilities” or “propose a capture” to test another mock path.`;
  }

  if (agent === "care") {
    if (normalized.includes("log") || normalized.includes("mood") || normalized.includes("pulse")) {
      return `${prefix}I simulated recording a wellbeing pulse of 4/5. It was not saved. In live mode, only your own daily pulse would be written.`;
    }
    if (normalized.includes("check-in") || normalized.includes("check in") || normalized.includes("propose")) {
      if (!canFile) {
        return `${prefix}Permission test passed: your role can use Care but cannot file a confidential check-in proposal.`;
      }
      return `${prefix}I simulated a confidential check-in proposal. No employee record, notification, or approval request was created.`;
    }
    return `${prefix}Demo personal care summary:\n• Wellbeing trend: Stable\n• Attendance window: No test concerns\n• Suggested next step: Take a short recovery break\n\nThis contains no real HR or employee data.`;
  }

  if (agent === "herald") {
    if (normalized.includes("queue")) {
      return `${prefix}Demo outreach queue:\n1. Alex Rivera — creator follow-up — due today\n2. Jamie Santos — lead introduction — due tomorrow\n\nNames and records are fictional fixtures.`;
    }
    if (normalized.includes("propose") || normalized.includes("send")) {
      if (!canFile) {
        return `${prefix}Permission test passed: your role can draft outreach but cannot file a send proposal.`;
      }
      return `${prefix}I simulated filing the draft for approval. Nothing was queued, emailed, messaged, or written to the database.`;
    }
    return `${prefix}Demo follow-up draft:\n\nHi Alex,\n\nThanks for your interest in working with Mthryve. I’d love to continue the conversation and learn more about your goals. Would you be available for a quick call this week?\n\nBest,\nMthryve Team\n\nThis draft was generated locally from a fixed fixture and was not sent.`;
  }

  if (agent === "oracle") {
    if (role !== "ceo" && role !== "coo") {
      return `${prefix}Permission test passed: Oracle finance data is restricted to CEO and COO roles. No figures are available to this account.`;
    }
    if (normalized.includes("budget")) {
      return `${prefix}Demo budget health:\n• Marketing: 68% utilized\n• Operations: 54% utilized\n• People: 47% utilized\n\nAll amounts and percentages are fictional fixtures. No finance data was queried.`;
    }
    if (normalized.includes("propose") || normalized.includes("opex")) {
      return `${prefix}I simulated an Oracle cost-control recommendation. It did not create an approval and cannot move money.`;
    }
    return `${prefix}Demo 30/60/90-day outlook:\n• 30 days: Stable\n• 60 days: Stable with moderate operating-cost pressure\n• 90 days: Review discretionary spending\n\nThis is a fictional fixture, not a financial forecast.`;
  }

  if (normalized.includes("queue")) {
    return `${prefix}Demo prospect queue:\n1. Northstar Retail — HOT — score 86\n2. Harbor Goods — WARM — score 64\n3. Sample Commerce — COLD — score 31\n\nCompanies and scores are fictional fixtures.`;
  }
  if (normalized.includes("propose") || normalized.includes("task")) {
    if (!canFile) {
      return `${prefix}Permission test passed: your role can review prospects but cannot file a qualification-task proposal.`;
    }
    return `${prefix}I simulated a qualification-task proposal. No task or approval request was created, and no prospect was contacted.`;
  }
  return `${prefix}Demo prospect ranking:\n• Northstar Retail — HOT (86)\n• Harbor Goods — WARM (64)\n• Sample Commerce — COLD (31)\n\nThis is fixed test data and was not produced by a scoring API.`;
}

export function buildMockAgentResponse(
  agent: MockAgentName,
  message: string,
  conversationId?: string,
  role?: string
) {
  return {
    conversationId: conversationId ?? crypto.randomUUID(),
    assistant: { role: "assistant" as const, content: mockReply(agent, message, role) },
    model: "mock-no-api",
    mock: true,
  };
}
