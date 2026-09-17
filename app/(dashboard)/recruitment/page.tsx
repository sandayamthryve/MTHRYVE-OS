import { requireModule } from "@/lib/auth/session";
import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, Card, PageHeader, SectionCard, StatTile, type BadgeTone } from "@/components/ui";
import { requireProfile, requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// Recruitment — the hiring board. The open-roles list is org-readable, so every
// role sees vacancies; the candidate pipeline is sensitive, so it renders only
// for leadership + department heads and every mutation is gated to those roles.
// `vacancies` and `candidates` aren't in the generated types, so writes go
// through the DbShim, matching Finance / Payroll / Attendance.

type VacStatus = "open" | "on_hold" | "filled" | "closed";
const VAC_STATUSES: VacStatus[] = ["open", "on_hold", "filled", "closed"];
const VAC_LABELS: Record<VacStatus, string> = {
  open: "Open",
  on_hold: "On hold",
  filled: "Filled",
  closed: "Closed",
};
const VAC_TONES: Record<VacStatus, BadgeTone> = {
  open: "teal",
  on_hold: "amber",
  filled: "violet",
  closed: "muted",
};

type Stage = "applied" | "screening" | "interview" | "offer" | "hired" | "rejected";
const STAGES: Stage[] = ["applied", "screening", "interview", "offer", "hired", "rejected"];
const STAGE_LABELS: Record<Stage, string> = {
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
};
const STAGE_TONES: Record<Stage, BadgeTone> = {
  applied: "muted",
  screening: "violet",
  interview: "amber",
  offer: "teal",
  hired: "teal",
  rejected: "red",
};

type Vacancy = {
  id: string;
  title: string;
  department_id: string | null;
  headcount: number | null;
  status: string;
  description: string | null;
  archived_at: string | null;
};
type Candidate = {
  id: string;
  vacancy_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  stage: string;
  notes: string | null;
  archived_at: string | null;
};
type Dept = { id: string; name: string };

type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<unknown>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

function num(v: FormDataEntryValue | null): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isVacStatus(s: string): s is VacStatus {
  return (VAC_STATUSES as string[]).includes(s);
}
function isStage(s: string): s is Stage {
  return (STAGES as string[]).includes(s);
}

// --- Server actions --------------------------------------------------------

async function saveVacancy(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as {
    id: string;
    org_id: string;
  };
  const id = String(formData.get("id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const department_id = String(formData.get("department_id") ?? "") || null;
  const headcount = Math.max(1, Math.round(num(formData.get("headcount"))) || 1);
  const rawStatus = String(formData.get("status") ?? "open");
  const status: VacStatus = isVacStatus(rawStatus) ? rawStatus : "open";
  const description = String(formData.get("description") ?? "").trim() || null;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  if (id) {
    await db
      .from("vacancies")
      .update({
        title,
        department_id,
        headcount,
        status,
        description,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
  } else {
    await db.from("vacancies").insert({
      org_id: profile.org_id,
      created_by: profile.id,
      title,
      department_id,
      headcount,
      status,
      description,
    });
  }
  revalidatePath("/recruitment");
}

async function saveCandidate(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as {
    id: string;
    org_id: string;
  };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const email = String(formData.get("email") ?? "").trim() || null;
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const vacancy_id = String(formData.get("vacancy_id") ?? "") || null;
  const rawStage = String(formData.get("stage") ?? "applied");
  const stage: Stage = isStage(rawStage) ? rawStage : "applied";
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("candidates").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    vacancy_id,
    name,
    email,
    phone,
    stage,
    notes,
  });
  revalidatePath("/recruitment");
}

async function updateCandidateStage(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head"]);
  const id = String(formData.get("id") ?? "");
  const rawStage = String(formData.get("stage") ?? "");
  if (!id || !isStage(rawStage)) return;

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("candidates")
    .update({ stage: rawStage, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/recruitment");
}

// --- Page ------------------------------------------------------------------

export default async function RecruitmentPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const profile = await requireModule("/recruitment");
  const canManage =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const archived = searchParams?.archived === "1";

  const supabase = createServerSupabaseClient();

  // One archived flag flips both the vacancies board and the candidate pipeline.
  const vacBase = supabase
    .from("vacancies")
    .select("id, title, department_id, headcount, status, description, archived_at");
  const vacFiltered = archived
    ? vacBase.not("archived_at", "is", null)
    : vacBase.is("archived_at", null);
  const candBase = supabase
    .from("candidates")
    .select("id, vacancy_id, name, email, phone, stage, notes, archived_at");
  const candFiltered = archived
    ? candBase.not("archived_at", "is", null)
    : candBase.is("archived_at", null);

  const [vacRes, deptRes, candRes] = await Promise.all([
    vacFiltered.order("created_at", { ascending: false }),
    supabase.from("departments").select("id, name").order("name"),
    // Candidates are sensitive; only fetch them for roles that can see the pipeline.
    canManage
      ? candFiltered.order("created_at", { ascending: false })
      : Promise.resolve({ data: null }),
  ]);

  const vacancies = (vacRes.data ?? []) as unknown as Vacancy[];
  const departments = (deptRes.data ?? []) as unknown as Dept[];
  const candidates = (candRes.data ?? []) as unknown as Candidate[];

  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const vacTitle = new Map(vacancies.map((v) => [v.id, v.title]));

  const openVacancies = vacancies.filter((v) => v.status === "open");
  const openHeadcount = openVacancies.reduce((a, v) => a + Number(v.headcount ?? 0), 0);
  const inPipeline = candidates.filter(
    (c) => c.stage !== "hired" && c.stage !== "rejected"
  ).length;
  const hiredCount = candidates.filter((c) => c.stage === "hired").length;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Recruitment"]} profile={profile}>
      <PageHeader
        title="Recruitment"
        subtitle="Open roles are visible to everyone; the candidate pipeline is for leadership and department heads."
      />

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open vacancies" value={openVacancies.length} />
        <StatTile label="Open headcount" value={openHeadcount} hint="seats across open roles" />
        {canManage ? (
          <>
            <StatTile label="In pipeline" value={inPipeline} hint="not hired or rejected" />
            <StatTile label="Hired" value={hiredCount} />
          </>
        ) : (
          <StatTile label="Roles posted" value={vacancies.length} className="col-span-2" />
        )}
      </div>

      {/* Vacancy add form — leadership + department heads. */}
      {canManage && (
        <SectionCard title="Add a role" className="mb-6">
          <form action={saveVacancy} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-[11px] text-ink-muted lg:col-span-1">
              Title
              <input
                name="title"
                required
                placeholder="e.g. Performance Marketing Lead"
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
              />
            </label>
            <label className="text-[11px] text-ink-muted">
              Department
              <select
                name="department_id"
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
              >
                <option value="">— None —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-muted">
              Headcount
              <input
                name="headcount"
                type="number"
                min={1}
                defaultValue={1}
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
              />
            </label>
            <label className="text-[11px] text-ink-muted">
              Status
              <select
                name="status"
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
              >
                {VAC_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {VAC_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-muted sm:col-span-2 lg:col-span-2">
              Description
              <input
                name="description"
                placeholder="Scope, must-haves, notes"
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-2 sm:w-auto sm:justify-self-start lg:col-span-3"
            >
              Add role
            </button>
          </form>
        </SectionCard>
      )}

      {/* Open Roles board — all roles. */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">
          {archived ? "Archived roles" : "Open Roles"}
        </h2>
        <ArchivedToggle basePath="/recruitment" archived={archived} />
      </div>
      {vacancies.length === 0 ? (
        <Card className="mb-8">
          <p className="text-sm text-ink-muted">No roles posted yet.</p>
        </Card>
      ) : (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {vacancies.map((v) => {
            const status: VacStatus = isVacStatus(v.status) ? v.status : "open";
            return (
              <Card key={v.id}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">{v.title}</h3>
                  <Badge tone={VAC_TONES[status]}>{VAC_LABELS[status]}</Badge>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <span>{v.department_id ? deptName.get(v.department_id) ?? "—" : "No department"}</span>
                  <span aria-hidden>·</span>
                  <span>
                    {Number(v.headcount ?? 0)} {Number(v.headcount ?? 0) === 1 ? "seat" : "seats"}
                  </span>
                </div>
                {v.description && (
                  <p className="mt-3 text-sm text-ink-muted">{v.description}</p>
                )}

                {canManage && (
                  <form
                    action={saveVacancy}
                    className="mt-4 grid gap-2 border-t border-charcoal-700/60 pt-3 sm:grid-cols-2"
                  >
                    <input type="hidden" name="id" value={v.id} />
                    <label className="text-[11px] text-ink-muted sm:col-span-2">
                      Title
                      <input
                        name="title"
                        defaultValue={v.title}
                        className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                      />
                    </label>
                    <label className="text-[11px] text-ink-muted">
                      Department
                      <select
                        name="department_id"
                        defaultValue={v.department_id ?? ""}
                        className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                      >
                        <option value="">— None —</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] text-ink-muted">
                      Headcount
                      <input
                        name="headcount"
                        type="number"
                        min={1}
                        defaultValue={Number(v.headcount ?? 1)}
                        className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                      />
                    </label>
                    <label className="text-[11px] text-ink-muted">
                      Status
                      <select
                        name="status"
                        defaultValue={status}
                        className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                      >
                        {VAC_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {VAC_LABELS[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] text-ink-muted">
                      Description
                      <input
                        name="description"
                        defaultValue={v.description ?? ""}
                        className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                      />
                    </label>
                    <button
                      type="submit"
                      className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 sm:col-span-2 sm:w-auto sm:justify-self-start"
                    >
                      Save changes
                    </button>
                  </form>
                )}

                {canManage && (
                  <div className="mt-3 border-t border-charcoal-700/60 pt-3">
                    <RowActions {...rowActionProps("vacancies", v as unknown as Record<string, unknown>, profile)} />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Candidate Pipeline — leadership + department heads only. */}
      {canManage && (
        <>
          <h2 className="mb-3 text-sm font-semibold text-ink">Candidate Pipeline</h2>

          <SectionCard title="Add a candidate" className="mb-6">
            <form action={saveCandidate} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="text-[11px] text-ink-muted">
                Name
                <input
                  name="name"
                  required
                  placeholder="Full name"
                  className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                />
              </label>
              <label className="text-[11px] text-ink-muted">
                Email
                <input
                  name="email"
                  type="email"
                  placeholder="name@email.com"
                  className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                />
              </label>
              <label className="text-[11px] text-ink-muted">
                Phone
                <input
                  name="phone"
                  placeholder="+63…"
                  className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                />
              </label>
              <label className="text-[11px] text-ink-muted">
                Vacancy
                <select
                  name="vacancy_id"
                  className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                >
                  <option value="">— Unassigned —</option>
                  {vacancies.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-ink-muted">
                Stage
                <select
                  name="stage"
                  className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                >
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-ink-muted">
                Notes
                <input
                  name="notes"
                  placeholder="Source, impressions, next step"
                  className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
                />
              </label>
              <button
                type="submit"
                className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-2 sm:w-auto sm:justify-self-start lg:col-span-3"
              >
                Add candidate
              </button>
            </form>
          </SectionCard>

          <div className="grid gap-3 overflow-x-auto lg:grid-cols-6">
            {STAGES.map((stage) => {
              const inStage = candidates.filter((c) => c.stage === stage);
              return (
                <div
                  key={stage}
                  className="flex min-w-[220px] flex-col rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-3"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>
                    <span className="font-mono text-xs text-ink-dim">{inStage.length}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {inStage.length === 0 && (
                      <p className="text-xs text-ink-dim">No candidates.</p>
                    )}
                    {inStage.map((c) => (
                      <div
                        key={c.id}
                        className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3"
                      >
                        <p className="text-sm font-medium text-ink">{c.name}</p>
                        {(c.email || c.phone) && (
                          <p className="mt-0.5 text-xs text-ink-muted">
                            {[c.email, c.phone].filter(Boolean).join(" · ")}
                          </p>
                        )}
                        {c.vacancy_id && (
                          <p className="mt-1 text-xs text-ink-dim">
                            {vacTitle.get(c.vacancy_id) ?? "—"}
                          </p>
                        )}
                        {c.notes && <p className="mt-2 text-xs text-ink-muted">{c.notes}</p>}
                        <form action={updateCandidateStage} className="mt-3 flex items-center gap-1.5">
                          <input type="hidden" name="id" value={c.id} />
                          <select
                            name="stage"
                            defaultValue={c.stage}
                            className="w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                          >
                            {STAGES.map((s) => (
                              <option key={s} value={s}>
                                {STAGE_LABELS[s]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700"
                          >
                            Move
                          </button>
                        </form>
                        <div className="mt-2">
                          <RowActions {...rowActionProps("candidates", c as unknown as Record<string, unknown>, profile)} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </AppShell>
  );
}
