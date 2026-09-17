import type { OsSnapshot } from "@/lib/os/snapshot";

// Executive Operating Review — the compiled top of Mission Control.
//
// Every figure is read, never written in: the health grade off the composite
// Mission Control already computes, GMV off the page's selected window, clients
// and the book off the same OS snapshot the cockpits and client views read.
//
// NET MARGIN has no source. FinanceSnapshot carries cash flow and balance, not
// margin, and nothing in the OS holds a NET goal. It therefore renders as a dash
// rather than a number — the same dash the design shows, which is the honest
// state until someone computes it.

// 0..100 composite → the letter an operator actually reads. Thresholds match the
// RAG the rest of the OS grades on (>=75 green, >=50 amber), subdivided so the
// grade moves before the colour does.
function grade(health: number | null): { letter: string; tone: string } {
  if (health == null) return { letter: "—", tone: "text-[#6f8491]" };
  if (health >= 90) return { letter: "A", tone: "text-[#3ecf8e]" };
  if (health >= 85) return { letter: "A-", tone: "text-[#3ecf8e]" };
  if (health >= 80) return { letter: "B+", tone: "text-[#3ecf8e]" };
  if (health >= 75) return { letter: "B", tone: "text-[#3ecf8e]" };
  if (health >= 65) return { letter: "B-", tone: "text-[#f5b544]" };
  if (health >= 55) return { letter: "C+", tone: "text-[#f5b544]" };
  if (health >= 50) return { letter: "C", tone: "text-[#f5b544]" };
  return { letter: "D", tone: "text-[#f87171]" };
}

const peso = (value: number | null): string =>
  value == null
    ? "—"
    : `₱${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}`;

function Tile({
  label, value, tone, highlight,
}: { label: string; value: string; tone?: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-2xl border p-5 ${
        highlight ? "border-[#2dd4bf]/45 bg-[#0c1a1a]" : "border-[#20313c] bg-[#0b1319]"
      }`}
    >
      <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#8b9aa8]">{label}</p>
      <p className={`mt-3 text-[28px] font-black leading-none tracking-tight ${tone ?? "text-[#e9f0f6]"}`}>
        {value}
      </p>
    </div>
  );
}

export function ExecutiveOperatingReview({
  health, healthBasis, gmv, windowLabel, snapshot,
}: {
  health: number | null;
  healthBasis: string | null;
  gmv: number | null;
  windowLabel: string;
  snapshot: OsSnapshot | null;
}) {
  const { letter, tone } = grade(health);

  // The book, re-sorted. The #1 brand is whatever the snapshot says it is today,
  // so the headline moves on its own rather than naming a brand that was #1 once.
  const top = snapshot?.brands
    .filter((brand) => brand.gmv != null)
    .sort((a, b) => (b.gmv ?? 0) - (a.gmv ?? 0))[0];

  return (
    <section
      aria-label="Executive Operating Review"
      className="mb-6 rounded-2xl border border-[#20313c] bg-[#0a1016] p-5"
    >
      <h2 className="flex items-center gap-2 text-[15px] font-extrabold text-[#e9f0f6]">
        <span aria-hidden>🧭</span> Executive Operating Review — auto-compiled
        <span
          aria-label="Every figure is read from live data; nothing here is entered by hand."
          title={
            healthBasis
              ? `Health basis: ${healthBasis}. Every figure is read from live data.`
              : "Every figure is read from live data; nothing here is entered by hand."
          }
          className="grid h-[18px] w-[18px] place-items-center rounded-full border border-[#20313c] text-[10px] font-bold text-[#8b9aa8]"
        >
          i
        </span>
      </h2>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Company health" value={letter} tone={tone} highlight />
        <Tile label={`GMV · ${windowLabel}`} value={peso(gmv)} />
        <Tile label="Active clients" value={snapshot?.company.active_clients?.toString() ?? "—"} />
        {/* No margin in FinanceSnapshot — a dash, not a guess. */}
        <Tile label="Net margin" value="—" tone="text-[#f5b544]" />
      </div>

      <div className="mt-4 rounded-xl border border-[#20313c] border-l-4 border-l-[#2dd4bf] bg-[#0b1319] p-4">
        <p className="text-[13px] leading-6 text-[#b6c2cd]">
          {top ? (
            <>
              <b className="text-[#e9f0f6]">Top move:</b> {top.name} ({peso(top.gmv)}) is now your
              #1 — the whole book re-sorts. Fund what compounds; log finance so NET becomes
              measurable. Ledger is standing by at the gate.
            </>
          ) : (
            <>
              <b className="text-[#e9f0f6]">Top move:</b> no brand has reported in this window yet,
              so the book cannot be sorted. Log finance so NET becomes measurable — Ledger is
              standing by at the gate.
            </>
          )}
        </p>
      </div>
    </section>
  );
}
