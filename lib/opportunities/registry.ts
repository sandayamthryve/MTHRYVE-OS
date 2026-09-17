// lib/opportunities/registry.ts — the single reader for the automation_registry.
//
// Integration endpoints are DATA, not constants: any code that needs to call an
// automation looks its URL up here by key, so the URL can be rotated or repointed
// at a staging workflow with no code change. The automation_registry table already
// exists in production (org-scoped, with a live `opportunity_engine` row carrying
// the real GitHub Actions webhook_url); this module just reads it. It isn't in the generated
// Database types, so — like the rest of the OS's newer tables — it is reached
// through the app's cast shim.

type Shim = { from: (t: string) => any };

export interface AutomationEntry {
  key: string;
  name: string | null;
  webhook_url: string | null;
  enabled: boolean;
}

// Look up one automation by key (RLS scopes the read to the caller's org). Returns
// null when there is no row for the key. The caller decides what a missing /
// disabled / placeholder entry means for the UI — this only reads. Selects only
// the columns we need so it stays decoupled from the registry's wider shape.
export async function getAutomation(db: Shim, key: string): Promise<AutomationEntry | null> {
  const { data } = await db
    .from("automation_registry")
    .select("key, name, webhook_url, enabled")
    .eq("key", key)
    .maybeSingle();
  const row = data as AutomationEntry | null;
  return row ?? null;
}

// The reasons an automation can't be called, so the UI can say exactly what to
// fix instead of a generic error.
export type AutomationReadiness =
  | { ready: true; url: string; entry: AutomationEntry }
  | { ready: false; reason: "missing" | "disabled" | "no_url" | "placeholder" };

// A blank / obvious-placeholder URL shouldn't be treated as configured. We only
// screen for the seed placeholder and empty/non-http values — never a real host.
function isPlaceholderUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (u === "") return true;
  if (u.includes("example.invalid")) return true;
  return !/^https?:\/\//.test(u);
}

// Resolve an automation to a callable URL, or an explicit not-ready reason. This
// is what server actions use before POSTing: it never returns a URL that would
// obviously fail.
export async function resolveAutomationUrl(
  db: Shim,
  key: string
): Promise<AutomationReadiness> {
  const entry = await getAutomation(db, key);
  if (!entry) return { ready: false, reason: "missing" };
  if (!entry.enabled) return { ready: false, reason: "disabled" };
  const url = (entry.webhook_url ?? "").trim();
  if (!url) return { ready: false, reason: "no_url" };
  if (isPlaceholderUrl(url)) return { ready: false, reason: "placeholder" };
  return { ready: true, url, entry };
}
