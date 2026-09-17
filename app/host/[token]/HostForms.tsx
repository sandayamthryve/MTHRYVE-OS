"use client";

import { useRef, useState } from "react";
import type { PortalMode, AssignedTask } from "@/lib/contributors/tokens";

// The write-only forms for the public /host/<token> page. Each block POSTs to
// /api/host/<token> (multipart) where the token is re-validated and the write is
// scoped to the contributor derived from it — this component never sends any id.
//
// Photos are downscaled in the browser (canvas → JPEG) before upload so a phone
// snap stays well under the serverless body limit and uploads fast on mobile
// data. A failed read never blocks the submit: the moderator can still read the
// evidence photo by hand.

type Status =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "ok"; message: string }
  | { state: "error"; message: string };

const IDLE: Status = { state: "idle" };

// Downscale to a max edge and re-encode as JPEG. Falls back to the original file
// if anything about the canvas path fails (e.g. an exotic format) so a submit is
// never lost to a client-side hiccup.
async function downscale(file: File, maxEdge = 1400, quality = 0.82): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    return blob ?? file;
  } catch {
    return file;
  }
}

async function postForm(token: string, body: FormData): Promise<Status> {
  try {
    const res = await fetch(`/api/host/${encodeURIComponent(token)}`, {
      method: "POST",
      body,
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      error?: string;
    };
    if (res.ok && data.ok) {
      return { state: "ok", message: data.message ?? "Saved." };
    }
    return { state: "error", message: data.error ?? "Couldn't submit — please try again." };
  } catch {
    return { state: "error", message: "Network error — please try again." };
  }
}

function StatusLine({ status }: { status: Status }) {
  if (status.state === "ok")
    return <p className="mt-2 text-sm font-medium text-teal-300">✓ {status.message}</p>;
  if (status.state === "error")
    return <p className="mt-2 text-sm font-medium text-red-300">{status.message}</p>;
  return null;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
      {children}
    </section>
  );
}

export function HostForms({
  token,
  mode,
  tasks,
}: {
  token: string;
  mode: PortalMode;
  tasks: AssignedTask[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <SelfieClockIn token={token} />
      <TaskLog token={token} mode={mode} tasks={tasks} />
      {/* Live hosts keep the results snap → moderator promotion to live_sessions. */}
      {mode === "live" && <SnapToData token={token} />}
    </div>
  );
}

// Per-department copy for the daily-work log. The department (or kind) decides
// what the contributor is prompted to record — the endpoint accepts the same
// fields for every mode; only the labels and which extras show change.
const LOG_COPY: Record<
  PortalMode,
  { heading: string; outputsLabel: string; outputsPlaceholder: string; showLinks: boolean }
> = {
  live: {
    heading: "Log today's live work",
    outputsLabel: "What you did on stream",
    outputsPlaceholder: "e.g. 6–8pm live for Brand X — pushed the serum bundle, 3 flash deals.",
    showLinks: false,
  },
  creative: {
    heading: "Log today's creative output",
    outputsLabel: "Assets produced",
    outputsPlaceholder: "e.g. 3 reels edited, 5 product graphics, 1 thumbnail set.",
    showLinks: true,
  },
  ecommerce: {
    heading: "Log today's e-commerce work",
    outputsLabel: "Listings / orders handled",
    outputsPlaceholder: "e.g. 12 listings updated, 40 orders processed, 3 returns resolved.",
    showLinks: true,
  },
  general: {
    heading: "Log today's work",
    outputsLabel: "What you completed today",
    outputsPlaceholder: "The outputs you produced today — be specific.",
    showLinks: false,
  },
};

// 1) Selfie clock-in — a phone camera capture, uploaded as the day's clock-in.
function SelfieClockIn({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>(IDLE);
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setStatus({ state: "busy" });
    const blob = await downscale(file, 1000, 0.8);
    const body = new FormData();
    body.set("action", "clock_in");
    body.set("image", blob, "selfie.jpg");
    setStatus(await postForm(token, body));
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">1 · Selfie clock-in</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Take a quick selfie to clock in for today. Your team reviews it as your
        attendance.
      </p>
      {preview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt="Selfie preview"
          className="mt-3 h-32 w-32 rounded-lg object-cover ring-1 ring-charcoal-700"
        />
      )}
      <label className="mt-3 block">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="user"
          onChange={onPick}
          disabled={status.state === "busy"}
          className="hidden"
        />
        <span
          className={`inline-flex cursor-pointer items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold ${
            status.state === "busy"
              ? "bg-charcoal-800 text-ink-dim"
              : "bg-teal-500 text-charcoal-950 hover:bg-teal-400"
          }`}
        >
          {status.state === "busy" ? "Uploading…" : status.state === "ok" ? "Re-take selfie" : "Take selfie & clock in"}
        </span>
      </label>
      <StatusLine status={status} />
    </Card>
  );
}

// 2) Daily work log — the contributor's OPEN assigned tasks (read-only, each with
// a confirm control) plus a per-department outputs/blockers form. Submitting POSTs
// action=log_work → a daily_reports row + daily_report_tasks(confirmed) scoped to
// the contributor's own department, so it lands on that department's dashboard.
function TaskLog({
  token,
  mode,
  tasks,
}: {
  token: string;
  mode: PortalMode;
  tasks: AssignedTask[];
}) {
  const copy = LOG_COPY[mode];
  const [status, setStatus] = useState<Status>(IDLE);
  const [outputs, setOutputs] = useState("");
  const [summary, setSummary] = useState("");
  const [blockers, setBlockers] = useState("");
  const [links, setLinks] = useState("");
  // Assigned tasks default to confirmed — the common case is "I did my tasks".
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>(
    () => Object.fromEntries(tasks.map((t) => [t.id, true]))
  );

  const toggle = (id: string) =>
    setConfirmed((c) => ({ ...c, [id]: !c[id] }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const anyConfirmed = tasks.some((t) => confirmed[t.id]);
    if (!outputs.trim() && !summary.trim() && !anyConfirmed) {
      setStatus({ state: "error", message: "Add what you worked on, or confirm a task, first." });
      return;
    }
    setStatus({ state: "busy" });
    const body = new FormData();
    body.set("action", "log_work");
    body.set("outputs", outputs.trim());
    body.set("summary", summary.trim());
    body.set("blockers", blockers.trim());
    if (copy.showLinks) body.set("evidence_links", links.trim());
    for (const t of tasks) if (confirmed[t.id]) body.append("task_ids", t.id);
    setStatus(await postForm(token, body));
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">2 · {copy.heading}</h2>

      {/* Your task today — read-only, assigned by your lead. Confirm what you did. */}
      {tasks.length > 0 ? (
        <div className="mt-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
            Your tasks today
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {tasks.map((t) => (
              <li key={t.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-charcoal-700/60 bg-charcoal-950 p-2.5">
                  <input
                    type="checkbox"
                    checked={!!confirmed[t.id]}
                    onChange={() => toggle(t.id)}
                    className="mt-0.5 h-4 w-4 accent-teal-500"
                  />
                  <span className="flex-1">
                    <span className="block text-sm text-ink">{t.title}</span>
                    {t.due_date && (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                        due {t.due_date}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-dim">
            Tick the tasks you worked on — confirming them logs your progress to the team.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-ink-muted">
          No tasks assigned yet. You can still log today's outputs below.
        </p>
      )}

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
        <label className="block text-[11px] text-ink-muted">
          {copy.outputsLabel}
          <textarea
            value={outputs}
            onChange={(e) => setOutputs(e.target.value)}
            rows={3}
            maxLength={8000}
            placeholder={copy.outputsPlaceholder}
            className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink placeholder:text-ink-dim"
          />
        </label>

        {copy.showLinks && (
          <label className="block text-[11px] text-ink-muted">
            Links (one per line)
            <textarea
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              rows={2}
              placeholder={"https://drive.google.com/…\nhttps://…"}
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink placeholder:text-ink-dim"
            />
          </label>
        )}

        <label className="block text-[11px] text-ink-muted">
          Blockers (optional)
          <input
            value={blockers}
            onChange={(e) => setBlockers(e.target.value)}
            maxLength={4000}
            placeholder="Anything holding you back?"
            className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink placeholder:text-ink-dim"
          />
        </label>

        <button
          type="submit"
          disabled={status.state === "busy"}
          className="self-start rounded-md bg-charcoal-800 px-4 py-2 text-sm font-semibold text-teal-300 hover:bg-charcoal-700 disabled:opacity-60"
        >
          {status.state === "busy" ? "Submitting…" : "Submit today's log"}
        </button>
      </form>
      <StatusLine status={status} />
    </Card>
  );
}

// 3) Snap-to-Data — a photo of the live-results screen. The server reads only
// viewers / gmv / ctor off it; everything stays unverified until review.
function SnapToData({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>(IDLE);
  const [preview, setPreview] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await submitFileWithValues(file);
  }

  // Upload the snap and surface the read numbers (viewers/gmv/ctor) back to the
  // host so they can see what was captured before it goes to review.
  async function submitFileWithValues(file: File) {
    setPreview(URL.createObjectURL(file));
    setValues(null);
    setStatus({ state: "busy" });
    const blob = await downscale(file, 1400, 0.82);
    const body = new FormData();
    body.set("action", "snap");
    body.set("image", blob, "results.jpg");
    try {
      const res = await fetch(`/api/host/${encodeURIComponent(token)}`, { method: "POST", body });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
        values?: Record<string, unknown>;
      };
      if (res.ok && data.ok) {
        setStatus({ state: "ok", message: data.message ?? "Submitted." });
        setValues(data.values ?? {});
      } else {
        setStatus({ state: "error", message: data.error ?? "Couldn't submit — please try again." });
      }
    } catch {
      setStatus({ state: "error", message: "Network error — please try again." });
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  const read = values ? Object.entries(values).filter(([, v]) => v != null && v !== "") : [];

  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">3 · Snap live results</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Photograph or upload your live-results screen. We read the viewers, GMV and
        CTOR for the team to verify — the photo is your proof.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void submitFileWithValues(file);
        }}
        onClick={() => inputRef.current?.click()}
        className={`mt-3 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
          dragging ? "border-teal-500 bg-teal-500/5" : "border-charcoal-700 hover:border-charcoal-600"
        }`}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Results preview" className="max-h-40 rounded-md object-contain" />
        ) : (
          <>
            <span className="text-sm text-ink-muted">Tap to snap or drop a screenshot</span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
              viewers · gmv · ctor
            </span>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPick}
          className="hidden"
        />
      </div>

      {status.state === "busy" && <p className="mt-2 text-sm text-ink-muted">Reading the photo…</p>}
      <StatusLine status={status} />

      {read.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {read.map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-full border border-teal-500/40 bg-teal-500/10 px-2.5 py-1 font-mono text-[11px] text-teal-300"
            >
              <span className="uppercase tracking-wider">{k}</span>
              <span className="text-ink">{String(v)}</span>
            </span>
          ))}
        </div>
      )}
      {status.state === "ok" && read.length === 0 && (
        <p className="mt-2 text-xs text-ink-muted">
          Saved. We couldn't auto-read the numbers, but the team will read them from
          your photo.
        </p>
      )}
    </Card>
  );
}
