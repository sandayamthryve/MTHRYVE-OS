// components/tony/cognitive/palette.ts — client-safe visual mapping for the
// TCVE graph. No server imports; pure look-up tables keyed off the real node
// type + status so color communicates MEANING (type) and health (status),
// never a fabricated value. Hues stay within the Mthryve OS dark/teal system
// (see tailwind.config.ts) with a couple of extra accents for node-type variety.

import type { TcveNodeType, TcveStatus, TcveNode } from "@/lib/tony/graph-types";

// Base fill per node type (what the thing IS).
export const TYPE_COLOR: Record<TcveNodeType, string> = {
  brain: "#5FD8CF", // teal-300 — Tony, the center
  agent: "#4BC0B8", // teal-400 — Tony's agents/skills
  department: "#7FA8B8", // steel — org structure
  brand: "#4CAF6D", // green — clients / GMV
  pod: "#6BC98A", // green-400 — growth pods
  workflow: "#8C9EFF", // indigo — automations
  knowledge_hub: "#D4A94B", // gold — knowledge corpus
  knowledge: "#C9A24B", // gold (dimmer) — individual docs
  approval: "#E0BD6E", // gold-400 — approvals awaiting a decision
  kpi: "#5FD8CF", // teal-300 — org KPIs
};

// Status → the outer glow ring color (health signal).
export const STATUS_RING: Record<TcveStatus, string> = {
  active: "#4CAF6D", // green
  attention: "#E8A13C", // amber
  alert: "#E5484D", // red
  idle: "#63727A", // ink-dim
  muted: "#3A464C", // near-border, "nothing to report"
};

export const STATUS_LABEL: Record<TcveStatus, string> = {
  active: "Active",
  attention: "Attention",
  alert: "Alert",
  idle: "Idle",
  muted: "No data yet",
};

// Base radius (graph units) per node type — Tony dominates, hubs are large.
export const TYPE_RADIUS: Record<TcveNodeType, number> = {
  brain: 26,
  agent: 11,
  department: 13,
  brand: 8,
  pod: 11,
  workflow: 9,
  knowledge_hub: 13,
  knowledge: 5,
  approval: 9,
  kpi: 8,
};

export const TYPE_LABEL: Record<TcveNodeType, string> = {
  brain: "Executive Brain",
  agent: "Agent",
  department: "Department",
  brand: "Brand / Client",
  pod: "Growth Pod",
  workflow: "Workflow",
  knowledge_hub: "Knowledge Base",
  knowledge: "Document",
  approval: "Approval",
  kpi: "KPI",
};

// A short glyph drawn inside larger nodes (canvas text — emoji-free for crisp
// rendering across platforms).
export const TYPE_GLYPH: Partial<Record<TcveNodeType, string>> = {
  brain: "T",
  department: "D",
  knowledge_hub: "K",
  pod: "P",
};

// Node type ordering for the legend.
export const LEGEND_TYPES: TcveNodeType[] = [
  "brain",
  "agent",
  "department",
  "brand",
  "pod",
  "workflow",
  "knowledge_hub",
  "approval",
  "kpi",
];

// Hex → rgba with an explicit alpha, for glow/fade layers.
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function nodeColor(node: Pick<TcveNode, "type">): string {
  return TYPE_COLOR[node.type] ?? "#4BC0B8";
}
export function nodeRadius(node: Pick<TcveNode, "type">): number {
  return TYPE_RADIUS[node.type] ?? 7;
}
