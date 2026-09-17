// lib/content/templates.ts
// M1 — AI Content Studio templates. Shared across departments (E-com, Creative,
// Affiliate, BizDev, Live) and later the Creator portal. Add a template here and
// it appears in the Studio automatically. Keep prompts brand-aware and specific.

import { PILLAR_OPTIONS, FORMAT_OPTIONS, resolveFormat } from "./creative-guides";

export type TemplateField = {
  name: string;
  label: string;
  placeholder?: string;
  type?: "text" | "textarea" | "select";
  // For select fields: the choices. An empty value renders as "— None —".
  options?: { value: string; label: string }[];
};

export type ContentTemplate = {
  key: string;
  label: string;
  department: string;
  description: string;
  fields: TemplateField[];
  system: string;
  buildPrompt: (i: Record<string, string>) => string;
};

// Reusable field definitions so the creative templates expose the SAME pillar /
// format / product controls. The generate route reads inputs.pillar / .format /
// .product_* and injects the authoritative creative-brief constraints, so these
// fields drive real changes in output rather than being decorative.
const PILLAR_FIELD: TemplateField = {
  name: "pillar",
  label: "Content pillar (drives tone + objective)",
  type: "select",
  options: PILLAR_OPTIONS,
};
const FORMAT_FIELD: TemplateField = {
  name: "format",
  label: "Content format (drives structure)",
  type: "select",
  options: FORMAT_OPTIONS,
};
const PRODUCT_FIELDS: TemplateField[] = [
  { name: "product_type", label: "Product type / category", placeholder: "e.g. gummy vitamin supplement" },
  { name: "product_features", label: "Key features", placeholder: "what it is / what's in it" },
  { name: "product_benefits", label: "Benefits", placeholder: "what it does for the customer" },
  { name: "target_audience", label: "Target audience", placeholder: "who it's for" },
];

const BRAND_CONTEXT =
  "You are the content engine for Mthryve, a 360 digital-marketing agency in the Philippines and an official TikTok Shop & Shopee partner. Write for the Philippine market (Taglish where natural), platform-native, punchy, and conversion-focused. Never invent product claims or prices.";

// Shared grounding helper for the Creative Studio "Generate" panel (Plan calendar).
// The content-item generations (caption, cta, content_pillar) all ground on the
// SAME shape — the item's brand + title + brief + platform, plus the brand's
// latest account_briefing summary when one is on file — and degrade honestly when
// context is thin rather than inventing a brand situation. This mirrors the
// campaign_brief template's has()/degrade pattern so every grounded template reads
// the same way. Keep it here so all item templates reuse one prompt builder.
const has = (v?: string) => !!v && v.trim().length > 0 && v.trim().toLowerCase() !== "none";
function itemContext(i: Record<string, string>): string {
  const lines: string[] = [];
  if (has(i.brand_name)) lines.push(`Brand: ${i.brand_name}.`);
  if (has(i.brand_summary)) lines.push(`Brand situation (from the latest account briefing): ${i.brand_summary}`);
  if (has(i.platform)) lines.push(`Platform: ${i.platform}.`);
  if (has(i.content_type)) lines.push(`Content type: ${i.content_type}.`);
  if (has(i.pillar)) lines.push(`Content pillar: ${i.pillar}.`);
  if (has(i.title)) lines.push(`Working title / topic: ${i.title}.`);
  if (has(i.brief)) lines.push(`Brief / notes on file: ${i.brief}`);
  if (!has(i.brand_summary)) {
    lines.push(
      "No account briefing is on file for this brand — work from the item fields alone and do NOT invent a brand situation, product claims, prices, or numbers."
    );
  }
  return lines.join("\n");
}

export const TEMPLATES: ContentTemplate[] = [
  {
    key: "tiktok_live_script",
    label: "TikTok Live Script",
    department: "Live Operations",
    description: "A timed live-selling script segment for a product.",
    fields: [
      { name: "product", label: "Product", placeholder: "e.g. Mizumo Lona Trapal" },
      { name: "hook", label: "Angle / offer", placeholder: "e.g. mid-year sale, 40% off" },
      { name: "duration", label: "Segment length", placeholder: "e.g. 5 minutes" },
    ],
    system: BRAND_CONTEXT + " You are an expert TikTok live-selling host.",
    buildPrompt: (i) =>
      `Write a TikTok Live selling script segment (~${i.duration || "5 minutes"}) for "${i.product}". Angle/offer: ${i.hook || "highlight value"}. Include: an attention hook, product demo talking points, objection handling, a clear CTA to add-to-cart, and a repeated urgency line. Format with timestamps and [host action] cues.`,
  },
  {
    key: "product_caption",
    label: "Product Listing Caption",
    department: "E-Commerce",
    description: "Optimized product caption/description for TikTok Shop / Shopee.",
    fields: [
      { name: "product", label: "Product", placeholder: "e.g. Wintex Innerwear" },
      { name: "features", label: "Key features/benefits", type: "textarea", placeholder: "bullet the main selling points" },
      { name: "platform", label: "Platform", placeholder: "TikTok Shop / Shopee" },
    ],
    system: BRAND_CONTEXT + " You are an e-commerce listing copywriter.",
    buildPrompt: (i) =>
      `Write an optimized ${i.platform || "TikTok Shop"} product caption for "${i.product}". Features/benefits: ${i.features}. Include a scroll-stopping first line, benefit-led body, relevant searchable keywords woven in naturally, and a CTA. Add 8-12 hashtags at the end.`,
  },
  {
    key: "ad_copy",
    label: "Ad Copy (variations)",
    department: "E-Commerce",
    description: "3 ad-copy variations for paid campaigns.",
    fields: [
      { name: "product", label: "Product / offer" },
      { name: "audience", label: "Target audience", placeholder: "who is this for" },
      { name: "goal", label: "Goal", placeholder: "e.g. conversions, traffic" },
    ],
    system: BRAND_CONTEXT + " You are a performance-marketing copywriter.",
    buildPrompt: (i) =>
      `Write 3 distinct ad-copy variations for "${i.product}" targeting ${i.audience}. Campaign goal: ${i.goal}. For each: a headline, primary text (2-3 sentences), and a CTA. Vary the angle (pain-point, social proof, urgency).`,
  },
  {
    key: "content_angles",
    label: "Content Angles",
    department: "Creative",
    description: "10 fresh content angles for a product/brand, grounded in the real product and the chosen pillar.",
    fields: [
      { name: "brand", label: "Brand / product" },
      PILLAR_FIELD,
      { name: "context", label: "Context / trend", type: "textarea", placeholder: "any trend, season, or theme to lean into" },
      ...PRODUCT_FIELDS,
    ],
    system: BRAND_CONTEXT + " You are a viral short-form content strategist.",
    buildPrompt: (i) =>
      `Give 10 fresh, scroll-stopping content angles for "${i.brand}". Context/trend to consider: ${i.context || "none"}. ` +
      "For each angle: a one-line concept + the hook line + why it would perform. " +
      "Every angle must reflect the REAL product and category in the creative-brief constraints, and must fit the selected content pillar's tone and objective — do NOT default to sales-driven angles unless the pillar is Promotion. " +
      "If product specifics are missing, keep angles true to the product category and do not invent claims.",
  },
  {
    key: "video_hooks",
    label: "Video Hooks",
    department: "Creative",
    description: "15 first-3-second hooks for short videos, on-pillar and grounded in the product.",
    fields: [
      { name: "topic", label: "Topic / product" },
      PILLAR_FIELD,
      { name: "tone", label: "Tone", placeholder: "e.g. bold, funny, relatable" },
      ...PRODUCT_FIELDS,
    ],
    system: BRAND_CONTEXT + " You write the first 3 seconds of viral videos.",
    buildPrompt: (i) =>
      `Write 15 punchy first-3-second video hooks for "${i.topic}" in a ${i.tone || "relatable"} tone. ` +
      "Each must create curiosity or tension that makes viewers stop scrolling. " +
      "Keep every hook on-pillar (obey the content pillar's tone/objective in the creative-brief constraints) and true to the real product — never invent product claims. One per line.",
  },
  {
    // Content Script — the format-aware scriptwriter. Unlike tiktok_live_script
    // (which is always a live-selling segment), this adapts its STRUCTURE to the
    // selected content format (short-form, live, UGC, educational) and its TONE to
    // the selected pillar. Used by the Creative Studio Plan-calendar "Script"
    // generator so short-form scripts stop coming out formatted for live selling.
    key: "content_script",
    label: "Script",
    department: "Creative",
    description: "A format-aware script for a content item — structure follows the chosen format, tone follows the pillar.",
    fields: [
      { name: "title", label: "Working title / topic" },
      FORMAT_FIELD,
      PILLAR_FIELD,
      { name: "platform", label: "Platform", placeholder: "TikTok / Reels / Shopee Live" },
      { name: "brief", label: "Brief / notes", type: "textarea" },
      ...PRODUCT_FIELDS,
    ],
    system:
      BRAND_CONTEXT +
      " You are a scriptwriter who adapts a script's structure to the chosen content format — a short-form hook→retention→payoff→CTA is NOT a live-selling open→offer→urgency→close — and its tone to the chosen content pillar.",
    buildPrompt: (i) => {
      const fmt = resolveFormat(i.format);
      const shape = fmt
        ? `Write a complete ${fmt.label} script following the format structure in the creative-brief constraints.`
        : "Write a complete script. If no content format was chosen, default to a short-form structure (hook in the first 3 seconds → retention beats → payoff → one clear CTA) — do NOT default to a live-selling script.";
      return (
        `${itemContext(i)}\n\n` +
        `${shape} ` +
        "Include the spoken lines plus [on-screen / host action] cues. Obey the content pillar's tone and objective, ground every line in the real product, and never invent product claims, prices, or numbers."
      );
    },
  },
  {
    key: "affiliate_outreach",
    label: "Affiliate Outreach Message",
    department: "Affiliate",
    description: "A recruitment DM/email to invite a creator to an affiliate program.",
    fields: [
      { name: "creator", label: "Creator name/handle" },
      { name: "brand", label: "Brand / offer", placeholder: "brand + commission" },
      { name: "channel", label: "Channel", placeholder: "TikTok DM / email" },
    ],
    system: BRAND_CONTEXT + " You are an affiliate/creator partnerships manager.",
    buildPrompt: (i) =>
      `Write a warm, personalized ${i.channel || "TikTok DM"} to invite creator ${i.creator} to join the affiliate program for ${i.brand}. Keep it concise, flattering but genuine, state the value/commission, and end with a low-friction CTA. Give a short and a slightly longer version.`,
  },
  {
    key: "proposal_section",
    label: "Proposal Section",
    department: "Business Development",
    description: "A polished proposal section for onboarding / upsell / cross-sell.",
    fields: [
      { name: "client", label: "Client / brand" },
      { name: "purpose", label: "Purpose", placeholder: "onboarding / upsell / cross-sell" },
      { name: "details", label: "Key points to include", type: "textarea" },
    ],
    system: BRAND_CONTEXT + " You are a senior business-development strategist writing client proposals.",
    buildPrompt: (i) =>
      `Write a professional proposal section for ${i.client}. Purpose: ${i.purpose}. Include these points: ${i.details}. Structure it with a clear value narrative, scope/deliverables, and a confident close. Professional but warm tone.`,
  },
  {
    // Campaign Brief — a grounded, human-approved DRAFT written from a campaign's
    // real fields + the brand's latest account_briefing + its current metrics.
    // Driven programmatically from the Campaigns page (which supplies the brand
    // context inputs); it degrades gracefully if only the campaign fields are
    // given. Writes a content_generations ledger row like every other template.
    key: "campaign_brief",
    label: "Campaign Brief",
    department: "Business Development",
    description: "A grounded campaign brief (objective, angle, hook, audience, CTA, KPIs) from the brand's real situation.",
    fields: [
      { name: "campaign_name", label: "Campaign name" },
      { name: "notes", label: "Goal / notes", type: "textarea", placeholder: "what this campaign is for" },
    ],
    system:
      BRAND_CONTEXT +
      " You are a senior campaign strategist. Write a grounded campaign brief using ONLY the campaign details and brand situation provided — never invent metrics, prices, or facts. If the brand situation is missing or thin, say so plainly and lower the confidence, working from the campaign fields alone rather than inventing context.",
    buildPrompt: (i) => {
      const has = (v?: string) => !!v && v.trim().length > 0 && v.trim().toLowerCase() !== "none";
      const lines: string[] = [];
      lines.push(`Campaign: "${i.campaign_name || "Untitled campaign"}".`);
      if (has(i.status)) lines.push(`Status: ${i.status}.`);
      if (has(i.department)) lines.push(`Department: ${i.department}.`);
      if (has(i.dates)) lines.push(`Dates: ${i.dates}.`);
      if (has(i.owner)) lines.push(`Owner: ${i.owner}.`);
      if (has(i.notes)) lines.push(`Stated goal / notes: ${i.notes}.`);
      lines.push("");
      if (has(i.brand_name)) lines.push(`Brand: ${i.brand_name}.`);
      if (has(i.brand_summary)) {
        lines.push(`Brand situation (from latest account briefing): ${i.brand_summary}`);
      }
      if (has(i.brand_challenges)) lines.push(`Brand challenges: ${i.brand_challenges}`);
      if (has(i.brand_solutions)) lines.push(`Recommended actions on file: ${i.brand_solutions}`);
      if (has(i.brand_metrics)) lines.push(`Latest brand metrics: ${i.brand_metrics}`);
      if (has(i.confidence_note)) lines.push(`Data confidence: ${i.confidence_note}`);
      if (!has(i.brand_summary) && !has(i.brand_metrics)) {
        lines.push(
          "No account briefing or platform metrics are on file for this brand — write from the campaign fields alone and explicitly note the lower confidence rather than inventing a brand situation."
        );
      }
      const context = lines.join("\n");
      return (
        `${context}\n\n` +
        "Using ONLY the above, write a grounded campaign brief with these labeled sections:\n" +
        "1. Objective — the single measurable goal of this campaign.\n" +
        "2. Core angle — the strategic idea, tied to the brand's real situation.\n" +
        "3. Hook direction — 2-3 concrete opening-hook directions for content.\n" +
        "4. Target audience — who this speaks to and why.\n" +
        "5. Primary CTA — the one action we want.\n" +
        "6. Success KPIs — 2-3 measurable KPIs to judge the campaign by.\n" +
        "Be specific and concise. End with a one-line confidence note reflecting how much real brand data backed this brief."
      );
    },
  },
  {
    // Caption — ready-to-post caption options for a content item, grounded in the
    // brand's real situation. Driven from the Creative Studio Plan calendar's
    // "Generate" panel (which composes brand_name/brand_summary/title/brief/platform
    // into inputs). Writes a content_generations ledger row like every template.
    key: "caption",
    label: "Caption",
    department: "Creative",
    description: "3 ready-to-post caption options grounded in the brand + content item.",
    fields: [
      { name: "title", label: "Working title / topic" },
      PILLAR_FIELD,
      { name: "platform", label: "Platform", placeholder: "TikTok / Shopee / Instagram" },
      { name: "brief", label: "Brief / notes", type: "textarea" },
    ],
    system:
      BRAND_CONTEXT +
      " You are a short-form social caption writer. Ground every caption in the details provided and never invent product claims, prices, or numbers.",
    buildPrompt: (i) =>
      `${itemContext(i)}\n\n` +
      "Using ONLY the above, write 3 distinct ready-to-post caption options for this content item. " +
      "Each caption: a scroll-stopping first line, a benefit-led body of 1–2 sentences, and a clear soft CTA. " +
      "Add 4–8 relevant hashtags after each. Number them 1–3.",
  },
  {
    // CTA — punchy call-to-action lines for a content item, grounded like caption.
    key: "cta",
    label: "CTA",
    department: "Creative",
    description: "6 punchy call-to-action lines grounded in the brand + content item.",
    fields: [
      { name: "title", label: "Working title / topic" },
      PILLAR_FIELD,
      { name: "platform", label: "Platform", placeholder: "TikTok / Shopee / Instagram" },
      { name: "brief", label: "Brief / notes", type: "textarea" },
    ],
    system:
      BRAND_CONTEXT +
      " You write high-converting calls to action. Ground every CTA in the details provided and never invent offers, prices, or numbers.",
    buildPrompt: (i) =>
      `${itemContext(i)}\n\n` +
      "Using ONLY the above, write 6 punchy call-to-action lines for this content item. " +
      "Vary the angle (add-to-cart urgency, low-friction click, comment/DM to engage, save-for-later, follow, limited-time). " +
      "Keep each to one line. Do not invent a specific discount or price unless one is given. One per line.",
  },
  {
    // Content pillar — suggests the single best-fit pillar (plus alternatives) for a
    // content item, grounded in the brand situation. The user can save the pick
    // straight into the item's pillar field.
    key: "content_pillar",
    label: "Content Pillar",
    department: "Creative",
    description: "A suggested best-fit content pillar (plus 2 alternatives) for the item.",
    fields: [
      { name: "title", label: "Working title / topic" },
      { name: "platform", label: "Platform", placeholder: "TikTok / Shopee / Instagram" },
      { name: "brief", label: "Brief / notes", type: "textarea" },
    ],
    system:
      BRAND_CONTEXT +
      " You are a content strategist who organises a brand's content into clear pillars (e.g. Education, Promo, UGC, Behind-the-scenes, Social proof, Entertainment). Ground your suggestion in the details provided; never invent facts.",
    buildPrompt: (i) =>
      `${itemContext(i)}\n\n` +
      "Using ONLY the above, suggest the single best-fit content pillar for this item on the first line as `Pillar: <two or three words>` " +
      "so it can be saved directly into the item's pillar field. Then give 2 alternative pillars, each with a one-line rationale tied to the brand's situation. Be concise.",
  },
];

export const templateByKey = (k: string): ContentTemplate | undefined =>
  TEMPLATES.find((t) => t.key === k);
