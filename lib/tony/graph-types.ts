// lib/tony/graph-types.ts — the shared contract for the Tony Cognitive
// Visualization Engine (TCVE) graph.
//
// These types cross the server/client boundary: lib/tony/graph.ts (server-only,
// runs the org-scoped RLS reads) produces a TcveGraph, and
// components/tony/cognitive/* (client) render it with react-force-graph-2d.
// Keeping the shape here — with NO server imports — lets the client island
// import it without dragging the Supabase client into the bundle.
//
// GROUNDING CONTRACT: every field is derived from a REAL row read through the
// caller's RLS-scoped client. A value that has no real source is `null` and the
// UI renders it as an em dash ("—"). Nothing here fabricates a figure. Only the
// visual (orbit/pulse/edge energy) animates — never a number.

// The node "kinds" that make up the living enterprise graph. `brain` is Tony
// himself (the fixed center); `knowledge_hub` is a synthetic cluster parent used
// for progressive disclosure (its document children stay hidden until expanded).
export type TcveNodeType =
  | "brain"
  | "agent"
  | "department"
  | "brand"
  | "pod"
  | "workflow"
  | "knowledge"
  | "knowledge_hub"
  | "approval"
  | "kpi";

// Health/attention signal. Drives node color; derived from real status columns
// and recency, never invented. `muted` = a real row with nothing to report yet.
export type TcveStatus = "active" | "attention" | "alert" | "idle" | "muted";

// One labelled figure shown in a node's drill-down panel. `value` is
// pre-formatted; `null` renders as "—" (an honest "no data yet").
export interface TcveStat {
  label: string;
  value: string | null;
}

export interface TcveNode {
  // Namespaced, stable id: e.g. "brand:<uuid>", "dept:<uuid>", "tony".
  id: string;
  type: TcveNodeType;
  label: string; // the real name ("EcomSmart", "Acme Co")
  sublabel: string | null; // secondary line (category / domain / role)
  status: TcveStatus;
  owner: string | null; // real owner/lead name, or null → "—"
  stats: TcveStat[]; // real KPIs for the drill-down panel
  href: string | null; // the actual OS page this node opens, or null
  // Progressive disclosure: a node whose `parentId` points at a collapsible
  // parent stays hidden until that parent is expanded. Tony, agents,
  // departments and hubs are always visible.
  parentId: string | null;
  collapsible: boolean; // true → clicking toggles its children
  hiddenByDefault: boolean; // true → hidden until its parent is expanded
  active: boolean; // recent real activity → the node glows
  // Small bag of extra real fields the panel/trace may surface (all real or null).
  meta: Record<string, string | number | boolean | null>;
}

// Edge "kinds" mirror the real relationships assembled from FKs / membership
// tables. `animated` edges carry a subtle energy-flow (Tony ↔ his agents,
// live approvals, running workflows).
export type TcveEdgeKind =
  | "orchestrates" // tony ↔ agent
  | "structure" // tony ↔ department, department ↔ brand
  | "assignment" // pod ↔ brand
  | "knowledge" // knowledge hub ↔ doc, doc ↔ department
  | "approval" // tony ↔ pending approval
  | "workflow" // tony ↔ automation
  | "kpi"; // tony ↔ org KPI

export interface TcveEdge {
  id: string;
  source: string; // node id
  target: string; // node id
  kind: TcveEdgeKind;
  label: string | null;
  animated: boolean;
}

// One stage of Tony's REAL request pipeline (the Anthropic agentic tool-use loop
// in app/api/assistant/route.ts). `detail` is real, caller-scoped info the stage
// exposes today (e.g. "10 documents · 533 chunks indexed"), or null where a
// stage has nothing concrete to show. `status`:
//   ready       — always runs
//   conditional — runs only for some inputs (fast-path skips tools; RAG only if
//                 docs exist)
//   gated       — role/approval gated (writes → self-scoped or queued proposal)
export interface TcvePipelineStage {
  key: string;
  title: string;
  description: string;
  detail: string | null;
  status: "ready" | "conditional" | "gated";
}

export interface TcveGraph {
  nodes: TcveNode[];
  edges: TcveEdge[];
  pipeline: TcvePipelineStage[];
  meta: {
    orgName: string | null;
    generatedAt: string; // ISO
    role: string;
    isLeadership: boolean;
    centerId: string; // the pinned center node id ("tony")
    counts: Record<string, number>; // node counts per type (real)
  };
}
