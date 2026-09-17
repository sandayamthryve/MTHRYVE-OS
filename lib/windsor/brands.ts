// lib/windsor/brands.ts — maps a Windsor ad account to a Mthryve brand WITHOUT
// a schema change (task constraint). The `brands` table has no place to store a
// platform account id, so the mapping lives in one env var, exactly like the
// rest of this integration's config:
//
//   WINDSOR_BRAND_MAP = {
//     "<brand name or brand uuid>": { "tiktok": "7572146491055915025",
//                                     "facebook": ["236631147", "…"] },
//     "MPire Concepts Co.":        { "facebook": "217911345480140" }
//   }
//
// Keys match a brand by uuid OR by name (case-insensitive). Values list the
// advertiser / ad-account id(s) Windsor reports for that brand per connector.
// Accounts with no mapping still surface — their performance is real, just
// shown without a brand ("per brand where mapped"). Nothing here fabricates a
// mapping: an unparseable / empty env yields "no brands mapped".

import type { WindsorConnector } from "@/lib/ad-ops/types";

export interface BrandLite {
  id: string;
  name: string;
}

// Parsed map keyed by the raw brand key → per-connector account-id list.
type RawBrandMap = Record<string, Partial<Record<WindsorConnector, string[]>>>;

// Read + parse WINDSOR_BRAND_MAP fresh each call (runtime-only env). Returns an
// empty object on absent/invalid JSON — the loop then simply maps nothing.
export function parseBrandMap(): RawBrandMap {
  const raw = process.env.WINDSOR_BRAND_MAP?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[windsor] WINDSOR_BRAND_MAP is not valid JSON — ignoring it.");
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};

  const out: RawBrandMap = {};
  for (const [brandKey, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const perConnector: Partial<Record<WindsorConnector, string[]>> = {};
    for (const connector of ["tiktok", "facebook"] as WindsorConnector[]) {
      const ids = (val as Record<string, unknown>)[connector];
      const list = normaliseIds(ids);
      if (list.length) perConnector[connector] = list;
    }
    if (Object.keys(perConnector).length) out[brandKey] = perConnector;
  }
  return out;
}

// Coerce a string | string[] | number of account ids into a clean string[].
function normaliseIds(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr
    .map((x) => (typeof x === "number" ? String(x) : typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);
}

// How many brands have at least one mapped account (for the diag route).
export function mappedBrandCount(): number {
  return Object.keys(parseBrandMap()).length;
}

// Build a resolver: given (connector, accountId) → { brandId, brandName } | null.
// A brand key matches by uuid or case-insensitive name against the supplied
// brand list; the first brand that lists the account under the connector wins.
export function buildBrandResolver(
  brands: BrandLite[]
): (connector: WindsorConnector, accountId: string) => { brandId: string; brandName: string } | null {
  const map = parseBrandMap();

  // Index brands by uuid and by lowercased name for key lookups.
  const byId = new Map(brands.map((b) => [b.id, b]));
  const byName = new Map(brands.map((b) => [b.name.trim().toLowerCase(), b]));

  // Flatten to (connector → accountId → brand) for O(1) resolution.
  const index: Record<WindsorConnector, Map<string, BrandLite>> = {
    tiktok: new Map(),
    facebook: new Map(),
  };
  for (const [brandKey, perConnector] of Object.entries(map)) {
    const brand = byId.get(brandKey) ?? byName.get(brandKey.trim().toLowerCase());
    if (!brand) continue; // key doesn't match any known brand — skip
    for (const connector of ["tiktok", "facebook"] as WindsorConnector[]) {
      for (const accountId of perConnector[connector] ?? []) {
        if (!index[connector].has(accountId)) index[connector].set(accountId, brand);
      }
    }
  }

  return (connector, accountId) => {
    const brand = index[connector].get(accountId);
    return brand ? { brandId: brand.id, brandName: brand.name } : null;
  };
}
