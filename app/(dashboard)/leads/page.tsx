import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { LeadsCsvButton } from "./LeadsCsvButton";
import { ImportLeadsControl, type ImportLeadsState } from "./ImportLeadsControl";
import { AddLeadForm } from "./AddLeadForm";
import { LEAD_IMPORT_FIELDS } from "@/lib/snapfill/schema";
import { parseImportFile, parseImportText, isImportError } from "@/lib/snapfill/import";
import { FindOpportunitiesPanel } from "@/components/leads/FindOpportunitiesPanel";
import { findOpportunities } from "./find-opportunities";
import { OutreachBridge } from "@/components/outreach/bridge/OutreachBridge";

type Lead = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  department: string | null;
  stage: string;
  value: number | null;
  notes: string | null;
  created_at: string;
};

const STAGES = ["new", "contacted", "in_conversation", "qualified", "proposal", "won", "lost"] as const;
const STAGE_LABEL: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  in_conversation: "In conversation",
  qualified: "Qualified",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<unknown>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

async function createLead(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const supabase = createServerSupabaseClient();
  // Honest nulls: a blank field is stored as null (unknown), never a fabricated
  // 0 / "". A blank estimated value stays null rather than a fake 0.
  const rawValue = String(formData.get("value") ?? "").trim();
  const value = rawValue === "" ? null : Number(rawValue);
  await (supabase as unknown as DbShim).from("leads").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    owner_id: profile.id,
    name,
    company: String(formData.get("company") ?? "") || null,
    email: String(formData.get("email") ?? "") || null,
    phone: String(formData.get("phone") ?? "") || null,
    source: String(formData.get("source") ?? "") || null,
    department: String(formData.get("department") ?? "") || null,
    value: value != null && Number.isFinite(value) ? value : null,
    notes: String(formData.get("notes") ?? "") || null,
    stage: "new",
  });
  revalidatePath("/leads");
}

// Bulk-import leads from a CSV or XLSX. Both formats go through the ONE shared
// server-side parser (lib/snapfill/import) with the same header→field-whitelist
// mapping as the drag/paste + photo fill — so a .csv and an .xlsx of the same list
// import identically. Every cell is DATA (a formula cell imports its cached computed
// value, never the formula; macros are ignored; Excel serial dates become real
// dates). Each valid row (one with a name) INSERTs a new lead owned by the importer;
// org/user columns are stamped from the session. Honest nulls throughout. Shaped for
// useFormState.
async function importLeads(
  _prev: ImportLeadsState,
  formData: FormData
): Promise<ImportLeadsState> {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };

  // Prefer an uploaded file (.csv / .xlsx); fall back to the pasted textarea.
  const file = formData.get("file");
  const parsed =
    file instanceof File && file.size > 0
      ? await parseImportFile(file, LEAD_IMPORT_FIELDS)
      : parseImportText(String(formData.get("csv") ?? ""), LEAD_IMPORT_FIELDS);

  if (isImportError(parsed)) return { imported: 0, skipped: [parsed.error] };

  const skipped: string[] = [];
  if (parsed.truncated) {
    skipped.push(`Only the first ${parsed.records.length} rows were imported (file exceeded the row cap).`);
  }
  for (const h of parsed.ignoredHeaders) skipped.push(`ignored column "${h}"`);

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  let imported = 0;
  for (const r of parsed.records) {
    // A lead needs a name; a row without one is reported, never invented.
    if (!r.name) {
      skipped.push("row missing name");
      continue;
    }
    const value = r.value != null ? Number(r.value) : null;
    await db.from("leads").insert({
      org_id: profile.org_id,
      created_by: profile.id,
      owner_id: profile.id,
      name: r.name,
      company: r.company ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      source: r.source ?? null,
      department: r.department ?? null,
      stage: r.stage || "new",
      value: value != null && Number.isFinite(value) ? value : null,
      notes: r.notes ?? null,
    });
    imported += 1;
  }
  revalidatePath("/leads");
  return { imported, skipped };
}

async function updateStage(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const id = String(formData.get("id") ?? "");
  const stage = String(formData.get("stage") ?? "new");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("leads")
    .update({ stage, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/leads");
}

function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

export default async function LeadsPage() {
  const profile = await requireModule("/leads");
  const supabase = createServerSupabaseClient();
  const res = await supabase
    .from("leads")
    .select("id, name, company, email, phone, source, department, stage, value, notes, created_at")
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  const leads = (res.data ?? []) as unknown as Lead[];

  // CSV export rows: every org lead (RLS-scoped). Columns are fixed by the leads
  // export spec; nulls export as empty cells, never fabricated values.
  const exportRows = leads.map((l) => ({
    name: l.name,
    company: l.company ?? "",
    email: l.email ?? "",
    phone: l.phone ?? "",
    source: l.source ?? "",
    department: l.department ?? "",
    stage: l.stage,
    value: l.value != null ? String(l.value) : "",
    notes: l.notes ?? "",
  }));

  const byStage = (s: string) => leads.filter((l) => l.stage === s);
  const stageValue = (s: string) => byStage(s).reduce((a, l) => a + Number(l.value ?? 0), 0);
  const openValue = leads
    .filter((l) => l.stage !== "won" && l.stage !== "lost")
    .reduce((a, l) => a + Number(l.value ?? 0), 0);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Leads / CRM"]} profile={profile}>
      <PageHeader
        title="Leads / CRM"
        subtitle="Track leads from first contact to close — for Affiliate, Business Development, and beyond."
        action={<LeadsCsvButton rows={exportRows} filename="leads.csv" />}
      />

      <div className="mb-4 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {STAGES.map((s) => (
          <StatTile key={s} label={STAGE_LABEL[s]} value={byStage(s).length} hint={peso(stageValue(s))} />
        ))}
      </div>
      <p className="mb-6 text-sm text-ink-muted">
        Open pipeline value: <span className="font-semibold text-teal-300">{peso(openValue)}</span>
      </p>

      <AddLeadForm action={createLead} />

      {/* Lean Outreach Bridge — draft → approve → export a Gmail-merge CSV →
          import results. Gated to Business Development (+ head + leadership);
          renders nothing for anyone else. */}
      <OutreachBridge
        recipientType="lead"
        profile={profile}
        supabase={supabase as unknown as { from: (t: string) => unknown }}
      />

      <SectionCard title="Find Opportunities" className="mb-6">
        <p className="mb-3 text-xs text-ink-muted">
          Rank a list of prospects with the Opportunity Engine — no paid lead source needed. Paste or
          upload a list, set optional criteria, and the engine scores each prospect. HOT ones are
          staged as pending actions for your approval; nothing reaches a prospect.
        </p>
        <FindOpportunitiesPanel action={findOpportunities} />
      </SectionCard>

      <SectionCard title="Import Leads (CSV)" className="mb-6">
        <p className="mb-3 text-xs text-ink-muted">
          Bulk-add leads from a spreadsheet. Each valid row inserts a new lead. Rows missing a name
          are skipped and reported — nothing is fabricated.
        </p>
        <ImportLeadsControl action={importLeads} />
      </SectionCard>

      <TableShell columns={["Lead", "Source", "Dept", "Value", "Stage"]}>
        {leads.length === 0 && (
          <tr>
            <td colSpan={5} className="p-4 text-ink-muted">No leads yet — add your first above.</td>
          </tr>
        )}
        {leads.map((l) => (
              <tr key={l.id} className={rowClass}>
                <td className="p-3">
                  <span className="text-ink">{l.name}</span>
                  {l.company ? <span className="text-ink-muted"> · {l.company}</span> : ""}
                </td>
                <td className="p-3 text-ink-muted">{l.source ?? "—"}</td>
                <td className="p-3 text-ink-muted">{l.department ?? "—"}</td>
                <td className="p-3 font-mono text-ink">{peso(Number(l.value ?? 0))}</td>
                <td className="p-3">
                  <form action={updateStage} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={l.id} />
                    <select name="stage" defaultValue={l.stage} className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink">
                      {STAGES.map((s) => (
                        <option key={s} value={s}>{STAGE_LABEL[s]}</option>
                      ))}
                    </select>
                    <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700">Save</button>
                  </form>
                </td>
              </tr>
            ))}
      </TableShell>
    </AppShell>
  );
}
