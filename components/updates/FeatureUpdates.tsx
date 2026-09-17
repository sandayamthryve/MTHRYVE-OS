import Link from "next/link";

const agents = [
  ["Atlas", "Knowledge map", "/atlas", "Explore the company knowledge graph and connect people, projects, decisions, and documents.", "Ask for a knowledge summary or the connections around a project."],
  ["Care", "People wellbeing", "/care", "Run wellbeing check-ins, review the team pulse, and prepare people-care follow-ups for HR approval.", "Log a sample mood or ask for the team pulse."],
  ["Herald", "Outreach drafting", "/herald", "Draft lead and creator follow-ups while keeping every external send behind leadership approval.", "Try “Draft a follow-up for Alex.”"],
  ["Oracle", "Finance forecast", "/oracle", "Review forecasts, financial signals, and decision-ready summaries without taking financial actions.", "Ask for a cash-flow or spending forecast."],
  ["Prospector", "Opportunity scoring", "/prospector", "Rank opportunities HOT, WARM, or COLD and prepare qualification tasks before anyone is contacted.", "Ask it to score and explain the current opportunities."],
] as const;

const platformChanges = [
  ["Safe mock testing", "All five agents can be tested with realistic sample replies. Mock replies are clearly marked and make no AI API call, database write, approval, message, or external action."],
  ["Approval sweep", "The automation layer can collect pending decisions into a clearer leadership review flow."],
  ["Growth scoreboard", "Scoreboard automation and operational reporting make growth performance easier to review."],
  ["Navigation refresh", "The five agents now live in the relevant People, Partners, and Money areas, with this Updates tab serving as the single launch point."],
] as const;

export function FeatureUpdates() {
  return (
    <>
      <div className="mb-6 rounded-xl border border-gold-400/30 bg-gold-400/10 p-4">
        <p className="text-sm font-semibold text-gold-300">Safe testing is on</p>
        <p className="mt-1 text-sm leading-6 text-ink-muted">
          Agent replies use mock data and do not call an AI API, write to the database, create approvals, send messages, or trigger external actions.
        </p>
      </div>

      <section aria-labelledby="agent-updates">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal-400">Recently added</p>
            <h2 id="agent-updates" className="mt-1 text-xl font-semibold text-ink">Five specialist agents</h2>
          </div>
          <span className="text-xs text-ink-dim">Open one, use the test prompt, and look for “MOCK DATA” in the reply.</span>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map(([name, label, href, description, test]) => (
            <article key={name} className="flex flex-col rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-ink">{name}</h3>
                  <p className="mt-0.5 text-xs font-medium uppercase tracking-wider text-teal-400">{label}</p>
                </div>
                <span className="rounded-full border border-teal-500/30 bg-teal-500/10 px-2 py-1 font-mono text-[10px] text-teal-300">NEW</span>
              </div>
              <p className="mt-4 text-sm leading-6 text-ink-muted">{description}</p>
              <div className="mt-4 rounded-lg bg-charcoal-950 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">Try this</p>
                <p className="mt-1 text-sm text-ink">{test}</p>
              </div>
              <Link href={href} className="mt-5 inline-flex w-fit items-center rounded-md bg-teal-500 px-3.5 py-2 text-sm font-semibold text-charcoal-950 transition-colors hover:bg-teal-400">
                Open {name} →
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="platform-updates" className="mt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-teal-400">Platform changes</p>
        <h2 id="platform-updates" className="mt-1 text-xl font-semibold text-ink">Also included</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {platformChanges.map(([title, description]) => (
            <article key={title} className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4">
              <h3 className="font-semibold text-ink">{title}</h3>
              <p className="mt-1 text-sm leading-6 text-ink-muted">{description}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
