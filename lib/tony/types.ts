// lib/tony/types.ts — the shared node contract for the Tony Command View.
//
// These types cross the server/client boundary: lib/tony/nodes.ts (server-only,
// runs the org-scoped queries) produces TonyNode[], and components/tony/* (client)
// renders them. Keeping the shape here — with NO server imports — lets the client
// island import it without dragging the Supabase client into the bundle.
//
// GROUNDING CONTRACT: `metric` is the ONE real number a node displays, already
// formatted, or null for an honest "no data yet". The client animates only the
// visual (orbit/pulse) and NEVER the number. `recencyMs` feeds pulse speed only.

export type NodeStatus = "green" | "amber" | "red" | "muted";

export interface NodeStat {
  label: string;
  value: string; // pre-formatted; "—" for a missing figure
}

export interface TonyNode {
  id: string;
  label: string; // "Commerce"
  domain: string; // "EcomSmart" — the system/product name under the label
  metric: string | null; // the ONE live number, formatted; null => no data yet
  metricNote: string | null; // what the number is, e.g. "MTD GMV"
  status: NodeStatus;
  href: string | null; // route into the detailed view, or null (panel-only)
  actionLabel: string | null; // primary action label for the panel
  stats: NodeStat[]; // key numbers shown in the side panel
  brief: string | null; // latest grounded AI briefing text, or null
  briefMeta: string | null; // "model · confidence · when", or null
  hint: string | null; // short status / empty-state line
  recencyMs: number | null; // age of the freshest signal (ms); pulse speed only
}

export interface TonyView {
  nodes: TonyNode[];
  asOf: string | null; // ISO of the freshest commerce signal (freshness stamp)
  freshnessSource: "sync" | "metrics" | null;
  nowIso: string;
  windowLabel: string; // e.g. "MTD"
}
