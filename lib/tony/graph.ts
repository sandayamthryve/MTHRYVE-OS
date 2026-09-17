// lib/tony/graph.ts — the ONE place that assembles the Tony Cognitive
// Visualization Engine (TCVE) graph from REAL org data.
//
// Every node/edge is derived from a real row read through the caller's
// RLS-scoped @supabase/ssr client, so Postgres already scopes rows to the
// caller's org (org_id = current_org_id()) and per-role visibility. On top of
// RLS we add defence-in-depth role gating so a member never even receives a
// leadership-only node (leadership-sensitive documents, ceo-only workflows/
// approvals, the org GMV KPI) — matching the pattern in lib/tony/nodes.ts and
// lib/skills/registry.ts.
//
// GROUNDING: nothing here fabricates a figure. An empty/missing source yields a
// null value which the UI renders as "—". Several graph tables aren't in the
// generated Database types yet (department_brands, pods, pod_brands,
// automation_registry, action_requests, campaigns, vesper_clip_jobs), so they're
// read through the same cast shim (`UntypedClient`) the rest of the app uses,
// each defended so one slow/absent source degrades gracefully instead of
// sinking the hero screen. No schema or RLS changes are made here.

import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { SessionProfile } from "@/lib/auth/session";
import type {
  TcveGraph,
  TcveNode,
  TcveEdge,
  TcveStatus,
  TcvePipelineStage,
} from "./graph-types";
import { fetchCommerceRows, aggregate, platformLabel } from "@/lib/metrics/gmv";
import { monthToDate } from "@/lib/metrics/windows";
import { peso, int } from "@/lib/metrics/format";
import type { UserRole } from "@/types/database";

type Client = ReturnType<typeof createServerSupabaseClient>;
// Escape hatch for tables not in the generated types — reads only, never writes.
type UntypedClient = { from: (t: string) => any };

// Recent-activity window: a real row touched within this many days makes its
// node "glow" (active). Purely visual — no number is animated.
const ACTIVE_DAYS = 7;
const ACTIVE_MS = ACTIVE_DAYS * 24 * 3600 * 1000;

// Role visibility ladder (mirrors lib/skills/registry.ts). A row tagged
// required_role R is visible to any caller whose role sits at or above R.
const ROLE_RANK: Record<UserRole, number> = {
  team_member: 0,
  department_head: 1,
  coo: 2,
  ceo: 3,
};
function canSeeRequiredRole(callerRole: UserRole, required: string | null): boolean {
  const req = (required ?? "team_member") as UserRole;
  const reqRank = req in ROLE_RANK ? ROLE_RANK[req] : ROLE_RANK.ceo; // unknown → leadership-only
  return ROLE_RANK[callerRole] >= reqRank;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);
function isRecent(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && nowMs - t <= ACTIVE_MS;
}
function short(text: string | null | undefined, max = 120): string | null {
  if (!text) return null;
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ── Row shapes (only the columns we read) ───────────────────────────────────
type UserRow = { id: string; full_name: string | null; role: string | null; department_id: string | null; position: string | null };
type DeptRow = { id: string; name: string; lead_user_id: string | null; updated_at: string | null };
type BrandRow = { id: string; name: string; status: string | null; category: string | null; platform_focus: string[] | null; updated_at: string | null };
type DeptBrandRow = { department_id: string; brand_id: string; role: string | null };
type PodRow = { id: string; name: string; lead_user_id: string | null; status: string | null; target_brands: number | null };
type PodBrandRow = { pod_id: string; brand_id: string };
type SkillRow = { key: string; name: string; category: string | null; description: string | null; required_role: string | null; enabled: boolean; backing: string | null };
type AutomationRow = { key: string; name: string; kind: string | null; description: string | null; required_role: string | null; enabled: boolean; requires_approval: boolean; risk_tier: number | null };
type DocRow = { id: string; title: string; source_type: string | null; sensitivity: string | null; status: string | null; chunk_count: number | null; department_id: string | null; updated_at: string | null };
type ApprovalRow = { id: string; title: string; status: string | null; source_module: string | null; risk_tier: number | null; required_role: string | null; recommendation: string | null; confidence: number | null; updated_at: string | null };
type TaskRow = { id: string; status: string | null; brand_id: string | null; updated_at: string | null };
type CampaignRow = { id: string; brand_id: string | null; status: string | null };

const TASK_DONE = new Set(["done", "cancelled"]);
const BRAND_SETTLED = new Set(["archived", "inactive", "paused"]);

/**
 * Assemble the full living enterprise graph for the signed-in profile. All reads
 * are org-scoped by RLS on `supabase`; leadership-only nodes are additionally
 * role-gated so a member never receives a node they can't open.
 */
export async function getTonyGraph(supabase: Client, profile: SessionProfile): Promise<TcveGraph> {
  const u = supabase as unknown as UntypedClient;
  const role = profile.role;
  const isLeadership = role === "ceo" || role === "coo";
  const nowMs = Date.now();
  const mtd = monthToDate(nowMs);

  const safe = <T>(p: PromiseLike<T>, fallback: T): Promise<T> =>
    Promise.resolve(p).then((v) => v, () => fallback);
  const rows = <T>(res: { data?: unknown } | null): T[] => ((res?.data ?? []) as T[]) ?? [];

  const [
    orgRes,
    usersRes,
    deptRes,
    brandRes,
    deptBrandRes,
    podRes,
    podBrandRes,
    skillRes,
    autoRes,
    docRes,
    approvalRes,
    taskRes,
    campaignRes,
    bpmRows,
    vesperRes,
  ] = await Promise.all([
    safe(u.from("organizations").select("name").eq("id", profile.org_id).maybeSingle(), { data: null }),
    safe(u.from("users").select("id, full_name, role, department_id, position"), { data: [] }),
    safe(u.from("departments").select("id, name, lead_user_id, updated_at"), { data: [] }),
    safe(u.from("brands").select("id, name, status, category, platform_focus, updated_at"), { data: [] }),
    safe(u.from("department_brands").select("department_id, brand_id, role"), { data: [] }),
    safe(u.from("pods").select("id, name, lead_user_id, status, target_brands"), { data: [] }),
    safe(u.from("pod_brands").select("pod_id, brand_id"), { data: [] }),
    safe(
      u.from("skill_registry").select("key, name, category, description, required_role, enabled, backing").eq("enabled", true),
      { data: [] }
    ),
    safe(
      u.from("automation_registry").select("key, name, kind, description, required_role, enabled, requires_approval, risk_tier"),
      { data: [] }
    ),
    safe(u.from("documents").select("id, title, source_type, sensitivity, status, chunk_count, department_id, updated_at"), { data: [] }),
    safe(
      u
        .from("action_requests")
        .select("id, title, status, source_module, risk_tier, required_role, recommendation, confidence, updated_at")
        .eq("status", "pending"),
      { data: [] }
    ),
    safe(u.from("tasks").select("id, status, brand_id, updated_at"), { data: [] }),
    safe(u.from("campaigns").select("id, brand_id, status"), { data: [] }),
    safe(fetchCommerceRows(supabase), [] as Awaited<ReturnType<typeof fetchCommerceRows>>),
    // Vesper (the Video Studio agent) is backed by its own job ledger, not the
    // skill_registry — we surface a real clip-job count so the node is honest.
    safe(u.from("vesper_clip_jobs").select("id", { count: "exact", head: true }), { count: null }),
  ]);

  const orgName = ((orgRes as { data?: { name?: string } | null }).data?.name ?? null) as string | null;
  const users = rows<UserRow>(usersRes);
  const depts = rows<DeptRow>(deptRes);
  const brands = rows<BrandRow>(brandRes);
  const deptBrands = rows<DeptBrandRow>(deptBrandRes);
  const pods = rows<PodRow>(podRes);
  const podBrands = rows<PodBrandRow>(podBrandRes);
  const skills = rows<SkillRow>(skillRes);
  const automations = rows<AutomationRow>(autoRes);
  const docs = rows<DocRow>(docRes);
  const approvals = rows<ApprovalRow>(approvalRes);
  const tasks = rows<TaskRow>(taskRes);
  const campaigns = rows<CampaignRow>(campaignRes);
  const vesperJobs = ((vesperRes as { count?: number | null }).count ?? null) as number | null;

  const userName = (id: string | null): string | null =>
    (id && users.find((x) => x.id === id)?.full_name) || null;

  const nodes: TcveNode[] = [];
  const edges: TcveEdge[] = [];
  const pushEdge = (e: TcveEdge) => edges.push(e);

  // ── Center: Tony (brain), pinned ──────────────────────────────────────────
  const memberCount = users.length;
  nodes.push({
    id: "tony",
    type: "brain",
    label: "Tony",
    sublabel: "Executive Brain",
    status: "active",
    owner: orgName,
    stats: [
      { label: "Organization", value: orgName },
      { label: "Departments", value: depts.length ? int(depts.length) : null },
      { label: "Brands", value: brands.length ? int(brands.length) : null },
      { label: "Team members", value: memberCount ? int(memberCount) : null },
    ],
    href: "/tony",
    parentId: null,
    collapsible: false,
    hiddenByDefault: false,
    active: true,
    meta: { role, isLeadership },
  });

  // ── Agents: skill_registry (role-visible) + Vesper (video studio) ─────────
  const visibleSkills = skills.filter((s) => canSeeRequiredRole(role, s.required_role));
  for (const s of visibleSkills) {
    const id = `agent:${s.key}`;
    nodes.push({
      id,
      type: "agent",
      label: s.name,
      sublabel: s.category ? s.category[0].toUpperCase() + s.category.slice(1) : "Skill",
      status: s.enabled ? "active" : "muted",
      owner: null,
      stats: [
        { label: "Category", value: s.category ?? null },
        { label: "Min. role", value: s.required_role ?? null },
        { label: "Backing", value: s.backing ?? null },
        { label: "Status", value: s.enabled ? "Enabled" : "Disabled" },
      ],
      href: s.key === "agent_csi" ? "/csi" : "/assistant",
      parentId: "tony",
      collapsible: false,
      hiddenByDefault: false,
      active: s.enabled,
      meta: { key: s.key, description: short(s.description, 160) },
    });
    pushEdge({ id: `e:tony-${id}`, source: "tony", target: id, kind: "orchestrates", label: "invokes", animated: true });
  }
  // Vesper — real clip-job ledger (vesper_clip_jobs). Included only when the read
  // succeeded (count is a number, even 0); otherwise omitted rather than faked.
  if (vesperJobs !== null) {
    const id = "agent:vesper";
    nodes.push({
      id,
      type: "agent",
      label: "Vesper",
      sublabel: "Video Studio",
      status: vesperJobs > 0 ? "active" : "idle",
      owner: null,
      stats: [
        { label: "Clip jobs", value: int(vesperJobs) },
        { label: "Domain", value: "AI video / clips" },
      ],
      href: "/vesper",
      parentId: "tony",
      collapsible: false,
      hiddenByDefault: false,
      active: vesperJobs > 0,
      meta: { source: "vesper_clip_jobs" },
    });
    pushEdge({ id: `e:tony-${id}`, source: "tony", target: id, kind: "orchestrates", label: "delegates", animated: true });
  }

  // ── Departments ───────────────────────────────────────────────────────────
  const brandsOfDept = new Map<string, DeptBrandRow[]>();
  for (const db of deptBrands) {
    const arr = brandsOfDept.get(db.department_id) ?? [];
    arr.push(db);
    brandsOfDept.set(db.department_id, arr);
  }
  const membersOfDept = new Map<string, number>();
  for (const usr of users) {
    if (usr.department_id) membersOfDept.set(usr.department_id, (membersOfDept.get(usr.department_id) ?? 0) + 1);
  }
  for (const d of depts) {
    const id = `dept:${d.id}`;
    const brandCount = brandsOfDept.get(d.id)?.length ?? 0;
    const members = membersOfDept.get(d.id) ?? 0;
    nodes.push({
      id,
      type: "department",
      label: d.name,
      sublabel: "Department",
      status: members > 0 || brandCount > 0 ? "active" : "muted",
      owner: userName(d.lead_user_id),
      stats: [
        { label: "Lead", value: userName(d.lead_user_id) },
        { label: "Brands", value: brandCount ? int(brandCount) : null },
        { label: "Team members", value: members ? int(members) : null },
      ],
      href: `/department/${d.id}`,
      parentId: "tony",
      collapsible: brandCount > 0,
      hiddenByDefault: false,
      active: isRecent(d.updated_at, nowMs),
      meta: { childBrands: brandCount },
    });
    pushEdge({ id: `e:tony-${id}`, source: "tony", target: id, kind: "structure", label: null, animated: false });
  }

  // ── Brands (children of their primary department for progressive disclosure) ─
  const tasksOfBrand = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    if (t.brand_id) {
      const arr = tasksOfBrand.get(t.brand_id) ?? [];
      arr.push(t);
      tasksOfBrand.set(t.brand_id, arr);
    }
  }
  const campaignsOfBrand = new Map<string, number>();
  for (const c of campaigns) {
    if (c.brand_id) campaignsOfBrand.set(c.brand_id, (campaignsOfBrand.get(c.brand_id) ?? 0) + 1);
  }
  const deptsOfBrand = new Map<string, DeptBrandRow[]>();
  for (const db of deptBrands) {
    const arr = deptsOfBrand.get(db.brand_id) ?? [];
    arr.push(db);
    deptsOfBrand.set(db.brand_id, arr);
  }
  for (const b of brands) {
    const id = `brand:${b.id}`;
    const brandAssigns = deptsOfBrand.get(b.id) ?? [];
    // Primary department = an assignment flagged "primary", else the first one.
    const primary = brandAssigns.find((a) => (a.role ?? "").toLowerCase() === "primary") ?? brandAssigns[0];
    const parentDeptId = primary ? `dept:${primary.department_id}` : null;
    const bTasks = tasksOfBrand.get(b.id) ?? [];
    const openTasks = bTasks.filter((t) => !TASK_DONE.has((t.status ?? "").toLowerCase())).length;
    const gmvAgg = aggregate(bpmRows, mtd, { brandId: b.id });
    const settled = BRAND_SETTLED.has((b.status ?? "").toLowerCase());
    const recent = bTasks.some((t) => isRecent(t.updated_at, nowMs)) || isRecent(b.updated_at, nowMs);
    const status: TcveStatus = settled ? "idle" : openTasks > 0 || recent ? "active" : "muted";
    const ownerName = primary ? userName(depts.find((d) => d.id === primary.department_id)?.lead_user_id ?? null) : null;
    nodes.push({
      id,
      type: "brand",
      label: b.name,
      sublabel: b.category ?? "Client / Brand",
      status,
      owner: ownerName,
      stats: [
        { label: "Status", value: b.status ?? null },
        { label: "Category", value: b.category ?? null },
        { label: "MTD GMV", value: gmvAgg.hasData ? peso(gmvAgg.gmv, gmvAgg.currency) : null },
        { label: "Open tasks", value: bTasks.length ? int(openTasks) : null },
        { label: "Campaigns", value: campaignsOfBrand.get(b.id) ? int(campaignsOfBrand.get(b.id)!) : null },
        {
          label: "Platforms",
          value: b.platform_focus && b.platform_focus.length ? b.platform_focus.map((p) => platformLabel(p)).join(", ") : null,
        },
      ],
      href: `/brands/${b.id}`,
      // Attach to its primary department; hidden until that department is
      // expanded. Orphan brands (no department) attach to Tony and stay visible.
      parentId: parentDeptId,
      collapsible: false,
      hiddenByDefault: parentDeptId !== null,
      active: openTasks > 0 || recent,
      meta: { openTasks, gmv: gmvAgg.hasData ? gmvAgg.gmv : null },
    });
    // Structural edges to EVERY assigned department (department_brands is the
    // real dept↔brand relationship). Orphan brands hang off Tony instead.
    if (brandAssigns.length) {
      for (const a of brandAssigns) {
        pushEdge({
          id: `e:dept-${a.department_id}-brand-${b.id}`,
          source: `dept:${a.department_id}`,
          target: id,
          kind: "structure",
          label: a.role ?? null,
          animated: false,
        });
      }
    } else {
      pushEdge({ id: `e:tony-${id}`, source: "tony", target: id, kind: "structure", label: null, animated: false });
    }
  }

  // ── Pods → brands (pod_brands is the real pod↔brand membership) ────────────
  const brandsOfPod = new Map<string, PodBrandRow[]>();
  for (const pb of podBrands) {
    const arr = brandsOfPod.get(pb.pod_id) ?? [];
    arr.push(pb);
    brandsOfPod.set(pb.pod_id, arr);
  }
  for (const p of pods) {
    const id = `pod:${p.id}`;
    const podBrandRows = brandsOfPod.get(p.id) ?? [];
    nodes.push({
      id,
      type: "pod",
      label: p.name,
      sublabel: "Growth Pod",
      status: (p.status ?? "").toLowerCase() === "active" ? "active" : "idle",
      owner: userName(p.lead_user_id),
      stats: [
        { label: "Lead", value: userName(p.lead_user_id) },
        { label: "Brands", value: podBrandRows.length ? int(podBrandRows.length) : null },
        { label: "Target brands", value: p.target_brands != null ? int(p.target_brands) : null },
        { label: "Status", value: p.status ?? null },
      ],
      href: "/pods",
      parentId: "tony",
      collapsible: false,
      hiddenByDefault: false,
      active: (p.status ?? "").toLowerCase() === "active",
      meta: {},
    });
    pushEdge({ id: `e:tony-${id}`, source: "tony", target: id, kind: "structure", label: null, animated: false });
    for (const pb of podBrandRows) {
      // Only draw the edge if the brand node exists (RLS-visible).
      if (brands.some((b) => b.id === pb.brand_id)) {
        pushEdge({ id: `e:pod-${p.id}-brand-${pb.brand_id}`, source: id, target: `brand:${pb.brand_id}`, kind: "assignment", label: "pod", animated: false });
      }
    }
  }

  // ── Workflows: automation_registry (role-visible) ─────────────────────────
  const visibleAutomations = automations.filter((a) => canSeeRequiredRole(role, a.required_role));
  for (const a of visibleAutomations) {
    const id = `workflow:${a.key}`;
    nodes.push({
      id,
      type: "workflow",
      label: a.name,
      sublabel: a.kind ?? "Automation",
      status: a.enabled ? "active" : "muted",
      owner: null,
      stats: [
        { label: "Kind", value: a.kind ?? null },
        { label: "Min. role", value: a.required_role ?? null },
        { label: "Approval", value: a.requires_approval ? "Required" : "Not required" },
        { label: "Risk tier", value: a.risk_tier != null ? int(a.risk_tier) : null },
        { label: "Status", value: a.enabled ? "Enabled" : "Disabled" },
      ],
      href: "/ai-governance",
      parentId: "tony",
      collapsible: false,
      hiddenByDefault: false,
      active: a.enabled,
      meta: { key: a.key, description: short(a.description, 160) },
    });
    pushEdge({ id: `e:tony-${id}`, source: "tony", target: id, kind: "workflow", label: "runs", animated: a.enabled });
  }

  // ── Knowledge: a cluster hub with document children (progressive disclosure) ─
  // Non-leadership never receive leadership-sensitive documents.
  const visibleDocs = docs.filter((d) => isLeadership || (d.sensitivity ?? "org").toLowerCase() !== "leadership");
  if (visibleDocs.length > 0) {
    const hubId = "knowledge:hub";
    const totalChunks = visibleDocs.reduce((a, d) => a + num(d.chunk_count), 0);
    nodes.push({
      id: hubId,
      type: "knowledge_hub",
      label: "Knowledge Base",
      sublabel: "RAG corpus",
      status: "active",
      owner: null,
      stats: [
        { label: "Documents", value: int(visibleDocs.length) },
        { label: "Indexed chunks", value: totalChunks ? int(totalChunks) : null },
      ],
      href: "/knowledge",
      parentId: "tony",
      collapsible: true,
      hiddenByDefault: false,
      active: true,
      meta: { childDocs: visibleDocs.length },
    });
    pushEdge({ id: `e:tony-${hubId}`, source: "tony", target: hubId, kind: "knowledge", label: "grounds on", animated: true });
    for (const d of visibleDocs) {
      const id = `doc:${d.id}`;
      nodes.push({
        id,
        type: "knowledge",
        label: d.title,
        sublabel: d.source_type ?? "Document",
        status: (d.status ?? "").toLowerCase() === "ready" ? "idle" : "attention",
        owner: null,
        stats: [
          { label: "Type", value: d.source_type ?? null },
          { label: "Sensitivity", value: d.sensitivity ?? null },
          { label: "Status", value: d.status ?? null },
          { label: "Chunks", value: d.chunk_count != null ? int(d.chunk_count) : null },
        ],
        href: "/knowledge",
        parentId: hubId,
        collapsible: false,
        hiddenByDefault: true, // clustered under the hub until expanded
        active: false,
        meta: { sensitivity: d.sensitivity },
      });
      pushEdge({ id: `e:${hubId}-${id}`, source: hubId, target: id, kind: "knowledge", label: null, animated: false });
      // A department-scoped document also links to that department.
      if (d.department_id && depts.some((x) => x.id === d.department_id)) {
        pushEdge({ id: `e:${id}-dept-${d.department_id}`, source: id, target: `dept:${d.department_id}`, kind: "knowledge", label: null, animated: false });
      }
    }
  }

  // ── Approvals: pending action_requests (role-visible) ─────────────────────
  const visibleApprovals = approvals.filter((a) => canSeeRequiredRole(role, a.required_role));
  for (const a of visibleApprovals) {
    const id = `approval:${a.id}`;
    nodes.push({
      id,
      type: "approval",
      label: short(a.title, 60) ?? "Approval request",
      sublabel: a.source_module ?? "Approval",
      status: "attention",
      owner: null,
      stats: [
        { label: "Status", value: a.status ?? null },
        { label: "Source", value: a.source_module ?? null },
        { label: "Risk tier", value: a.risk_tier != null ? int(a.risk_tier) : null },
        { label: "Confidence", value: a.confidence != null ? `${Math.round(a.confidence * 100)}%` : null },
        { label: "Needs role", value: a.required_role ?? null },
      ],
      href: "/approvals",
      parentId: "tony",
      collapsible: false,
      hiddenByDefault: false,
      active: true, // pending → live
      meta: { recommendation: short(a.recommendation, 200) },
    });
    pushEdge({ id: `e:tony-${id}`, source: "tony", target: id, kind: "approval", label: "awaits decision", animated: true });
  }

  // ── KPI nodes: real org-level aggregates (GMV is leadership-only) ─────────
  const activeBrands = brands.filter((b) => !BRAND_SETTLED.has((b.status ?? "").toLowerCase())).length;
  const openTasksTotal = tasks.filter((t) => !TASK_DONE.has((t.status ?? "").toLowerCase())).length;
  const kpiDefs: Array<{ key: string; label: string; value: string | null; note: string; leadershipOnly?: boolean }> = [
    { key: "active_brands", label: "Active Brands", value: brands.length ? int(activeBrands) : null, note: "of the brand portfolio" },
    { key: "open_approvals", label: "Open Approvals", value: int(visibleApprovals.length), note: "pending a decision" },
    { key: "open_tasks", label: "Open Tasks", value: tasks.length ? int(openTasksTotal) : null, note: "across the org" },
  ];
  if (isLeadership) {
    const orgAgg = aggregate(bpmRows, mtd);
    kpiDefs.push({
      key: "mtd_gmv",
      label: "MTD GMV",
      value: orgAgg.hasData ? peso(orgAgg.gmv, orgAgg.currency) : null,
      note: "month-to-date",
      leadershipOnly: true,
    });
  }
  for (const k of kpiDefs) {
    const id = `kpi:${k.key}`;
    nodes.push({
      id,
      type: "kpi",
      label: k.label,
      sublabel: k.note,
      status: k.value ? "active" : "muted",
      owner: null,
      stats: [{ label: k.label, value: k.value }],
      href: k.key === "mtd_gmv" ? "/finance" : k.key === "open_approvals" ? "/approvals" : k.key === "open_tasks" ? "/tasks" : "/brands",
      parentId: "tony",
      collapsible: false,
      hiddenByDefault: false,
      active: false,
      meta: { leadershipOnly: !!k.leadershipOnly },
    });
    pushEdge({ id: `e:tony-${id}`, source: "tony", target: id, kind: "kpi", label: null, animated: false });
  }

  // ── Pipeline: Tony's REAL request stages (app/api/assistant/route.ts) ─────
  const pipeline = buildPipeline({
    isLeadership,
    role,
    docCount: visibleDocs.length,
    chunkCount: visibleDocs.reduce((a, d) => a + num(d.chunk_count), 0),
    skillCount: visibleSkills.length,
    workflowCount: visibleAutomations.length,
    memoryCount: 0, // tony_memory is currently empty; a real count could be read later
  });

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;

  return {
    nodes,
    edges,
    pipeline,
    meta: {
      orgName,
      generatedAt: new Date().toISOString(),
      role,
      isLeadership,
      centerId: "tony",
      counts,
    },
  };
}

// The REAL pipeline Tony runs on every request, as implemented in
// app/api/assistant/route.ts (the Anthropic agentic tool-use loop). `detail`
// carries the caller-scoped real facts each stage exposes today; null where a
// stage has nothing concrete to surface without actually running the request.
function buildPipeline(ctx: {
  isLeadership: boolean;
  role: string;
  docCount: number;
  chunkCount: number;
  skillCount: number;
  workflowCount: number;
  memoryCount: number;
}): TcvePipelineStage[] {
  const tier = ctx.isLeadership ? "Premium (Opus)" : "Standard";
  return [
    {
      key: "intent",
      title: "Intent",
      description: "Fast-path vs. agentic routing (isSimpleConversational).",
      detail: "Conversational messages skip tools; work questions enter the tool loop.",
      status: "conditional",
    },
    {
      key: "model",
      title: "Model tier",
      description: "Role → default tier → Claude model; higher tiers need a CEO/COO grant.",
      detail: `Your default tier: ${tier}`,
      status: "gated",
    },
    {
      key: "rag",
      title: "RAG retrieval",
      description: "Grounding context + the knowledge corpus (document_chunks).",
      detail: ctx.docCount > 0 ? `${ctx.docCount} documents · ${ctx.chunkCount} indexed chunks available` : "No documents indexed yet",
      status: "conditional",
    },
    {
      key: "agent",
      title: "Agent / skill selection",
      description: "Role-scoped read, act & navigate tools assembled for the loop.",
      detail: `${ctx.skillCount} skill${ctx.skillCount === 1 ? "" : "s"} · ${ctx.workflowCount} workflow${ctx.workflowCount === 1 ? "" : "s"} visible to you`,
      status: "ready",
    },
    {
      key: "tool",
      title: "Tool use",
      description: "Agentic loop runs RLS-scoped tools (≤ 6 rounds), feeding results back.",
      detail: "Every tool query is scoped to your org + role by Postgres RLS.",
      status: "ready",
    },
    {
      key: "reasoning",
      title: "Reasoning",
      description: "Claude reasons over the grounded tool results.",
      detail: null,
      status: "ready",
    },
    {
      key: "validation",
      title: "Validation",
      description: "Honesty + citation rules; never fabricate, cite sources, '—' for missing.",
      detail: null,
      status: "ready",
    },
    {
      key: "recommendation",
      title: "Recommendation",
      description: "The grounded answer, or a navigation to the right OS page.",
      detail: null,
      status: "ready",
    },
    {
      key: "execution",
      title: "Gated execution",
      description: "Writes are self-scoped for all; broader actions queue an action_request.",
      detail: ctx.isLeadership ? "Leadership: direct writes + can decide proposals" : "Non-leadership: self-scoped writes; broader actions are proposed",
      status: "gated",
    },
    {
      key: "learning",
      title: "Learning",
      description: "Turn persisted to ai_messages; durable facts to Tony Memory.",
      detail: null,
      status: "ready",
    },
  ];
}
