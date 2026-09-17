"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, SectionCard } from "@/components/ui";
import {
  createPod,
  updatePod,
  assignBrand,
  unassignBrand,
  type PodActionResult,
} from "@/app/(dashboard)/pods/actions";
import { PodPnlStrip, PodPnlSummary, type PodPnl } from "@/components/pods/PodPnl";

export interface PodBrandLite {
  id: string;
  name: string;
}
export interface PodView {
  id: string;
  name: string;
  leadUserId: string | null;
  leadName: string | null;
  targetBrands: number | null;
  status: string;
  brands: PodBrandLite[];
}
export interface UserLite {
  id: string;
  name: string;
}

const inputCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-dim";
const btnCls =
  "rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60";
const ghostBtn =
  "rounded-md border border-charcoal-700 px-2 py-1 text-xs text-ink-muted hover:bg-charcoal-800";

function statusTone(status: string): "teal" | "amber" | "muted" {
  return status === "active" ? "teal" : status === "paused" ? "amber" : "muted";
}

export function PodsManager({
  pods,
  brands,
  users,
  canManage,
  pnl,
  pnlTotal,
}: {
  pods: PodView[];
  brands: PodBrandLite[];
  users: UserLite[];
  canManage: boolean;
  // Finance-sensitive P&L, present only for leadership (ceo/coo). Keyed by pod id;
  // pnlTotal is the summary across the currently visible pods.
  pnl?: Record<string, PodPnl>;
  pnlTotal?: PodPnl;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<PodActionResult>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else router.refresh();
    });
  }

  function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    run(async () => {
      const res = await createPod(fd);
      if (res.ok) form.reset();
      return res;
    });
  }

  return (
    <div className="space-y-6">
      {pnlTotal && pods.length > 0 && (
        <PodPnlSummary total={pnlTotal} podCount={pods.length} />
      )}

      {!canManage && (
        <Card className="border-amber-500/30">
          <p className="text-sm text-ink-muted">
            You have read-only access. Creating pods and assigning brands is limited to leadership
            (CEO / COO / department head).
          </p>
        </Card>
      )}

      {error && (
        <Card className="border-red-500/40">
          <p className="text-sm text-red-300">{error}</p>
        </Card>
      )}

      {canManage && (
        <SectionCard title="Create a pod">
          <form onSubmit={onCreate} className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
              Name
              <input name="name" required placeholder="e.g. Pod Alpha" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
              Pod lead
              <select name="lead_user_id" defaultValue="" className={inputCls}>
                <option value="">— Unassigned —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
              Target brands
              <input
                name="target_brands"
                type="number"
                min={0}
                placeholder="e.g. 5"
                className={inputCls}
              />
            </label>
            <div className="flex items-end">
              <button type="submit" disabled={pending} className={btnCls}>
                {pending ? "Saving…" : "Create pod"}
              </button>
            </div>
            <label className="flex flex-col gap-1 text-[11px] text-ink-muted md:col-span-2 lg:col-span-4">
              Notes (optional)
              <input name="notes" placeholder="Charter, focus, anything worth recording" className={inputCls} />
            </label>
          </form>
        </SectionCard>
      )}

      {pods.length === 0 ? (
        <SectionCard title="No pods yet">
          <p className="text-sm text-ink-muted">
            {canManage
              ? "Create your first pod above, then assign brands to it."
              : "No pods have been created yet."}
          </p>
        </SectionCard>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {pods.map((pod) => (
            <PodCard
              key={pod.id}
              pod={pod}
              brands={brands}
              users={users}
              canManage={canManage}
              pending={pending}
              run={run}
              pnl={pnl?.[pod.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PodCard({
  pod,
  brands,
  users,
  canManage,
  pending,
  run,
  pnl,
}: {
  pod: PodView;
  brands: PodBrandLite[];
  users: UserLite[];
  canManage: boolean;
  pending: boolean;
  run: (fn: () => Promise<PodActionResult>) => void;
  pnl?: PodPnl;
}) {
  const assignedIds = new Set(pod.brands.map((b) => b.id));
  const available = brands.filter((b) => !assignedIds.has(b.id));
  const [addBrand, setAddBrand] = useState("");
  const overTarget = pod.targetBrands != null && pod.brands.length > pod.targetBrands;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{pod.name}</h3>
            <Badge tone={statusTone(pod.status)}>{pod.status}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">
            Lead: <span className="text-ink">{pod.leadName ?? "—"}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-bold text-ink">
            {pod.brands.length}
            {pod.targetBrands != null ? (
              <span className="text-ink-dim">/{pod.targetBrands}</span>
            ) : null}
          </p>
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            brands{pod.targetBrands != null ? " / target" : ""}
          </p>
        </div>
      </div>

      {pnl && <PodPnlStrip pnl={pnl} />}

      {overTarget && (
        <p className="mb-2 text-[11px] text-amber-300">Over target by {pod.brands.length - (pod.targetBrands ?? 0)}.</p>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {pod.brands.length === 0 ? (
          <span className="text-xs text-ink-dim">No brands assigned yet.</span>
        ) : (
          pod.brands.map((b) => (
            <span
              key={b.id}
              className="inline-flex items-center gap-1 rounded-full border border-charcoal-700 bg-charcoal-800 px-2 py-0.5 text-xs text-ink"
            >
              {b.name}
              {canManage && (
                <button
                  aria-label={`Remove ${b.name}`}
                  disabled={pending}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("pod_id", pod.id);
                    fd.set("brand_id", b.id);
                    run(() => unassignBrand(fd));
                  }}
                  className="text-ink-dim hover:text-red-300"
                >
                  ×
                </button>
              )}
            </span>
          ))
        )}
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2 border-t border-charcoal-700/60 pt-3">
          <select
            value={addBrand}
            onChange={(e) => setAddBrand(e.target.value)}
            className={`${inputCls} min-w-[10rem]`}
            disabled={available.length === 0}
          >
            <option value="">{available.length ? "Add a brand…" : "All brands assigned"}</option>
            {available.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            disabled={pending || !addBrand}
            className={ghostBtn}
            onClick={() => {
              if (!addBrand) return;
              const fd = new FormData();
              fd.set("pod_id", pod.id);
              fd.set("brand_id", addBrand);
              setAddBrand("");
              run(() => assignBrand(fd));
            }}
          >
            Assign
          </button>

          <PodLeadEditor pod={pod} users={users} pending={pending} run={run} />
        </div>
      )}
    </Card>
  );
}

function PodLeadEditor({
  pod,
  users,
  pending,
  run,
}: {
  pod: PodView;
  users: UserLite[];
  pending: boolean;
  run: (fn: () => Promise<PodActionResult>) => void;
}) {
  return (
    <select
      defaultValue={pod.leadUserId ?? ""}
      disabled={pending}
      className={`${inputCls} min-w-[9rem]`}
      onChange={(e) => {
        const fd = new FormData();
        fd.set("pod_id", pod.id);
        fd.set("lead_user_id", e.target.value);
        run(() => updatePod(fd));
      }}
      title="Set pod lead"
    >
      <option value="">Set lead…</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}
