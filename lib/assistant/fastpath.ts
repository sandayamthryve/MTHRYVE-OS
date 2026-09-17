// Fast-path detection for the assistant's low-latency reply.
//
// Most of what makes Tony feel slow is the agentic tool loop: even a "hi" or
// "thanks" pays for a full tool-enabled round-trip before any token appears. For
// plainly conversational messages there is nothing to look up, so we skip the
// tools entirely and stream a single answer — the model still sees the same lean
// system prompt (persona + grounding rules), it just isn't handed the tools.
//
// This is a HEURISTIC, and deliberately conservative: it only fires on short
// messages that look like small talk and carry none of the words that signal a
// data question. Anything with a number, a "?", or a business/keyword token
// falls through to the full grounded loop. A false negative just costs the
// normal latency; we never want a false positive that skips a real lookup.

// Words that almost always mean the user wants grounded data or an action — if
// any appears, do NOT take the fast path.
const DATA_SIGNALS = [
  "brand", "brands", "client", "clients", "gmv", "sales", "revenue", "return",
  "returns", "rts", "payroll", "finance", "budget", "profit", "cash", "invoice",
  "project", "projects", "task", "tasks", "approval", "approvals", "department",
  "team", "creator", "creators", "lead", "leads", "follow", "outreach", "report",
  "number", "numbers", "metric", "metrics", "how many", "how much", "total",
  "status", "pending", "due", "overdue", "paused", "priority", "priorities",
  "remember", "memory", "decide", "decided", "decision", "pin", "note",
  "propose", "recommend", "draft", "schedule", "who", "when", "where", "which",
  "why", "list", "show", "find", "search", "open", "go to", "navigate", "take me",
];

// Short openers/closers that are safe to answer without any lookup.
const CONVERSATIONAL = [
  "hi", "hey", "hello", "yo", "sup", "kumusta", "kamusta", "musta",
  "thanks", "thank you", "salamat", "ty", "thx", "cheers",
  "ok", "okay", "sige", "cool", "nice", "great", "awesome", "perfect",
  "good morning", "good afternoon", "good evening", "gm", "morning",
  "bye", "goodbye", "later", "good night", "gn",
  "who are you", "what are you", "what can you do", "what's your name",
  "whats your name", "help", "hello tony", "hey tony", "hi tony",
];

// True when the message is plainly conversational and carries no data/action
// signal — safe to answer with a single, tool-free, streamed reply.
export function isSimpleConversational(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (!text) return false;

  // Long messages almost always carry real intent — don't gamble.
  if (text.length > 60) return false;

  // A question mark plus more than a couple of words usually means a real ask.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (text.includes("?") && wordCount > 4) return false;

  // An exact small-talk phrase wins outright — including intros like "who are
  // you" whose words would otherwise trip the data-signal guard below.
  const bare = text.replace(/[!.…?]+$/g, "").trim();
  if (CONVERSATIONAL.includes(bare)) return true;

  // Any data/action signal token kicks it back to the full grounded loop.
  const normalized = ` ${text.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()} `;
  for (const sig of DATA_SIGNALS) {
    if (normalized.includes(` ${sig} `)) return false;
  }

  // A very short opener/closer, e.g. "hey tony!", "thanks so much".
  if (wordCount <= 4) {
    return CONVERSATIONAL.some((c) => text.startsWith(c));
  }
  return false;
}
