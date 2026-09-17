"use client";

import { useEffect, useRef } from "react";

/* The agent roster — the same nodes, colours, surface archetypes and copy Tony's
   orbit renders (components/tony/TonyNorthStarRuntime.ts). Index 0 is Tony
   himself (the sun); everything after him is a planet in one of his rings. */
export type Agent = { name: string; sub: string; color: number; kind: string; hasRing: boolean; desc: string };

export const AGENTS: Agent[] = [
  { name: "Tony", sub: "ORCHESTRATOR", color: 0xf5b942, kind: "sun", hasRing: false, desc: "Tony — the orchestrator at the centre of it all. Every planet below reports up to him." },
  { name: "Commerce", sub: "MERCHANT", color: 0x3ecf8e, kind: "terran", hasRing: false, desc: "Merchant — shop health, GMV and sync. Proposes campaigns; you approve the spend." },
  { name: "Finance", sub: "LEDGER", color: 0x3ecf8e, kind: "icegiant", hasRing: false, desc: "Ledger — settlement vs GMV, margin and cash. Leadership-gated, always." },
  { name: "Creative", sub: "VESPER", color: 0xf5b942, kind: "jovian", hasRing: false, desc: "Vesper — 60-slot content matrix + live auto-clips. Drafts, never publishes alone." },
  { name: "Affiliate", sub: "SCOUT", color: 0xa78bfa, kind: "lava", hasRing: false, desc: "Scout — sources and tiers PH creators, matches them to under-activated brands." },
  { name: "Trend · CSI", sub: "ORACLE", color: 0xf5b942, kind: "martian", hasRing: false, desc: "Oracle — competitors, trends, market moves. Every finding cites a source." },
  { name: "Customer Care", sub: "CARE", color: 0x2dd4bf, kind: "ocean", hasRing: false, desc: "Care — triages tickets, pulls order + refund eligibility, drafts replies." },
  { name: "Live Selling", sub: "ANCHOR", color: 0xf472b6, kind: "venusian", hasRing: false, desc: "Anchor — schedules lives, tracks viewers / GMV / CTOR, coaches hosts." },
  { name: "Warehouse", sub: "LOGI", color: 0x5aa9e6, kind: "mercurial", hasRing: false, desc: "Logi — stock cover, dispatch SLA, returns. Drafts restocks, flags QC risk." },
  { name: "Reporting", sub: "HERALD", color: 0x5aa9e6, kind: "europan", hasRing: false, desc: "Herald — daily / weekly / monthly client reports in plain English. Human approves." },
  { name: "Leads", sub: "PROSPECTOR", color: 0x5aa9e6, kind: "canyon", hasRing: false, desc: "Prospector — sources qualified brand and partner leads across platforms daily." },
  { name: "Governance", sub: "SENTINEL", color: 0xf5b942, kind: "saturnian", hasRing: true, desc: "Sentinel — guards money, people and deletion. Routes consequential acts to the gate." },
  { name: "Memory", sub: "RECALL", color: 0xa78bfa, kind: "carbon", hasRing: false, desc: "Recall — stores your edits and decisions so the next draft starts closer to right." },
  { name: "Knowledge", sub: "RAG", color: 0xa78bfa, kind: "uranian", hasRing: true, desc: "RAG — grounded retrieval. Cites its source or says it does not know." },
  { name: "Calendar", sub: "NOTETAKER", color: 0x5aa9e6, kind: "hazy", hasRing: false, desc: "Notetaker — transcribes calls, pulls action items, drafts invites → your gate." },
];

const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let x = seed; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };

/* The literal surface generator Tony's orbit uses for its planet maps — same
   bands, same land/ocean split, same lava veining — producing an equirect
   texture we sample onto a sphere below instead of handing it to WebGL. */
function surfaceMap(kind: string, color: number, seed: number) {
  const W = 256, H = 128, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d")!, im = x.createImageData(W, H), d = im.data, r = rng(seed);
  const br = (color >> 16) & 255, bg = (color >> 8) & 255, bb = color & 255;
  const bands = ["jovian", "venusian", "icegiant", "uranian"].includes(kind);
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    const i = (y * W + xx) * 4, u = xx / W, v = y / H;
    const n = (Math.sin(u * 31 + Math.sin(v * 17 + seed) * 2) + Math.sin(v * 67 + u * 9) + Math.sin((u + v) * 111)) * .115 + (r() - .5) * .14;
    let q = bands ? Math.sin(v * Math.PI * (kind === "jovian" ? 18 : 10) + Math.sin(u * 9) * .35) * .22 + n : n;
    if (kind === "lava") q += Math.abs(Math.sin(u * 37 + v * 23)) * .32;
    if (kind === "carbon") q -= .28;
    const sh = Math.max(.18, Math.min(1.3, .68 + q));
    let R = br * sh, G = bg * sh, B = bb * sh;
    if (kind === "terran" || kind === "ocean") { const land = Math.sin(u * 14 + Math.sin(v * 10) * 2) + Math.sin(v * 21 - u * 5); if (land > .45) { R = 52 + 80 * sh; G = 92 + 85 * sh; B = 42 + 35 * sh; } else { R = 12 + 15 * sh; G = 43 + 45 * sh; B = 86 + 70 * sh; } }
    if (kind === "jovian") { R = 150 + 80 * sh; G = 94 + 70 * sh; B = 48 + 35 * sh; }
    if (kind === "lava") { const hot = Math.abs(Math.sin(u * 29 + v * 31)); R = 80 + 175 * hot; G = 20 + 105 * hot; B = 24 + 25 * sh; }
    d[i] = Math.min(255, R); d[i + 1] = Math.min(255, G); d[i + 2] = Math.min(255, B); d[i + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  return { data: d, W, H };
}

/* Wraps the equirect map onto a lit sphere: one lambert key from the upper
   left (where Tony sits in the orbit), limb darkening towards the edge, and a
   cool rim so the silhouette stays legible on the card's near-black panel. */
function drawPlanet(canvas: HTMLCanvasElement, agent: Agent, size: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5), px = Math.round(size * dpr);
  canvas.width = px; canvas.height = px;
  canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, px, px);
  const cx = px / 2, cy = px / 2, radius = px * (agent.hasRing ? .36 : .45);
  const ring = agent.kind === "uranian" ? { rx: radius * 1.05, ry: radius * 2.05, rot: -.32 } : { rx: radius * 2.05, ry: radius * .58, rot: -.28 };
  const cr = (agent.color >> 16) & 255, cg = (agent.color >> 8) & 255, cb = agent.color & 255;

  const ringPass = (front: boolean) => {
    if (!agent.hasRing) return;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(ring.rot); ctx.scale(1, ring.ry / ring.rx);
    if (front) { ctx.beginPath(); ctx.rect(-ring.rx * 1.2, 0, ring.rx * 2.4, ring.rx * 2.4); ctx.clip(); }
    for (const [scale, width, alpha] of [[1, .17, .34], [.82, .08, .2], [1.14, .05, .14]] as const) {
      ctx.beginPath(); ctx.arc(0, 0, ring.rx * scale, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha})`; ctx.lineWidth = ring.rx * width; ctx.stroke();
    }
    ctx.restore();
  };

  ringPass(false);

  const { data, W, H } = surfaceMap(agent.kind, agent.color, AGENTS.indexOf(agent) * 77 + 13);
  const out = ctx.createImageData(px, px), o = out.data;
  const lx = -.42, ly = -.46, lz = .78, ll = Math.hypot(lx, ly, lz);
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const nx = (x + .5 - cx) / radius, ny = (y + .5 - cy) / radius, d2 = nx * nx + ny * ny;
    if (d2 >= 1) continue;
    const i = (y * px + x) * 4, nz = Math.sqrt(1 - d2);
    const u = (.5 + Math.atan2(nx, nz) / (Math.PI * 2) + .18) % 1, v = .5 - Math.asin(Math.max(-1, Math.min(1, -ny))) / Math.PI;
    const t = ((Math.min(H - 1, Math.max(0, Math.round(v * H))) * W) + Math.min(W - 1, Math.max(0, Math.round(u * W)))) * 4;
    const lambert = Math.max(0, (nx * lx + ny * ly + nz * lz) / ll);
    const lit = .17 + .98 * lambert, rim = Math.pow(1 - nz, 3.4) * .5;
    o[i] = Math.min(255, data[t] * lit + cr * rim);
    o[i + 1] = Math.min(255, data[t + 1] * lit + cg * rim);
    o[i + 2] = Math.min(255, data[t + 2] * lit + cb * rim);
    o[i + 3] = Math.min(255, 255 * Math.min(1, (1 - d2) * radius * .9)); /* soft edge */
  }
  const sphere = document.createElement("canvas");
  sphere.width = px; sphere.height = px;
  sphere.getContext("2d")!.putImageData(out, 0, 0);
  ctx.drawImage(sphere, 0, 0);
  ringPass(true);
}

export function AgentPlanet({ agent, size }: { agent: Agent; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) drawPlanet(ref.current, agent, size); }, [agent, size]);
  if (agent.kind === "sun") return <div style={{ height: size, width: size }} className="rounded-full bg-[radial-gradient(circle_at_38%_32%,#fff7d9_0%,#f5b942_42%,#8a5a12_100%)] shadow-[0_0_26px_rgba(245,185,66,.65),0_0_54px_rgba(245,185,66,.35),inset_0_0_18px_rgba(255,255,255,.35)]" />;
  const glow = `0 0 22px rgba(${(agent.color >> 16) & 255},${(agent.color >> 8) & 255},${agent.color & 255},.28)`;
  return <canvas ref={ref} aria-hidden style={{ height: size, width: size, filter: `drop-shadow(${glow})` }} />;
}
