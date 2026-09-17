import type { DeskView } from "@/lib/home/cockpit-desks";

// The nine-desk board at the head of the Department Cockpits page.
//
// Every card is driven by the same OS snapshot, so this board cannot disagree
// with Home or with what a client is shown. Where the snapshot has no figure for
// a desk, the card says so rather than printing a number nobody computed — the
// banner promises no frozen blocks, and an invented headline would break exactly
// that promise while looking like it kept it.

const STATUS_TEXT: Record<string, string> = {
  green: "text-[#3ecf8e]",
  amber: "text-[#f5b544]",
  red: "text-[#f87171]",
};

export function DeskBoard({ desks, leadership }: { desks: DeskView[]; leadership: boolean }) {
  return (
    <>
      <div className="mb-5 rounded-2xl border border-[#20313c] border-l-4 border-l-[#2dd4bf] bg-[#0b1319] p-4">
        <p className="text-[13px] leading-6 text-[#b6c2cd]">
          <b className="text-[#e9f0f6]">All nine read</b>{" "}
          <code className="rounded bg-[#080e13] px-1.5 py-0.5 font-mono text-[12px] text-[#2dd4bf]">
            /api/os/snapshot
          </code>{" "}
          — the single source of truth. No frozen data blocks, no drift. What Home shows, the
          cockpits show, the client sees. Identical numbers, always.
        </p>
        <p className="mt-1.5 text-[13px] leading-6 text-[#b6c2cd]">
          <span aria-hidden>🔒</span> <b className="text-[#e9f0f6]">= leadership-gated</b>{" "}
          {leadership
            ? "(you are in a leadership view, so these read through)."
            : "(in your default POV; use View-As to enter any desk)."}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {desks.map(({ desk, headline, status, health }) => (
          <section
            key={desk.key}
            aria-label={desk.label}
            className="overflow-hidden rounded-2xl border border-[#20313c] bg-[#0b1319]"
          >
            <div aria-hidden className="h-[3px] w-full" style={{ background: desk.accent }} />
            <div className="p-5">
              <p aria-hidden className="text-[22px] leading-none">{desk.icon}</p>
              <h3 className="mt-3 text-[17px] font-black tracking-tight text-[#e9f0f6]">
                {desk.label}
                {desk.gated && <span aria-label="leadership-gated" title="Leadership-gated"> 🔒</span>}
              </h3>
              <p className="mt-1 text-[13px] text-[#8b9aa8]">{desk.dimensions}</p>

              <p className={`mt-5 text-[13px] font-extrabold ${status ? STATUS_TEXT[status] : "text-[#6f8491]"}`}>
                {headline ?? (
                  <span className="font-semibold text-[#6f8491]">
                    {health == null ? "not in the snapshot yet" : `health ${health}`}
                  </span>
                )}
              </p>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
