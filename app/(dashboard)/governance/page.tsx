import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, Card, Badge, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import type { PolicyCategory } from "@/lib/governance/policy";

// Governance — the Policy Registry admin (leadership only). ONE screen to view
// and edit the OS's governance rules as data. Change a threshold or a rule here
// and the consult helper (lib/governance/policy.ts) reads it on the next action,
// so behaviour changes with NO code edit. Every write is leadership-gated by RLS
// and audit-logged by the policy_registry_audit DB trigger (→ action_audit).

type PolicyRow = {
  id: string;
  key: string;
  category: PolicyCategory;
  scope: string | null;
  rule: Record<string, unknown>;
  description: string | null;
  active: boolean;
  updated_at: string;
};

type DbShim = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
  };
};

// Cast shim for the audit writer (action_audit isn't in the generated types).
type AuditShim = { from: (t: string) => any };

// The rulebook categories, in the order they read on the page, with a friendly
// label + badge tone. Mirrors the CHECK constraint on policy_registry.category.
const CATEGORY_LABEL: Record<PolicyCategory, string> = {
  spend: "Spend / Money",
  approval: "Approval",
  tool_permission: "Tool permissions",
  data_access: "Data access",
  escalation: "Escalation",
  confidence: "Confidence",
  audit: "Audit",
  compliance: "Compliance",
};
const CATEGORY_ORDER: PolicyCategory[] = [
  "spend",
  "approval",
  "tool_permission",
  "data_access",
  "escalation",
  "confidence",
  "audit",
  "compliance",
];
const CATEGORY_TONE: Record<PolicyCategory, BadgeTone> = {
  spend: "amber",
  approval: "violet",
  tool_permission: "red",
  data_access: "teal",
  escalation: "amber",
  confidence: "violet",
  audit: "muted",
  compliance: "muted",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
}

// Save an edited policy. Leadership only — RLS on policy_registry re-checks this,
// and the DB trigger writes the change to action_audit. The rule JSON is
// validated here so a malformed edit is rejected before it reaches the table.
async function updatePolicy(formData: FormData) {
  "use server";
  const profile = await requireRole(["ceo", "coo"]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const description = String(formData.get("description") ?? "").trim();
  const active = formData.get("active") === "on";
  const ruleRaw = String(formData.get("rule") ?? "").trim();

  let rule: Record<string, unknown>;
  try {
    const parsed = JSON.parse(ruleRaw || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // A rule must be a JSON object — reject anything else without writing.
      return;
    }
    rule = parsed as Record<string, unknown>;
  } catch {
    // Invalid JSON — refuse the edit rather than corrupt the rulebook.
    return;
  }

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("policy_registry")
    .update({
      description: description || null,
      active,
      rule,
    })
    .eq("id", id);

  // Audit the policy change on the shared trail as a security event, so the
  // Security Events view surfaces it alongside auth + export events. (The DB
  // trigger also records a detailed policy.created/updated/deleted row; this is
  // the app-side, security-tagged 'policy_change' event with the actor.)
  await writeActionAudit(supabase as unknown as AuditShim, {
    org_id: profile.org_id,
    action_request_id: null,
    event: "policy_change",
    actor_id: profile.id,
    actor_role: profile.role,
    detail: { policy_id: id, active },
  });

  revalidatePath("/governance");
}

export default async function GovernancePage() {
  const profile = await requireRole(["ceo", "coo"]);
  const supabase = createServerSupabaseClient();

  const { data } = await supabase
    .from("policy_registry")
    .select("id, key, category, scope, rule, description, active, updated_at")
    .order("category", { ascending: true })
    .order("key", { ascending: true });
  const policies = (data ?? []) as unknown as PolicyRow[];

  const byCategory = new Map<PolicyCategory, PolicyRow[]>();
  for (const p of policies) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }
  const orderedCategories = [
    ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  const activeCount = policies.filter((p) => p.active).length;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Governance"]} profile={profile}>
      <PageHeader
        title="Governance — Policy Registry"
        subtitle="The OS's governance rules, as data. Agents and consequential actions consult these before acting. Edit a threshold or rule here and behaviour changes with no code change. Every edit is audit-logged."
      />

      <div className="mb-6 flex flex-wrap gap-3">
        <Card className="px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Policies</p>
          <p className="text-lg font-semibold text-ink">{policies.length}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Active</p>
          <p className="text-lg font-semibold text-teal-300">{activeCount}</p>
        </Card>
        <Card className="px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Inactive</p>
          <p className="text-lg font-semibold text-ink-muted">{policies.length - activeCount}</p>
        </Card>
      </div>

      {policies.length === 0 && (
        <Card className="text-sm text-ink-muted">
          No policies yet. Apply the Policy Registry migration to seed the rulebook, then refresh.
        </Card>
      )}

      {orderedCategories.map((category) => (
        <section key={category} className="mb-8">
          <div className="mb-3 flex items-center gap-2">
            <Badge tone={CATEGORY_TONE[category] ?? "muted"}>{CATEGORY_LABEL[category] ?? category}</Badge>
          </div>
          <div className="space-y-4">
            {(byCategory.get(category) ?? []).map((p) => (
              <form
                key={p.id}
                action={updatePolicy}
                className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate"
              >
                <input type="hidden" name="id" value={p.id} />
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm text-ink">{p.key}</p>
                    {p.scope && (
                      <p className="mt-0.5 font-mono text-[11px] text-ink-muted">scope: {p.scope}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone={p.active ? "teal" : "muted"}>{p.active ? "Active" : "Inactive"}</Badge>
                    <span className="font-mono text-[11px] text-ink-muted">edited {fmtDate(p.updated_at)}</span>
                  </div>
                </div>

                <label className="mt-4 block text-xs text-ink-muted">
                  Description
                  <textarea
                    name="description"
                    rows={2}
                    defaultValue={p.description ?? ""}
                    className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                  />
                </label>

                <label className="mt-3 block text-xs text-ink-muted">
                  Rule (JSON) — edit the threshold or rule here
                  <textarea
                    name="rule"
                    rows={6}
                    defaultValue={JSON.stringify(p.rule ?? {}, null, 2)}
                    spellCheck={false}
                    className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 font-mono text-xs text-teal-200"
                  />
                </label>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      name="active"
                      defaultChecked={p.active}
                      className="h-4 w-4 rounded border-charcoal-700 bg-charcoal-950"
                    />
                    Active (deactivating turns the rule off — leadership decision, audit-logged)
                  </label>
                  <button
                    type="submit"
                    className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
                  >
                    Save policy
                  </button>
                </div>
              </form>
            ))}
          </div>
        </section>
      ))}
    </AppShell>
  );
}
