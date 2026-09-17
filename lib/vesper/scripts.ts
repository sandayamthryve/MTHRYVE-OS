// lib/vesper/scripts.ts — the script-brief builder behind the generate_scripts
// play. It reuses the content engine's creative guides (pillars + formats) to
// assemble a grounded, ready-to-shoot brief per SKU × pillar × format.
//
// It is DELIBERATELY deterministic — it assembles the authoritative creative
// brief (objective, tone, structure beats, do/don't, hook angles) from
// lib/content/creative-guides rather than calling a model, so the play stays
// spend-free and side-effect-free. The staged content_items ideas carry the
// full brief, ready for a human to open in Creative Studio and generate the
// final copy through the existing generation path.

import {
  resolvePillar,
  resolveFormat,
  type ContentPillar,
  type ContentFormat,
} from "@/lib/content/creative-guides";

export interface ScriptBriefInput {
  productName: string; // resolved SKU / product name, or a placeholder
  pillar?: string;
  format?: string;
  brandName?: string | null;
}

export interface ScriptBrief {
  title: string;
  pillarKey: string | null;
  pillarLabel: string | null;
  formatKey: string | null;
  formatLabel: string | null;
  hookAngles: string[];
  brief: string; // the full text brief stored on the content_items row
}

// Three hook angles derived from the pillar's objective + dos. Deterministic and
// honest — they're framings, never invented product claims.
function hookAngles(product: string, pillar: ContentPillar | null): string[] {
  if (!pillar) {
    return [
      `Open native to the feed on ${product} — no hard sell.`,
      `Lead with something the viewer recognises, then bring in ${product}.`,
      `Show ${product} in a real moment; let it earn attention.`,
    ];
  }
  return pillar.dos.slice(0, 3).map((d) => `${d} — anchored on ${product}.`);
}

export function buildScriptBrief(input: ScriptBriefInput): ScriptBrief {
  const pillar = resolvePillar(input.pillar);
  const format = resolveFormat(input.format);
  const product = input.productName?.trim() || "the product";
  const brandTag = input.brandName ? ` · ${input.brandName}` : "";

  const angles = hookAngles(product, pillar);

  const lines: string[] = [];
  lines.push(`Script brief — ${product}${brandTag}`);
  if (pillar) {
    lines.push("");
    lines.push(`PILLAR: ${pillar.label}`);
    lines.push(`Objective: ${pillar.objective}`);
    lines.push(`Tone: ${pillar.tone}`);
    lines.push(`DO: ${pillar.dos.join("; ")}.`);
    lines.push(`DON'T: ${pillar.donts.join("; ")}.`);
  } else {
    lines.push("");
    lines.push("PILLAR: none — keep it neutral and platform-native; do NOT default to a hard sell.");
  }
  if (format) {
    lines.push("");
    lines.push(`FORMAT: ${format.label}`);
    lines.push(`Structure: ${format.structure}`);
    lines.push(format.note);
  }
  lines.push("");
  lines.push("HOOK ANGLES:");
  angles.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  lines.push("");
  lines.push(
    "Ground every hook, line and CTA in the real product and its category. Do NOT invent claims, features, prices, or numbers. Open in Creative Studio to generate the final copy."
  );

  const pillarLabel = pillar ? pillar.label : "No pillar";
  const formatLabel = format ? format.label : "Any format";
  const title = `${product} — ${pillarLabel} / ${formatLabel}`;

  return {
    title,
    pillarKey: pillar?.key ?? null,
    pillarLabel: pillar?.label ?? null,
    formatKey: format?.key ?? null,
    formatLabel: format?.label ?? null,
    hookAngles: angles,
    brief: lines.join("\n"),
  };
}

// Build one brief per (pillar × format) requested for a product. When no pillars
// / formats are given, produce a single neutral brief so the play always yields
// something usable.
export function buildScriptBriefs(
  product: string,
  brandName: string | null,
  pillars: string[],
  formats: string[]
): ScriptBrief[] {
  const ps = pillars.length ? pillars : [""];
  const fs = formats.length ? formats : [""];
  const out: ScriptBrief[] = [];
  for (const p of ps) {
    for (const f of fs) {
      out.push(buildScriptBrief({ productName: product, pillar: p, format: f, brandName }));
    }
  }
  return out;
}
