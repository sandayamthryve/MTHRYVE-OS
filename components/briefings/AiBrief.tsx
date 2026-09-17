import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  getLatestOrgBriefing,
  getLatestAccountBriefing,
  getLatestDepartmentBriefing,
  getLatestFinanceBriefing,
  type Chip,
  type Highlight,
  type Solution,
} from "@/lib/briefings/read";
import {
  generateOrgBriefing,
  generateAccountBriefing,
  generateDepartmentActionPlan,
  generateFinanceBriefing,
} from "@/lib/briefings/generate";
import { getSkill, AI_BRIEF_FALLBACK } from "@/lib/skills/registry";

// <AiBrief> — the single reusable surface for the existing briefing engine
// (Step 1). It reads the latest org / department / account briefing that the
// generator already writes and renders it truthfully: org gets summary + KPI
// chips (colored by tone) + highlights (iconed by kind); department gets its
// challenges summary + the numbered action plan with owners/dates preserved
// verbatim; account gets the situation summary + challenges + recommended
// actions. The Generate/Refresh button drives the SAME server actions the
// Command Center / Departments / Accounts pages use — no second engine.
//
// Reads are org-wide by RLS. Department generation is ceo/coo/department_head
// only (RLS-enforced); pass canGenerate=false to hide the button for team
// members while still letting them read the plan.

type Scope = "org" | "department" | "account" | "finance";

const CHIP_TONE: Record<Chip["tone"], string> = {
  up: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  down: "border-red-500/40 bg-red-500/10 text-red-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  flag: "border-charcoal-700 bg-charcoal-800 text-ink-muted",
};

const HIGHLIGHT_STYLE: Record<Highlight["kind"], { label: string; icon: string; dot: string; text: string }> = {
  opportunity: { label: "Opportunity", icon: "▲", dot: "bg-teal-400", text: "text-teal-300" },
  risk: { label: "Risk", icon: "!", dot: "bg-red-400", text: "text-red-300" },
  ops: { label: "Ops", icon: "◆", dot: "bg-violet-400", text: "text-violet-300" },
};

const CONFIDENCE_TONE: Record<string, string> = {
  high: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  medium: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  low: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  insufficient: "border-charcoal-700 bg-charcoal-800 text-ink-muted",
};

const SCOPE_LABEL: Record<Scope, string> = {
  org: "Organization brief",
  department: "Department action plan",
  account: "Account brief",
  finance: "Finance brief",
};

function whenLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

function Meta({ model, confidence, at }: { model: string | null; confidence: string | null; at: string }) {
  const tone = confidence ? CONFIDENCE_TONE[confidence.toLowerCase()] ?? CONFIDENCE_TONE.insufficient : null;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {tone ? (
        <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}>
          confidence {confidence}
        </span>
      ) : null}
      <span className="font-mono text-[10px] text-ink-dim">
        {model ?? "—"} · {whenLabel(at)}
      </span>
    </div>
  );
}

function GenerateButton({
  hasBrief,
  action,
  hiddenField,
}: {
  hasBrief: boolean;
  action: (formData: FormData) => void | Promise<void>;
  hiddenField?: { name: string; value: string };
}) {
  return (
    <form action={action}>
      {hiddenField ? <input type="hidden" name={hiddenField.name} value={hiddenField.value} /> : null}
      <button
        type="submit"
        className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400"
      >
        {hasBrief ? "Refresh" : "Generate"}
      </button>
    </form>
  );
}

const cardClass =
  "relative overflow-hidden rounded-lg border border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-5 shadow-elevate";

export async function AiBrief({
  scope,
  id,
  canGenerate = true,
}: {
  scope: Scope;
  id?: string;
  canGenerate?: boolean;
}) {
  const supabase = createServerSupabaseClient();

  // ── Skill metadata (single source of truth) ──
  // This surface IS the 'ai_brief' skill in the Layer 4 registry. Pull its
  // name + description from skill_registry so the catalogue is authoritative;
  // fall back to a constant if the row is absent (fresh org / read failure).
  const skill = await getSkill(supabase, "ai_brief");
  const meta = {
    name: skill?.name ?? AI_BRIEF_FALLBACK.name,
    description: skill?.description ?? AI_BRIEF_FALLBACK.description,
  };
  const cardTitle = meta.description ?? undefined;

  // ── Resolve the generate action + hidden field for this scope ──
  let action: ((formData: FormData) => void | Promise<void>) | null = null;
  let hiddenField: { name: string; value: string } | undefined;
  if (scope === "org") {
    action = generateOrgBriefing;
  } else if (scope === "finance") {
    // Org-scoped, no id — the generator gathers the org's finance data itself.
    action = generateFinanceBriefing;
  } else if (scope === "department" && id) {
    action = generateDepartmentActionPlan;
    hiddenField = { name: "department_id", value: id };
  } else if (scope === "account" && id) {
    action = generateAccountBriefing;
    hiddenField = { name: "brand_id", value: id };
  }
  const showGenerate = canGenerate && !!action;

  // ── ORG ──
  if (scope === "org") {
    const brief = await getLatestOrgBriefing(supabase);
    const chips = (brief?.chips ?? []) as Chip[];
    const highlights = (brief?.highlights ?? []) as Highlight[];
    return (
      <section className={cardClass} title={cardTitle}>
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
        <Header
          title="Executive brief"
          badge="AI · org-wide"
          skillName={meta.name}
          action={showGenerate ? <GenerateButton hasBrief={!!brief} action={action!} /> : null}
        />
        {!brief ? (
          <Empty canGenerate={showGenerate} />
        ) : (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink">{brief.summary || "—"}</p>
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {chips.map((c, i) => (
                  <span
                    key={i}
                    className={`rounded-full border px-2.5 py-1 text-xs ${CHIP_TONE[c.tone] ?? CHIP_TONE.flag}`}
                  >
                    {c.label}
                  </span>
                ))}
              </div>
            )}
            {highlights.length > 0 && (
              <ul className="space-y-2.5 border-t border-charcoal-800 pt-3">
                {highlights.map((h, i) => {
                  const s = HIGHLIGHT_STYLE[h.kind] ?? HIGHLIGHT_STYLE.ops;
                  return (
                    <li key={i} className="flex items-start gap-2.5">
                      <span
                        aria-hidden
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-charcoal-950 ${s.dot}`}
                      >
                        {s.icon}
                      </span>
                      <div>
                        <p className={`font-mono text-[10px] uppercase tracking-wider ${s.text}`}>{s.label}</p>
                        <p className="text-sm text-ink">{h.text}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <Meta model={brief.model} confidence={brief.data_confidence} at={brief.created_at} />
          </div>
        )}
      </section>
    );
  }

  // ── DEPARTMENT ──
  if (scope === "department") {
    if (!id) return null;
    const brief = await getLatestDepartmentBriefing(supabase, id);
    const hasPlan = !!brief && !!brief.action_plan && brief.action_plan.trim().length > 0;
    return (
      <section className={cardClass} title={cardTitle}>
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
        <Header
          title={SCOPE_LABEL.department}
          badge="AI · grounded"
          skillName={meta.name}
          action={showGenerate ? <GenerateButton hasBrief={!!brief} action={action!} hiddenField={hiddenField} /> : null}
        />
        {!hasPlan ? (
          <Empty canGenerate={showGenerate} />
        ) : (
          <div className="space-y-3">
            {brief!.challenges_summary && brief!.challenges_summary.trim() ? (
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Challenges</p>
                <p className="text-sm text-ink-muted">{brief!.challenges_summary}</p>
              </div>
            ) : null}
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Action plan</p>
              {/* whitespace-pre-line preserves the numbered structure, owner names
                  like "(Krizza)", and dates like "BY 7/14" exactly as generated. */}
              <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{brief!.action_plan}</p>
            </div>
            <Meta model={brief!.model} confidence={brief!.data_confidence} at={brief!.created_at} />
          </div>
        )}
      </section>
    );
  }

  // ── FINANCE (org-scoped, ceo/coo only via RLS) ──
  if (scope === "finance") {
    const brief = await getLatestFinanceBriefing(supabase);
    const challenges = (brief?.challenges ?? []) as string[];
    const bottlenecks = (brief?.bottlenecks ?? []) as string[];
    const solutions = (brief?.solutions ?? []) as Solution[];
    return (
      <section className={cardClass} title={cardTitle}>
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
        <Header
          title={SCOPE_LABEL.finance}
          badge="AI · finance"
          skillName={meta.name}
          action={showGenerate ? <GenerateButton hasBrief={!!brief} action={action!} /> : null}
        />
        {!brief ? (
          <Empty canGenerate={showGenerate} emptyText="No finance brief yet — Generate." />
        ) : (
          <div className="space-y-4">
            {brief.summary && <p className="text-sm leading-relaxed text-ink">{brief.summary}</p>}
            {challenges.length > 0 && (
              <div>
                <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Challenges</p>
                <ul className="space-y-1.5">
                  {challenges.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-ink">
                      <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {bottlenecks.length > 0 && (
              <div>
                <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Root causes</p>
                <ul className="space-y-1.5">
                  {bottlenecks.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-ink-muted">
                      <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {solutions.length > 0 && (
              <div>
                <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                  Recommended actions
                </p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {solutions.map((s, i) => (
                    <div key={i} className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-3">
                      <p className="text-sm font-semibold text-teal-300">{s.solution}</p>
                      {s.why && <p className="mt-1 text-xs italic text-ink-muted">{s.why}</p>}
                      {Array.isArray(s.steps) && s.steps.length > 0 && (
                        <ol className="mt-2 space-y-1">
                          {s.steps.map((step, j) => (
                            <li key={j} className="flex items-start gap-2 text-xs text-ink">
                              <span className="font-mono text-teal-400">{j + 1}.</span>
                              <span>{step}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Meta model={brief.model} confidence={brief.data_confidence} at={brief.created_at} />
            <DataSources sources={brief.data_sources} />
          </div>
        )}
      </section>
    );
  }

  // ── ACCOUNT (brand) ──
  if (!id) return null;
  const brief = await getLatestAccountBriefing(supabase, id);
  const challenges = (brief?.challenges ?? []) as string[];
  const solutions = (brief?.solutions ?? []) as Solution[];
  return (
    <section className={cardClass}>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
      <Header
        title={SCOPE_LABEL.account}
        badge="AI · account"
        skillName={meta.name}
        action={showGenerate ? <GenerateButton hasBrief={!!brief} action={action!} hiddenField={hiddenField} /> : null}
      />
      {!brief ? (
        <Empty canGenerate={showGenerate} />
      ) : (
        <div className="space-y-4">
          {brief.summary && <p className="text-sm leading-relaxed text-ink">{brief.summary}</p>}
          {challenges.length > 0 && (
            <div>
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Challenges</p>
              <ul className="space-y-1.5">
                {challenges.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-ink">
                    <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {solutions.length > 0 && (
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                Recommended actions
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {solutions.map((s, i) => (
                  <div key={i} className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-3">
                    <p className="text-sm font-semibold text-teal-300">{s.solution}</p>
                    {s.why && <p className="mt-1 text-xs italic text-ink-muted">{s.why}</p>}
                    {Array.isArray(s.steps) && s.steps.length > 0 && (
                      <ol className="mt-2 space-y-1">
                        {s.steps.map((step, j) => (
                          <li key={j} className="flex items-start gap-2 text-xs text-ink">
                            <span className="font-mono text-teal-400">{j + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <Meta model={brief.model} confidence={brief.data_confidence} at={brief.created_at} />
        </div>
      )}
    </section>
  );
}

function Header({
  title,
  badge,
  action,
  skillName,
}: {
  title: string;
  badge: string;
  action: React.ReactNode;
  // The skill's registry name (skill_registry.name for 'ai_brief'). Rendered as
  // an eyebrow above the per-scope title so the surface is labelled from the
  // single source of truth. Omitted → no eyebrow.
  skillName?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        {skillName ? (
          <p className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">{skillName}</p>
        ) : null}
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-300">
            {badge}
          </span>
        </div>
      </div>
      {action}
    </div>
  );
}

// The data_sources line — exactly what the brief read (e.g. cash_positions 0 ·
// settlements 4 · retainer_brands 2 · payroll_runs 1). Nothing hidden.
function DataSources({ sources }: { sources: Record<string, number> | null | undefined }) {
  const entries = sources ? Object.entries(sources) : [];
  if (entries.length === 0) return null;
  return (
    <p className="border-t border-charcoal-800 pt-3 font-mono text-[10px] text-ink-dim">
      Sources:{" "}
      {entries.map(([k, v]) => `${k} ${v}`).join(" · ")}
    </p>
  );
}

function Empty({ canGenerate, emptyText }: { canGenerate: boolean; emptyText?: string }) {
  if (emptyText) {
    return (
      <p className="text-sm text-ink-muted">
        {emptyText}
        {!canGenerate ? " Ask a manager to generate one." : ""}
      </p>
    );
  }
  return (
    <p className="text-sm text-ink-muted">
      No brief generated yet.
      {canGenerate ? " Generate one to get a truthful, data-grounded read." : " Ask a manager to generate one."}
    </p>
  );
}
