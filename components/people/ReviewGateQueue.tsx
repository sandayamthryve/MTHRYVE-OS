"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { decideActionRequest } from "@/app/(dashboard)/approvals/actions";
import type { ReviewGateItem } from "@/lib/people/review-gate";

// The HR Review Gate — the People page.
//
// One queue for every consequential agent action that touches a person, each
// card carrying a preview of what approving would DO plus an Approve / Request
// changes tap. "Request changes" is a rejection with a reason: the server action
// records the decision and the reason lands on the audit trail, exactly as it
// does on /approvals. Nothing here re-implements the gating — decideActionRequest
// re-checks the caller against RLS, so these buttons are purely the surface.

const SYSTEM_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

// The accent bar reads the risk at a glance: critical is red, high is amber,
// everything else is the OS teal.
function accentFor(item: ReviewGateItem): string {
  if (!item.reversible || item.riskTier >= 4) return "#f26d6d";
  if (item.riskTier === 3) return "#f5b942";
  return "#2dd4bf";
}

function LiveClock() {
  const [time, setTime] = useState("");
  useEffect(() => {
    const update = () =>
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span>{time || "--:--:--"}</span>;
}

function waitedFor(iso: string): string {
  const hours = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h waiting`;
  return `${Math.round(hours / 24)}d waiting`;
}

function Pill({ children, tone = "teal" }: { children: React.ReactNode; tone?: "teal" | "muted" }) {
  return (
    <span
      className={
        tone === "teal"
          ? "inline-flex items-center rounded-full border border-[#2dd4bf]/45 bg-[#2dd4bf]/[.08] px-[9px] py-[3px] text-[11px] font-bold tracking-[.2px] text-[#7fe3d6]"
          : "inline-flex items-center rounded-full border border-[#2a3945] bg-[#17222a] px-[9px] py-[3px] text-[11px] font-bold tracking-[.2px] text-[#8b9aa8]"
      }
    >
      {children}
    </span>
  );
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-[5px] font-mono text-[10px] font-bold uppercase tracking-[.7px] text-[#6c90a7]">
        {title}
      </div>
      <div className="text-[12.5px] leading-[1.5] text-[#8fbac7]">{children}</div>
    </div>
  );
}

type Resolution = { decision: "approved" | "rejected"; note: string };

function GateCard({
  item,
  detailed,
  resolution,
  onResolve,
}: {
  item: ReviewGateItem;
  detailed: boolean;
  resolution: Resolution | null;
  onResolve: (id: string, resolution: Resolution) => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const accent = accentFor(item);

  function decide(decision: "approved" | "rejected") {
    setError(null);
    const reason = note.trim();
    // A rejection must carry a reason — it is what gets recorded on the trail.
    if (decision === "rejected" && !reason) {
      setAsking(true);
      setError("Say what needs to change — the reason is recorded on the trail.");
      return;
    }
    // Dev-channel preview rows are backed by no database row, so the tap
    // resolves here and the server action is never called.
    if (item.preview_only) {
      onResolve(item.id, { decision, note: reason });
      return;
    }
    startTransition(async () => {
      const res = await decideActionRequest(item.id, decision, reason || null, null);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      onResolve(item.id, { decision, note: reason });
      router.refresh();
    });
  }

  if (resolution) {
    const approved = resolution.decision === "approved";
    return (
      <article
        className="rounded-[18px] border border-[#1e2a35] bg-[#111820] p-[16px_18px]"
        style={{ borderLeft: `3px solid ${approved ? "#3ecf8e" : "#8b9aa8"}` }}
      >
        <div className="flex flex-wrap items-center gap-[10px]">
          <span className="text-[14px] font-extrabold text-[#e9f0f6]">{item.title}</span>
          <Pill tone="muted">{approved ? "✔ Approved" : "✎ Changes requested"}</Pill>
        </div>
        <p className="mt-[6px] text-[12.5px] leading-[1.5] text-[#8b9aa8]">
          {approved
            ? item.recommendationOnly
              ? "Approved — acknowledged. This request carried no executor, so nothing ran."
              : "Approved — the OS is executing this action."
            : `Sent back with: “${resolution.note}”`}
          {item.preview_only && " (Preview — nothing was written.)"}
        </p>
      </article>
    );
  }

  return (
    <article
      className="rounded-[18px] border border-[#1e2a35] bg-[#111820] p-[16px_18px] shadow-[inset_0_1px_0_rgba(255,255,255,.035),0_8px_22px_rgba(0,0,0,.26)]"
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      <div className="flex flex-wrap items-center gap-[10px]">
        <h3 className="text-[17px] font-extrabold leading-[1.2] tracking-[-.2px] text-[#e9f0f6]">
          {item.title}
        </h3>
        <Pill>{item.agent}</Pill>
        <Pill tone="muted">{item.riskLabel}</Pill>
        <span className="ml-auto text-[11px] font-bold text-[#6c90a7]">
          {waitedFor(item.createdAt)}
        </span>
      </div>

      <p className="mt-[9px] text-[13px] leading-[1.5] text-[#8b9aa8]">{item.preview}</p>

      <p
        className="mt-[8px] text-[12.5px] font-semibold leading-[1.45]"
        style={{ color: item.reversible ? "#3ecf8e" : "#f5b942" }}
      >
        📈 {item.impact}
      </p>

      {detailed && (
        <div className="mt-[13px] grid gap-[13px] rounded-[12px] border border-[#1e2a35] bg-[#0d141b] p-[13px_14px] sm:grid-cols-2">
          {item.problem && <DetailBlock title="Problem">{item.problem}</DetailBlock>}
          {item.rootCause && <DetailBlock title="Root cause">{item.rootCause}</DetailBlock>}
          {item.evidence.length > 0 && (
            <DetailBlock title="Evidence">
              <ul className="space-y-[3px]">
                {item.evidence.map((fact) => (
                  <li key={fact.label} className="flex justify-between gap-3">
                    <span className="text-[#6c90a7]">{fact.label}</span>
                    <span className="font-bold text-[#e9f0f6]">{fact.value}</span>
                  </li>
                ))}
              </ul>
            </DetailBlock>
          )}
          {item.options.length > 0 && (
            <DetailBlock title="Options weighed">
              <ul className="space-y-[5px]">
                {item.options.map((option) => (
                  <li key={option.label}>
                    <span className="font-bold text-[#e9f0f6]">{option.label}</span> — {option.tradeoff}
                  </li>
                ))}
              </ul>
            </DetailBlock>
          )}
          <div className="sm:col-span-2 flex flex-wrap gap-x-[18px] gap-y-1 border-t border-[#1e2a35] pt-[10px] font-mono text-[10.5px] uppercase tracking-[.5px] text-[#6c90a7]">
            <span>Source · {item.sourceLabel}</span>
            <span>Confidence · {item.confidence}</span>
            <span>{item.reversible ? "Reversible" : "Not reversible"}</span>
            {item.recommendationOnly && <span>Recommendation only · nothing executes</span>}
          </div>
        </div>
      )}

      {!item.canDecide ? (
        <p className="mt-[13px] border-t border-[#1e2a35] pt-[11px] text-[12px] text-[#6c90a7]">
          View only — a cleared approver (CEO / COO) decides this action.
        </p>
      ) : (
        <>
          {asking && (
            <input
              autoFocus
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What needs to change? This is recorded on the trail…"
              disabled={pending}
              className="mt-[12px] w-full rounded-[10px] border border-[#2b3a46] bg-[#0f171d] px-[11px] py-[8px] text-[12.5px] text-[#e9f0f6] outline-none placeholder:text-[#648092] focus:border-[#2dd4bf] disabled:opacity-60"
            />
          )}
          {error && <p className="mt-[8px] text-[12px] text-[#f26d6d]">{error}</p>}
          <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
            <button
              type="button"
              onClick={() => decide("approved")}
              disabled={pending}
              className="inline-flex h-[34px] items-center gap-[6px] rounded-[10px] bg-[#2dd4bf] px-[15px] text-[13px] font-extrabold text-[#03231f] transition hover:bg-[#5ce0d0] disabled:opacity-60"
            >
              ✔ {pending ? "Working…" : item.recommendationOnly ? "Approve" : "Approve"}
            </button>
            <button
              type="button"
              onClick={() => decide("rejected")}
              disabled={pending}
              className="inline-flex h-[34px] items-center gap-[6px] rounded-[10px] border border-[#2a3945] bg-[#17222a] px-[15px] text-[13px] font-bold text-[#c2d2dd] transition hover:border-[#3a4c5a] hover:text-[#e9f0f6] disabled:opacity-60"
            >
              ✎ Request changes
            </button>
          </div>
        </>
      )}
    </article>
  );
}

export function ReviewGateQueue({
  firstName,
  items,
  rosterHref,
  isPreview,
}: {
  firstName: string;
  items: ReviewGateItem[];
  rosterHref: string;
  isPreview: boolean;
}) {
  const [detailed, setDetailed] = useState(false);
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});

  const outstanding = items.filter((item) => !resolved[item.id]).length;

  return (
    <div className="w-full text-[#e9f0f6]" style={{ fontFamily: SYSTEM_FONT }}>
      <div className="flex w-full flex-wrap items-start justify-between gap-x-6 gap-y-3 px-1 pb-[10px] sm:px-4">
        <div className="min-w-0">
          <h1 className="text-[clamp(22px,6vw,32px)] font-extrabold leading-[1.04] tracking-[-.8px]">
            Welcome Back, <span className="font-medium text-[#8b9aa8]">{firstName.toLowerCase()}</span>
          </h1>
          <p className="mt-2 flex items-center gap-[7px] text-[12.5px] font-bold leading-[1.2] tracking-[.25px] text-[#8b9aa8]">
            <span className="text-[13px] leading-none text-[#2dd4bf]">◷</span>
            <LiveClock />
          </p>
        </div>
        <Link
          href={rosterHref}
          className="inline-flex h-[34px] items-center rounded-full border border-[#1e2a35] bg-[#0d141b] px-[14px] text-[12.5px] font-bold text-[#8b9aa8] transition hover:border-[#2dd4bf]/45 hover:text-[#e9f0f6]"
        >
          Open the roster →
        </Link>
      </div>

      <div className="flex justify-end px-1 pb-[14px] pt-[6px] sm:px-4">
        <button
          type="button"
          onClick={() => setDetailed((current) => !current)}
          aria-pressed={detailed}
          className={`inline-flex h-[36px] items-center gap-[7px] rounded-full border px-[16px] text-[13px] font-bold transition ${
            detailed
              ? "border-[#2dd4bf]/45 bg-[#2dd4bf]/[.10] text-[#7fe3d6]"
              : "border-[#1e2a35] bg-[#0d141b] text-[#c2d2dd] hover:text-[#e9f0f6]"
          }`}
        >
          ▤ Detailed View
        </button>
      </div>

      <div className="flex flex-col gap-[14px] px-1 sm:px-4">
        <section
          className="rounded-[14px] border border-[#1e2a35] bg-[#111820] p-[14px_18px]"
          style={{ borderLeft: "3px solid #2dd4bf" }}
        >
          <p className="text-[13px] leading-[1.55] text-[#8b9aa8]">
            🔑 <b className="text-[#e9f0f6]">The crown jewel, reconciled.</b> Today you gate
            outreach, actions (COO→CEO), contributor work, client reports, finance and deletes in{" "}
            <b className="text-[#e9f0f6]">six different places</b>. The final form collapses them
            into <b className="text-[#e9f0f6]">one queue</b>: every consequential agent action shows
            a preview + <b className="text-[#e9f0f6]">Approve / Request changes</b>. Agents act; you
            stay in control.
          </p>
        </section>

        {isPreview && (
          <p className="px-[2px] text-[11.5px] font-bold text-[#f5b942]">
            Dev channel preview — these are sample people-class requests. Deciding one resolves the
            card locally; nothing is written, executed or audited.
          </p>
        )}

        {items.length === 0 ? (
          <section className="rounded-[18px] border border-dashed border-[#1e2a35] bg-[#111820] p-[26px_20px] text-center">
            <div className="text-[15px] font-extrabold text-[#e9f0f6]">The gate is clear</div>
            <p className="mx-auto mt-[7px] max-w-[46ch] text-[12.5px] leading-[1.5] text-[#8b9aa8]">
              No agent action is waiting on a people decision. Anything that touches a person&apos;s
              status lands here the moment it is drafted.
            </p>
            <Link
              href={rosterHref}
              className="mt-[14px] inline-flex h-[32px] items-center rounded-[10px] border border-[#2dd4bf]/35 bg-[#2dd4bf]/[.10] px-[14px] text-[12.5px] font-bold text-[#7fe3d6]"
            >
              Open the roster →
            </Link>
          </section>
        ) : (
          <>
            <div className="px-[2px] text-[11px] font-extrabold uppercase tracking-[1px] text-[#6c90a7]">
              {outstanding} awaiting your decision
            </div>
            {items.map((item) => (
              <GateCard
                key={item.id}
                item={item}
                detailed={detailed}
                resolution={resolved[item.id] ?? null}
                onResolve={(id, resolution) =>
                  setResolved((current) => ({ ...current, [id]: resolution }))
                }
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
