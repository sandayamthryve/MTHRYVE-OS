import { AppShell } from "@/components/layout/AppShell";
import { SectionCard } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { MetricsCsvButton } from "./MetricsCsvButton";
import type { ImportMetricsState } from "./ImportMetricsControl";
import {
  challengeSummaryParts,
  getDepartmentActivity,
  getLatestDepartmentBriefing,
} from "@/lib/departments/activity";
import { ValidationPanel } from "./ValidationPanel";
import { SyncNowControl } from "./SyncNowControl";
import { MetricValue } from "@/components/metrics/MetricValue";
import type { MetricUnit, ReconEntry, ValidationStatus } from "@/lib/metrics/reconciliation";
import { computeDepartmentEfficiency } from "@/lib/metrics/signals";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import {
  MetricsWorkspace,
  type MetricLog,
  type ValidationWorkspaceCard,
} from "./MetricsWorkspace";
import type { BriefHistoryRow } from "./BriefBentoPanel";

type Dept = { id: string; name: string };
type NamedRow = { id: string; name: string };
type Snapshot = {
  id: string;
  department_id: string | null;
  gmv_impact: number | null;
  efficiency: number | null;
  quality_score: number | null;
  capacity_utilization: number | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
  ongoing_tasks: string | null;
  expected_outputs: string | null;
  challenges: string | null;
};

type DbShim = {
  from: (table: string) => {
    insert: (value: Record<string, unknown>) => Promise<unknown>;
    delete: () => { eq: (column: string, value: string) => Promise<unknown> };
  };
};

function isDate(value?: string) {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isNum(value: string) {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

function parseCsvLine(line: string): string[] {
  const output: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      output.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  output.push(current);
  return output;
}

function splitNarrative(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/\n+|(?:^|\s)[•*-]\s+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function recordSnapshot(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as {
    id: string;
    org_id: string;
  };
  const departmentId = String(formData.get("department_id") ?? "");
  const periodStart = String(formData.get("period_start") ?? "");
  const periodEnd = String(formData.get("period_end") ?? "");
  if (!departmentId || !isDate(periodStart) || !isDate(periodEnd)) return;

  const clamp = (value: FormDataEntryValue | null) => {
    const number = Number(value ?? 0);
    if (!Number.isFinite(number)) return 0;
    return Math.min(100, Math.max(0, number));
  };

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("metrics_snapshots").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    department_id: departmentId,
    gmv_impact: Number(formData.get("gmv_impact") ?? 0) || 0,
    quality_score: clamp(formData.get("quality_score")),
    capacity_utilization: clamp(formData.get("capacity_utilization")),
    period_start: periodStart,
    period_end: periodEnd,
  });
  revalidatePath("/metrics");
  revalidatePath("/");
}

async function importMetrics(
  _previous: ImportMetricsState,
  formData: FormData
): Promise<ImportMetricsState> {
  "use server";
  try {
    const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as {
      id: string;
      org_id: string;
    };

    const file = formData.get("file");
    let text = "";
    if (file && typeof file !== "string" && file.size > 0) {
      if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
        return {
          status: "invalid",
          imported: 0,
          skipped: [],
          message: "Unsupported file type. Please select a CSV file.",
        };
      }
      text = await file.text();
    } else {
      text = String(formData.get("csv") ?? "");
    }

    if (!text.trim()) {
      return {
        status: "invalid",
        imported: 0,
        skipped: [],
        message: "Select a CSV file or paste CSV data before importing.",
      };
    }

    const supabase = createServerSupabaseClient();
    const { data: departmentRows } = await supabase
      .from("departments")
      .select("id, name")
      .eq("org_id", profile.org_id);
    const departments = (departmentRows ?? []) as unknown as Dept[];
    const idByName = new Map(
      departments.map((department) => [department.name.trim().toLowerCase(), department.id])
    );

    const skipped: string[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const columns = parseCsvLine(raw);
      const department = (columns[0] ?? "").trim();
      if (department.toLowerCase() === "department") continue;
      if (columns.length < 7) {
        skipped.push(`invalid column count: ${raw.slice(0, 64)}`);
        continue;
      }

      const periodStart = (columns[1] ?? "").trim();
      const periodEnd = (columns[2] ?? "").trim();
      const efficiency = (columns[3] ?? "").trim();
      const quality = (columns[4] ?? "").trim();
      const capacity = (columns[5] ?? "").trim();
      const gmv = (columns[6] ?? "").trim();
      const departmentId = idByName.get(department.toLowerCase());

      if (!departmentId) {
        skipped.push(`unknown department: ${department || "(blank)"}`);
        continue;
      }
      if (
        !isDate(periodStart) ||
        !isDate(periodEnd) ||
        !isNum(efficiency) ||
        !isNum(quality) ||
        !isNum(capacity) ||
        !isNum(gmv)
      ) {
        skipped.push(`invalid row: ${department} ${periodStart || "(no date)"}`);
        continue;
      }

      rows.push({
        org_id: profile.org_id,
        created_by: profile.id,
        department_id: departmentId,
        period_start: periodStart,
        period_end: periodEnd,
        efficiency: Number(efficiency),
        quality_score: Number(quality),
        capacity_utilization: Number(capacity),
        gmv_impact: Number(gmv),
      });
    }

    if (!rows.length) {
      return {
        status: "invalid",
        imported: 0,
        skipped,
        message: "No valid metric rows were found. Nothing was changed.",
      };
    }

    const db = supabase as unknown as DbShim;
    for (const row of rows) {
      await db.from("metrics_snapshots").insert(row);
    }
    revalidatePath("/metrics");
    revalidatePath("/");

    return {
      status: skipped.length ? "invalid" : "success",
      imported: rows.length,
      skipped,
      message: skipped.length
        ? `${rows.length} row${rows.length === 1 ? "" : "s"} imported; ${skipped.length} skipped. Existing records were not overwritten.`
        : `${rows.length} row${rows.length === 1 ? "" : "s"} imported successfully. Existing records were not overwritten.`,
    };
  } catch (error) {
    return {
      status: "failure",
      imported: 0,
      skipped: [],
      message: error instanceof Error ? error.message : "The import could not be completed.",
    };
  }
}

async function deleteMetricSnapshot(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head"]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("metrics_snapshots").delete().eq("id", id);
  revalidatePath("/metrics");
  revalidatePath("/");
}

export default async function MetricsPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const archived = searchParams?.archived === "1";
  const profile = await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const canRecord =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const supabase = createServerSupabaseClient();

  const [departmentResponse, snapshotResponse, allSnapshotResponse, brandResponse, briefResponse] =
    await Promise.all([
      supabase.from("departments").select("id, name").order("name"),
      supabase
        .from("metrics_snapshots")
        .select(
          "id, department_id, gmv_impact, efficiency, quality_score, capacity_utilization, period_start, period_end, created_at, ongoing_tasks, expected_outputs, challenges"
        )
        .not("department_id", "is", null)
        .order("period_end", { ascending: false })
        .limit(80),
      supabase
        .from("metrics_snapshots")
        .select(
          "department_id, gmv_impact, efficiency, quality_score, capacity_utilization, period_start, period_end"
        )
        .not("department_id", "is", null)
        .order("period_end", { ascending: false }),
      supabase.from("brands").select("id, name").order("name"),
      (supabase as unknown as { from: (table: string) => any })
        .from("account_review_briefs")
        .select("id, department, brand_id, period_start, period_end, summary, created_at")
        .order("period_start", { ascending: true })
        .limit(50),
    ]);

  const departments = (departmentResponse.data ?? []) as unknown as Dept[];
  const brands = (brandResponse.data ?? []) as unknown as NamedRow[];
  const briefHistory = (((briefResponse as { data?: unknown }).data ?? []) as BriefHistoryRow[]).sort(
    (a, b) => a.period_start.localeCompare(b.period_start)
  );
  const snapshots = (snapshotResponse.data ?? []) as unknown as Snapshot[];
  const departmentName = (id: string | null) =>
    departments.find((department) => department.id === id)?.name ?? "—";

  const efficiencyByDepartment = await computeDepartmentEfficiency(supabase);

  const latestByDepartment = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.department_id && !latestByDepartment.has(snapshot.department_id)) {
      latestByDepartment.set(snapshot.department_id, snapshot);
    }
  }

  const validationCards: ValidationWorkspaceCard[] = await Promise.all(
    Array.from(latestByDepartment.values()).map(async (snapshot) => {
      const departmentId = snapshot.department_id!;
      const [activity, briefing] = await Promise.all([
        getDepartmentActivity(supabase, departmentId),
        getLatestDepartmentBriefing(supabase, departmentId),
      ]);
      const efficiency = efficiencyByDepartment.get(departmentId) ?? null;
      const expectedOutputs = [
        ...activity.expectedTasks.map((task) =>
          `${task.title}${task.due_date ? ` · due ${task.due_date}` : ""}`
        ),
        ...activity.expectedProjects.map((project) =>
          `${project.name}${project.due_date ? ` · due ${project.due_date}` : ""}`
        ),
        ...splitNarrative(snapshot.expected_outputs),
      ];
      const challenges = [
        ...challengeSummaryParts(activity),
        ...splitNarrative(snapshot.challenges),
        ...splitNarrative(briefing?.challenges_summary),
      ];
      return {
        id: snapshot.id,
        departmentId,
        department: departmentName(departmentId),
        date: snapshot.period_end,
        efficiency: efficiency?.value ?? null,
        efficiencyBasis: efficiency?.basis ?? "No confirmed daily reports yet",
        quality: snapshot.quality_score == null ? null : Number(snapshot.quality_score),
        capacity:
          snapshot.capacity_utilization == null ? null : Number(snapshot.capacity_utilization),
        gmvImpact: snapshot.gmv_impact == null ? null : Number(snapshot.gmv_impact),
        tasks: [
          ...activity.ongoingTasks.map((task) =>
            `${task.title}${task.assigneeName ? ` · ${task.assigneeName}` : ""}`
          ),
          ...splitNarrative(snapshot.ongoing_tasks),
        ],
        expectedOutputs,
        challenges,
        actionPlan: splitNarrative(briefing?.action_plan),
      };
    })
  );

  const logs: MetricLog[] = snapshots.map((snapshot) => ({
    id: snapshot.id,
    department: departmentName(snapshot.department_id),
    periodStart: snapshot.period_start,
    periodEnd: snapshot.period_end,
    quality: snapshot.quality_score == null ? null : Number(snapshot.quality_score),
    capacity:
      snapshot.capacity_utilization == null ? null : Number(snapshot.capacity_utilization),
    gmvImpact: snapshot.gmv_impact == null ? null : Number(snapshot.gmv_impact),
    createdAt: snapshot.created_at,
  }));

  const exportRows = ((allSnapshotResponse.data ?? []) as unknown as Snapshot[]).map((snapshot) => ({
    department: departmentName(snapshot.department_id),
    period_start: snapshot.period_start ?? "",
    period_end: snapshot.period_end ?? "",
    efficiency: Number(snapshot.efficiency ?? 0),
    quality_score: Number(snapshot.quality_score ?? 0),
    capacity_utilization: Number(snapshot.capacity_utilization ?? 0),
    gmv_impact: Number(snapshot.gmv_impact ?? 0),
  }));

  const reconciliationDb = supabase as unknown as { from: (table: string) => any };
  const entryQuery = reconciliationDb
    .from("metric_entries")
    .select(
      "id, metric_key, brand_id, period_start, period_end, manual_value, api_value, variance_pct, validation_status, origin, override_choice, archived_at"
    )
    .order("period_end", { ascending: false })
    .limit(200);
  const [catalogResponse, entryResponse] = await Promise.all([
    reconciliationDb
      .from("metric_catalog")
      .select("metric_key, label, department, unit, is_money"),
    archived ? entryQuery.not("archived_at", "is", null) : entryQuery.is("archived_at", null),
  ]);

  type CatalogRow = {
    metric_key: string;
    label: string;
    department: string | null;
    unit: MetricUnit;
    is_money: boolean;
  };
  const catalogByKey = new Map(
    ((catalogResponse.data ?? []) as CatalogRow[]).map((row) => [row.metric_key, row])
  );
  const toNumber = (value: unknown) => (value == null ? null : Number(value));
  const reconciliationEntries: ReconEntry[] = (
    (entryResponse.data ?? []) as Array<Record<string, unknown>>
  ).map((entry) => {
    const catalog = catalogByKey.get(String(entry.metric_key));
    return {
      id: String(entry.id),
      metric_key: String(entry.metric_key),
      label: catalog?.label ?? String(entry.metric_key),
      department: catalog?.department ?? null,
      unit: (catalog?.unit ?? "number") as MetricUnit,
      is_money: catalog?.is_money ?? false,
      period_start: String(entry.period_start),
      period_end: String(entry.period_end),
      manual_value: toNumber(entry.manual_value),
      api_value: toNumber(entry.api_value),
      variance_pct: toNumber(entry.variance_pct),
      validation_status: entry.validation_status as ValidationStatus,
      origin: entry.origin as ReconEntry["origin"],
      override_choice: (entry.override_choice ?? null) as ReconEntry["override_choice"],
    };
  });
  const rawEntries = (entryResponse.data ?? []) as Array<Record<string, unknown>>;
  const rawEntryById = new Map(rawEntries.map((entry) => [String(entry.id), entry]));
  const mismatches = reconciliationEntries.filter(
    (entry) => entry.validation_status === "mismatch"
  );
  const reconciledRows = reconciliationEntries.filter(
    (entry) => entry.manual_value != null && entry.api_value != null
  );

  const now = new Date();
  const dateString = (date: Date) => date.toISOString().slice(0, 10);
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 6);
  const defaultStart = dateString(weekAgo);
  const defaultEnd = dateString(now);

  const apiTools = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-charcoal-700/60 bg-charcoal-950 p-3">
        <div>
          <p className="text-xs font-semibold text-ink">Reconciliation controls</p>
          <p className="mt-1 text-[11px] text-ink-muted">
            Sync API figures, inspect mismatches, and archive or restore validation entries.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ArchivedToggle basePath="/metrics" archived={archived} />
          {canRecord && (
            <SyncNowControl defaultStart={defaultStart} defaultEnd={defaultEnd} />
          )}
        </div>
      </div>

      {archived ? (
        <SectionCard title="Archived metric entries">
          {rawEntries.length === 0 ? (
            <p className="text-xs text-ink-muted">No archived metric entries.</p>
          ) : (
            <div className="space-y-1.5">
              {rawEntries.map((entry) => (
                <div
                  key={String(entry.id)}
                  className="flex items-center justify-between gap-3 rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-2"
                >
                  <span className="font-mono text-xs text-ink">
                    {String(entry.metric_key)}
                  </span>
                  <RowActions {...rowActionProps("metric_entries", entry, profile)} />
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      ) : (
        <ValidationPanel mismatches={mismatches} canOverride={canRecord} />
      )}

      {!archived && reconciledRows.length > 0 && (
        <SectionCard title="Reconciled metrics">
          <p className="mb-3 text-xs text-ink-muted">
            Headline values remain grounded in the reconciliation rules. Hover a value for the manual/API comparison.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {reconciledRows.map((entry) => (
              <div
                key={entry.id}
                className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-ink-muted">{entry.label}</span>
                  <span className="font-mono text-[9px] text-ink-dim">{entry.period_end}</span>
                </div>
                <div className="mt-1 text-base">
                  <MetricValue
                    unit={entry.unit}
                    manualValue={entry.manual_value}
                    apiValue={entry.api_value}
                    variancePct={entry.variance_pct}
                    status={entry.validation_status}
                  />
                </div>
                {rawEntryById.get(entry.id) && (
                  <div className="mt-2">
                    <RowActions
                      {...rowActionProps(
                        "metric_entries",
                        rawEntryById.get(entry.id)!,
                        profile
                      )}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );

  return (
    <AppShell breadcrumb={["Mthryve OS", "Metrics"]} profile={profile} workspace>
      <MetricsWorkspace
        departments={departments}
        brands={brands}
        briefHistory={briefHistory}
        validationCards={validationCards}
        logs={logs}
        canRecord={canRecord}
        recordAction={recordSnapshot}
        deleteAction={deleteMetricSnapshot}
        importAction={importMetrics}
        apiTools={apiTools}
        exportControl={
          canRecord ? (
            <MetricsCsvButton rows={exportRows} filename="metrics_snapshots.csv" />
          ) : undefined
        }
      />
    </AppShell>
  );
}
