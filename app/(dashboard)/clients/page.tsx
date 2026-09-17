import Link from "next/link";
import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/layout/AppShell";
import {
  PageHeader,
  SectionCard,
  StatTile,
  Badge,
  type BadgeTone,
} from "@/components/ui";
import { requireProfile, isClientOwner, type SessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ClientsCsvButton } from "./ClientsCsvButton";
import { AddClientForm, type AddClientState } from "./AddClientForm";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// ── Business Development — Clients (the OWNER lens) ──────────────────────────
// This is the single place client RELATIONSHIP facts are created and edited:
// legal/company name, contacts, account tier, onboarding status, category,
// platform focus and lifecycle status all live on the canonical `brands` record
// and are written only here. Contract terms & commercials live in linked
// contract records (Client Delivery) and are reached by deep-link — never
// copied. Commerce Ops reads this record read-only (see /brands).
//
// Write access mirrors the brands RLS from migration 0025 exactly: leadership
// (ceo/coo/department_head) OR any member whose team_assignment is Business
// Development. Everyone else sees this page read-only.

export const dynamic = "force-dynamic";

type Client = {
  id: string;
  name: string;
  legal_name: string | null;
  category: string | null;
  account_tier: string | null;
  onboarding_status: string;
  status: string;
  gmv_share: number | null;
  platform_focus: string[] | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone: string | null;
  created_at: string;
  archived_at: string | null;
};

type ContractLite = {
  id: string;
  brand_id: string | null;
  status: string;
  period_start: string | null;
  period_end: string | null;
  monthly_gmv_target: number | null;
};

const PLATFORMS = [
  { value: "tiktok", label: "TikTok Shop" },
  { value: "shopee", label: "Shopee" },
  { value: "lazada", label: "Lazada" },
] as const;
const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok Shop",
  shopee: "Shopee",
  lazada: "Lazada",
};

// Lifecycle status of the engagement (existing `status` column).
const STATUSES = ["active", "paused", "archived"] as const;
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};
const STATUS_TONE: Record<string, BadgeTone> = {
  active: "teal",
  paused: "amber",
  archived: "muted",
};

// Onboarding lifecycle (relationship fact owned here).
const ONBOARDING = ["prospect", "onboarding", "active", "at_risk", "offboarded"] as const;
const ONBOARDING_LABEL: Record<string, string> = {
  prospect: "Prospect",
  onboarding: "Onboarding",
  active: "Active",
  at_risk: "At risk",
  offboarded: "Offboarded",
};
const ONBOARDING_TONE: Record<string, BadgeTone> = {
  prospect: "violet",
  onboarding: "amber",
  active: "teal",
  at_risk: "amber",
  offboarded: "muted",
};

// Account tier (relationship fact owned here).
const TIERS = ["strategic", "growth", "standard"] as const;
const TIER_LABEL: Record<string, string> = {
  strategic: "Strategic",
  growth: "Growth",
  standard: "Standard",
};

const fieldCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

// A delete filter is awaitable and chainable — matches the shim used elsewhere.
interface DeleteFilter extends Promise<{ error: unknown }> {
  eq: (c: string, val: string) => DeleteFilter;
}
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<unknown>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
    delete: () => DeleteFilter;
  };
};

// Every mutation re-checks ownership server-side (isClientOwner === the brands
// RLS predicate) before touching the row. RLS is the true backstop; this gives a
// clean redirect for anyone who isn't an owner instead of a silent RLS reject.
async function requireOwner() {
  const profile = await requireProfile();
  if (!isClientOwner(profile)) {
    const { redirect } = await import("next/navigation");
    redirect("/brands");
  }
  return profile;
}

// Parse an optional numeric field: blank stays null (unknown), never 0.
function optNum(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Collect the relationship fields shared by create + update. Blank text → null so
// an empty field reads as "unknown", not an empty string.
function relationshipFields(formData: FormData) {
  const txt = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v || null;
  };
  const platform_focus = PLATFORMS.map((p) => p.value).filter(
    (v) => formData.get(`platform_${v}`) === "on"
  );
  return {
    name: String(formData.get("name") ?? "").trim(),
    legal_name: txt("legal_name"),
    category: txt("category"),
    account_tier: txt("account_tier"),
    onboarding_status: String(formData.get("onboarding_status") ?? "").trim() || "active",
    status: String(formData.get("status") ?? "active").trim() || "active",
    gmv_share: optNum(formData, "gmv_share"),
    platform_focus,
    primary_contact_name: txt("primary_contact_name"),
    primary_contact_email: txt("primary_contact_email"),
    primary_contact_phone: txt("primary_contact_phone"),
  };
}

// The ONLY path that INSERTs a brand. Before inserting it blocks a second active
// (non-archived) brand with the same normalized name in the org — that is how the
// duplicate "BodegaTrends" was born and must never happen again. The DB partial
// unique index (brands_org_active_name_uniq) is the last-line backstop; this
// gives a clear inline message instead of an opaque constraint error. Editing an
// existing client goes through updateClient (UPDATE by id) and never reaches here.
async function createClient(
  _prev: AddClientState,
  formData: FormData
): Promise<AddClientState> {
  "use server";
  const profile = await requireOwner();
  const fields = relationshipFields(formData);
  if (!fields.name) return { error: "Display name is required." };
  const supabase = createServerSupabaseClient();

  // Duplicate guard: normalized-name match against active brands in this org.
  // "Active" == not archived, matching the partial unique index's predicate.
  const normalized = fields.name.trim().toLowerCase();
  const { data: existing } = await supabase
    .from("brands")
    .select("id, name, status")
    .eq("org_id", profile.org_id)
    .neq("status", "archived");
  const dup = ((existing ?? []) as { name: string | null }[]).find(
    (r) => (r.name ?? "").trim().toLowerCase() === normalized
  );
  if (dup) {
    return {
      error: `A client named "${fields.name}" already exists — open it to edit instead of adding a new one.`,
    };
  }

  const { error } = (await (supabase as unknown as DbShim).from("brands").insert({
    org_id: profile.org_id,
    ...fields,
  })) as { error: unknown };
  if (error) {
    // Backstop: the unique index rejected a race that slipped past the check above.
    return {
      error: `A client named "${fields.name}" already exists — open it to edit instead of adding a new one.`,
    };
  }
  revalidatePath("/clients");
  revalidatePath("/brands");
  return null;
}

// Saving an edit ALWAYS updates the opened brand by its id — it never inserts.
// The brand id rides the form as a hidden field (see ClientCard); with no id we
// bail out rather than fall through to any create path, so an absent/empty id can
// never silently mint a duplicate. There is deliberately no upsert here: upsert
// with a missing/mismatched conflict key is exactly what would branch to INSERT.
async function updateClient(formData: FormData) {
  "use server";
  await requireOwner();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return; // no id → do nothing; never insert.
  const fields = relationshipFields(formData);
  if (!fields.name) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("brands")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/clients");
  revalidatePath("/brands");
}

// NOTE: the bespoke one-click client delete (deleteClient / DeleteClientButton)
// was removed in the delete-sweep. A brand is a top-level record whose removal is
// a data-loss act, so BOTH of its former delete surfaces — this button AND the
// RowActions("brands") control in the card header — now route through the governed
// 2-approval gate (entity 'brand', COO → CEO, audited). The header's "Request
// deletion" is the single permanent-delete path; nothing here hard-deletes.

function fmtDateRange(a: string | null, b: string | null): string {
  if (!a && !b) return "";
  return `${a ?? "…"} → ${b ?? "…"}`;
}

// One client's editable relationship card. Owners get inputs; everyone else gets
// the same facts read-only (though non-owners never reach this page — the nav
// only shows it under Business Development and requireOwner guards mutations).
function ClientCard({
  client,
  contracts,
  canEdit,
  profile,
}: {
  client: Client;
  contracts: ContractLite[];
  canEdit: boolean;
  profile: SessionProfile;
}) {
  const linked = contracts.filter((c) => c.brand_id === client.id);
  return (
    <SectionCard
      title={client.name}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={ONBOARDING_TONE[client.onboarding_status] ?? "muted"}>
            {ONBOARDING_LABEL[client.onboarding_status] ?? client.onboarding_status}
          </Badge>
          {client.account_tier && (
            <Badge tone="violet">{TIER_LABEL[client.account_tier] ?? client.account_tier}</Badge>
          )}
          <Badge tone={STATUS_TONE[client.status] ?? "teal"}>
            {STATUS_LABEL[client.status] ?? client.status}
          </Badge>
          <RowActions {...rowActionProps("brands", client as unknown as Record<string, unknown>, profile)} />
        </div>
      }
    >
      {canEdit ? (
        <form action={updateClient} className="space-y-4">
          <input type="hidden" name="id" value={client.id} />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] text-ink-muted">
              Display name
              <input name="name" required defaultValue={client.name} className={`${fieldCls} mt-1 w-full`} />
            </label>
            <label className="text-[11px] text-ink-muted">
              Legal / company name
              <input name="legal_name" defaultValue={client.legal_name ?? ""} placeholder="Registered legal name" className={`${fieldCls} mt-1 w-full`} />
            </label>
            <label className="text-[11px] text-ink-muted">
              Category
              <input name="category" defaultValue={client.category ?? ""} placeholder="e.g. Apparel, Home" className={`${fieldCls} mt-1 w-full`} />
            </label>
            <label className="text-[11px] text-ink-muted">
              GMV share %
              <input name="gmv_share" type="number" step="any" defaultValue={client.gmv_share ?? ""} placeholder="optional" className={`${fieldCls} mt-1 w-full`} />
            </label>
            <label className="text-[11px] text-ink-muted">
              Account tier
              <select name="account_tier" defaultValue={client.account_tier ?? ""} className={`${fieldCls} mt-1 w-full`}>
                <option value="">— none —</option>
                {TIERS.map((t) => (
                  <option key={t} value={t}>{TIER_LABEL[t]}</option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-muted">
              Onboarding status
              <select name="onboarding_status" defaultValue={client.onboarding_status} className={`${fieldCls} mt-1 w-full`}>
                {ONBOARDING.map((s) => (
                  <option key={s} value={s}>{ONBOARDING_LABEL[s]}</option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-muted">
              Lifecycle status
              <select name="status" defaultValue={client.status} className={`${fieldCls} mt-1 w-full`}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            </label>
          </div>

          <div>
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Primary contact</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <input name="primary_contact_name" defaultValue={client.primary_contact_name ?? ""} placeholder="Contact name" className={fieldCls} />
              <input name="primary_contact_email" type="email" defaultValue={client.primary_contact_email ?? ""} placeholder="Email" className={fieldCls} />
              <input name="primary_contact_phone" defaultValue={client.primary_contact_phone ?? ""} placeholder="Phone" className={fieldCls} />
            </div>
          </div>

          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Platform focus</p>
            <div className="flex flex-wrap gap-4">
              {PLATFORMS.map((p) => (
                <label key={p.value} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    name={`platform_${p.value}`}
                    defaultChecked={(client.platform_focus ?? []).includes(p.value)}
                    className="h-4 w-4 rounded border-charcoal-700 bg-charcoal-950 text-teal-500"
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-charcoal-700/60 pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
                Save changes
              </button>
            </div>
            <Link href={`/brands?brand=${client.id}`} className="text-xs text-teal-400 hover:text-teal-300">
              Open in Commerce Ops →
            </Link>
          </div>
        </form>
      ) : (
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-[11px] text-ink-muted">Legal / company name</dt><dd className="text-ink">{client.legal_name ?? "—"}</dd></div>
          <div><dt className="text-[11px] text-ink-muted">Category</dt><dd className="text-ink">{client.category ?? "—"}</dd></div>
          <div><dt className="text-[11px] text-ink-muted">Primary contact</dt><dd className="text-ink">{client.primary_contact_name ?? "—"}</dd></div>
          <div><dt className="text-[11px] text-ink-muted">Contact email</dt><dd className="text-ink">{client.primary_contact_email ?? "—"}</dd></div>
        </dl>
      )}

      {/* Contract terms & commercials live in linked contract records — reached
          by deep-link, never duplicated here. */}
      <div className="mt-5 border-t border-charcoal-700/60 pt-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Contract terms & commercials
          </p>
          <Link href="/contracts" className="text-xs text-teal-400 hover:text-teal-300">
            Manage in Client Delivery →
          </Link>
        </div>
        {linked.length === 0 ? (
          <p className="text-xs text-ink-muted">No contracts linked to this client yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {linked.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                <Badge tone={c.status === "active" ? "teal" : "muted"}>{c.status}</Badge>
                {fmtDateRange(c.period_start, c.period_end) && (
                  <span className="font-mono">{fmtDateRange(c.period_start, c.period_end)}</span>
                )}
                {c.monthly_gmv_target != null && (
                  <span>Monthly GMV target {new Intl.NumberFormat("en-US").format(Number(c.monthly_gmv_target))}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}

export default async function ClientsOwnerPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const profile = await requireProfile();
  const canEdit = isClientOwner(profile);
  const supabase = createServerSupabaseClient();
  const archived = searchParams?.archived === "1";

  // Default list hides archived clients; the Archived view shows only them.
  const clientQuery = supabase
    .from("brands")
    .select(
      "id, name, legal_name, category, account_tier, onboarding_status, status, gmv_share, platform_focus, primary_contact_name, primary_contact_email, primary_contact_phone, created_at, archived_at"
    )
    .order("created_at", { ascending: false });

  const [clientRes, contractRes] = await Promise.all([
    archived ? clientQuery.not("archived_at", "is", null) : clientQuery.is("archived_at", null),
    supabase
      .from("client_contracts")
      .select("id, brand_id, status, period_start, period_end, monthly_gmv_target"),
  ]);

  const clients = (clientRes.data ?? []) as unknown as Client[];
  const contracts = (contractRes.data ?? []) as unknown as ContractLite[];

  const countBy = (s: string) => clients.filter((b) => b.onboarding_status === s).length;

  const exportRows = clients.map((b) => ({
    name: b.name,
    legal_name: b.legal_name ?? "",
    category: b.category ?? "",
    account_tier: b.account_tier ?? "",
    onboarding_status: b.onboarding_status,
    status: b.status,
    primary_contact_name: b.primary_contact_name ?? "",
    primary_contact_email: b.primary_contact_email ?? "",
    primary_contact_phone: b.primary_contact_phone ?? "",
    platform_focus: (b.platform_focus ?? []).join("|"),
    gmv_share: b.gmv_share != null ? String(b.gmv_share) : "",
  }));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Business Development", "Clients"]} profile={profile}>
      <PageHeader
        title="Clients — Business Development"
        subtitle="The single source of truth for every client relationship: legal name, contacts, account tier, onboarding status and linked contracts are created and edited here — and read-only everywhere else."
        action={canEdit ? <ClientsCsvButton rows={exportRows} filename="clients.csv" /> : undefined}
      />

      {!canEdit && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
          You have read-only access. Client relationship fields are edited by leadership or the
          Business Development team.
        </div>
      )}

      <div className="mb-6 grid grid-cols-3 gap-3 sm:grid-cols-5">
        {ONBOARDING.map((s) => (
          <StatTile key={s} label={ONBOARDING_LABEL[s]} value={countBy(s)} />
        ))}
      </div>

      <div className="mb-6 flex justify-end">
        <ArchivedToggle basePath="/clients" archived={archived} />
      </div>

      {canEdit && !archived && (
        <AddClientForm
          action={createClient}
          fieldCls={fieldCls}
          platforms={PLATFORMS.map((p) => ({ value: p.value, label: p.label }))}
          tiers={TIERS.map((t) => ({ value: t, label: TIER_LABEL[t] }))}
          onboarding={ONBOARDING.map((s) => ({ value: s, label: ONBOARDING_LABEL[s] }))}
        />
      )}

      {clients.length === 0 ? (
        <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-6 text-sm text-ink-muted shadow-elevate">
          {archived ? "No archived clients." : canEdit ? "No clients yet — add your first above." : "No clients yet."}
        </p>
      ) : (
        <div className="space-y-6">
          {clients.map((c) => (
            <ClientCard key={c.id} client={c} contracts={contracts} canEdit={canEdit} profile={profile} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
