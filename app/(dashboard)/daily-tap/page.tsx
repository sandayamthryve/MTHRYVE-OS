import { AppShell } from "@/components/layout/AppShell";
import { Card, PageHeader, Badge, type BadgeTone } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readTodaysTap, readRecentTaps, type TapRecord } from "@/lib/daily-tap/read";
import { tapLink, TIER_LABEL } from "@/lib/daily-tap/types";
import { todayManila } from "@/lib/metrics/windows";
import { TapBriefLink } from "@/components/daily-tap/TapBriefLink";

// Daily Tap — the in-app inbox for a person's morning brief. It reads the
// recorded daily_taps rows through the AUTHED client, so the table's self-only
// READ policy enforces self-only in the database (the query is still scoped to
// the VERIFIED session user, never request input). Today's tap is shown in full
// with its one call-to-action; opening the brief from here marks the tap acted
// and stops the in-app snooze nudges.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

const TIER_TONE: Record<string, BadgeTone> = {
  leadership: "violet",
  head: "teal",
  staff: "muted",
};

function fmtDate(day: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(`${day}T00:00:00+08:00`));
  } catch {
    return day;
  }
}

function fmtShort(day: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
    }).format(new Date(`${day}T00:00:00+08:00`));
  } catch {
    return day;
  }
}

export default async function DailyTapPage() {
  const profile = await requireProfile();
  const db = createServerSupabaseClient() as unknown as Shim;
  const today = todayManila();

  const [todays, recent] = await Promise.all([
    readTodaysTap(db, profile.id, profile.org_id, today),
    readRecentTaps(db, profile.id, profile.org_id, 14),
  ]);

  const link = todays ? tapLink(todays.tier) : null;
  const history = recent.filter((r) => r.tap_date !== today);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Daily Tap"]} profile={profile}>
      <PageHeader title="Daily Tap" />

      {/* Today's tap */}
      <section className="mb-8">
        {todays ? (
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">{fmtDate(todays.tap_date)}</span>
              <Badge tone={TIER_TONE[todays.tier] ?? "muted"}>{TIER_LABEL[todays.tier]}</Badge>
              {todays.ai_used && <Badge tone="violet">AI synthesis</Badge>}
              {todays.acted_at ? (
                <Badge tone="teal">Acted ✓</Badge>
              ) : todays.snooze_count > 0 ? (
                <Badge tone="amber">Nudged {todays.snooze_count}/3</Badge>
              ) : null}
              {todays.status === "failed" && <Badge tone="red">Delivery failed</Badge>}
            </div>

            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
              {todays.summary ?? "No summary recorded."}
            </p>

            {link && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <TapBriefLink href={link.href} label={link.label} tone="primary" />
                {todays.acted_at && (
                  <span className="text-xs text-ink-dim">
                    You acted on today's tap — nudges are off.
                  </span>
                )}
              </div>
            )}

            {todays.channels.length > 0 && (
              <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                Delivered · {todays.channels.join(" · ")}
              </p>
            )}
          </Card>
        ) : (
          <Card>
            <p className="text-sm text-ink-muted">
              No tap yet today. Your morning brief lands around 10 AM — grounded in the day's real
              numbers.
            </p>
          </Card>
        )}
      </section>

      {/* History */}
      {history.length > 0 && (
        <section>
          <h2 className="mb-3 font-mono text-[11px] uppercase tracking-wider text-ink-dim">
            Earlier taps
          </h2>
          <div className="flex flex-col gap-2">
            {history.map((r: TapRecord) => (
              <Card key={r.id} className="p-4">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{fmtShort(r.tap_date)}</span>
                  <Badge tone={TIER_TONE[r.tier] ?? "muted"}>{TIER_LABEL[r.tier]}</Badge>
                  {r.ai_used && <Badge tone="violet">AI</Badge>}
                  {r.acted_at ? <Badge tone="teal">Acted</Badge> : <Badge tone="muted">No action</Badge>}
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-dim">
                  {r.summary ?? "—"}
                </p>
              </Card>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}
