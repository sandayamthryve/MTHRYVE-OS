import { createServiceRoleClient } from "@/lib/supabase/service";
import { callApi, apiErrorMessage } from "@/lib/tiktok/sync";

// PR 11 — Warehouse Intake · Phase 1.
//
// Fill `public.products` (the identity master, currently empty) from the TikTok
// Product API so Logi/warehouse has real SKUs to render. Service-role,
// idempotent, failure-isolated per shop, and logged to `tiktok_sync_runs`.
//
// GUARDRAILS (see PR 11 spec §0):
//   • ADDITIVE identity only. This writer NEVER touches `stock_levels` — on-hand
//     is ledger-owned (movement-driven, returns-fed) and NOT NULL; a missing
//     stock row renders "—" for free, which is the correct "unknown ≠ 0".
//   • No revenue column is written here; GMV stays in tiktok_shop_performance.
//   • The upsert payload carries ONLY API-owned columns, so warehouse-managed
//     fields (unit_value/cost/flags/reorder_point/warehouse_location/notes/…)
//     survive every re-sync untouched.
//   • Idempotency invariant: products' UNIQUE key is (org_id, brand_id, sku) and
//     Postgres treats NULL as distinct — a null brand_id would silently break the
//     upsert, so a shop with a null brand_id fails LOUD rather than inserting dupes.
//
// The signer + login-bounce/401 classification are reused from tiktok/sync via
// the exported `callApi` — the same battle-tested caller the daily read-sync uses.

const TT_VERSION = "202309"; // matches the version tiktok/sync pins for every business path
const PRODUCTS_SEARCH_PATH = `/product/${TT_VERSION}/products/search`;
const productDetailPath = (id: string): string => `/product/${TT_VERSION}/products/${id}`;

// Page-list guard: cap the id-collection loop so a runaway/looping cursor can't
// spin forever. A cursor still open at the cap is surfaced (never silently
// truncated) — same discipline as sync.ts.
const PRODUCTS_PAGE_SIZE = 100;
const MAX_PAGES = 200;

type Shop = {
  org_id: string;
  brand_id: string | null;
  shop_id: string;
  shop_cipher: string;
  access_token: string;
  region: string | null;
  seller_name: string | null;
};

type ProductRow = {
  org_id: string;
  brand_id: string; // enforced non-null before upsert (guardrail)
  sku: string; // seller_sku, fallback tt:<sku_id>
  product_name: string | null;
  category: string | null;
  variant: string | null;
  selling_price: number | null;
  status: string; // 'active' | 'inactive'
  source: "tiktok_api";
  synced_at: string; // ISO
};

type ShopResult =
  | {
      shop_id: string;
      ok: true;
      rows_upserted: number;
      rows_created: number;
      rows_updated: number;
      rows_skipped: number;
    }
  | { shop_id: string; ok: false; error: string };

export interface SyncProductsSummary {
  shops_total: number;
  shops_ok: number;
  rows_upserted: number;
  // Additive breakdown of what the upsert actually did, so a human trigger can
  // report "created X, updated Y, skipped Z" instead of a bare "Success". These
  // are computed by comparing the batch against the existing (org, brand, sku)
  // keys BEFORE the upsert; the daily GitHub Actions bearer path ignores them, so its
  // response is unchanged in every field it already reads.
  rows_created: number;
  rows_updated: number;
  rows_skipped: number;
  results: ShopResult[];
}

// --- Minimal structural DB shapes -------------------------------------------
// The generated Database types don't yet include products/tiktok_sync_runs (and
// PostgREST resource embeds are awkward to type), so — exactly as sync.ts does
// for writeSyncRun/listShopsForSync — we cast the service client to the precise
// surface each call uses instead of reaching for `any`.
type Db = ReturnType<typeof createServiceRoleClient>;
type Result<T> = Promise<{ data: T; error: unknown }>;

interface RawShopRow {
  org_id: string;
  brand_id: string | null;
  shop_id: string;
  shop_cipher: string | null;
  tiktok_connections:
    | { access_token: string | null; region: string | null; seller_name: string | null; status: string }
    | { access_token: string | null; region: string | null; seller_name: string | null; status: string }[]
    | null;
}

type ShopSelectDb = {
  from: (t: string) => {
    select: (cols: string) => {
      eq: (c: string, v: string) => {
        eq: (c: string, v: string) => Result<RawShopRow[] | null>;
      };
    };
  };
};

type RunInsertDb = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => {
      select: (cols: string) => { single: () => Result<{ id: string } | null> };
    };
  };
};

type RunUpdateDb = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => {
      eq: (c: string, v: string) => Promise<{ error: unknown }>;
    };
  };
};

type UpsertDb = {
  from: (t: string) => {
    upsert: (
      rows: Record<string, unknown>[],
      opts: { onConflict: string; ignoreDuplicates: boolean; count: "exact" }
    ) => Promise<{ error: unknown; count: number | null }>;
  };
};

// Read-only probe of which (org, brand, sku) keys already exist, so the upsert
// can be reported as created-vs-updated. Same cast-shim discipline as the rest
// of the module.
type SelectExistingDb = {
  from: (t: string) => {
    select: (cols: string) => {
      eq: (c: string, v: string) => {
        eq: (c: string, v: string) => {
          in: (c: string, vals: string[]) => Result<{ sku: string }[] | null>;
        };
      };
    };
  };
};

// The tally an upsert reports back: how many rows were freshly inserted, how many
// matched an existing (org, brand, sku) and were updated in place, and how many
// intra-batch duplicate rows were dropped before the write.
interface UpsertTally {
  upserted: number; // created + updated (the count the DB affected)
  created: number;
  updated: number;
  skipped: number; // intra-batch duplicates dropped
}

// --- Load the shops that have API fuel --------------------------------------
// One row per active shop joined (inner) to its active connection's live token.
// A shop whose connection is inactive/tokenless is simply not returned.
async function loadActiveShops(db: Db): Promise<Shop[]> {
  const cols =
    "org_id, brand_id, shop_id, shop_cipher, tiktok_connections!inner ( access_token, region, seller_name, status )";
  const { data, error } = await (db as unknown as ShopSelectDb)
    .from("tiktok_shops")
    .select(cols)
    .eq("status", "active")
    .eq("tiktok_connections.status", "active");
  if (error) throw error;

  return (data ?? [])
    .map((s): Shop | null => {
      const conn = Array.isArray(s.tiktok_connections) ? s.tiktok_connections[0] : s.tiktok_connections;
      const token = conn?.access_token ?? "";
      const cipher = s.shop_cipher ?? "";
      // No token or no cipher → the shop cannot be called; skip it rather than
      // firing a doomed request. (All 10 live shops currently have both.)
      if (!token || !cipher) return null;
      return {
        org_id: s.org_id,
        brand_id: s.brand_id,
        shop_id: s.shop_id,
        shop_cipher: cipher,
        access_token: token,
        region: conn?.region ?? null,
        seller_name: conn?.seller_name ?? null,
      };
    })
    .filter((s): s is Shop => s !== null);
}

// --- TikTok Product API (reuse the signed caller) ---------------------------
// Get Product List:   POST /product/202309/products/search  (scope: seller.product.write ✔)
// Get Product Detail: GET  /product/202309/products/{id}    (scope: seller.product.write ✔)
async function fetchAllProductIds(shop: Shop): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string | number> = {
      shop_cipher: shop.shop_cipher,
      page_size: PRODUCTS_PAGE_SIZE,
    };
    if (pageToken) query.page_token = pageToken;

    const r = await callApi({
      method: "POST",
      path: PRODUCTS_SEARCH_PATH,
      accessToken: shop.access_token,
      query,
      body: { status: "ALL" },
    });
    if (!r.ok || (r.code && r.code !== 0)) throw new Error(apiErrorMessage(r));

    const data = r.data ?? {};
    const products = Array.isArray(data.products) ? (data.products as Record<string, unknown>[]) : [];
    for (const p of products) if (typeof p.id === "string" && p.id) ids.push(p.id);

    pageToken = typeof data.next_page_token === "string" ? data.next_page_token : "";
    if (!pageToken) break;
    if (page === MAX_PAGES - 1 && pageToken) {
      // Cap reached with a cursor still open — surface it so a truncated pull is
      // never mistaken for a complete one (guardrail: no silent caps).
      console.warn("[tiktok] fetchAllProductIds hit MAX_PAGES with cursor remaining", {
        shop: shop.shop_id,
        maxPages: MAX_PAGES,
      });
    }
  }
  return ids;
}

async function fetchProductDetail(shop: Shop, productId: string): Promise<Record<string, unknown>> {
  const r = await callApi({
    method: "GET",
    path: productDetailPath(productId),
    accessToken: shop.access_token,
    query: { shop_cipher: shop.shop_cipher },
  });
  if (!r.ok || (r.code && r.code !== 0)) throw new Error(apiErrorMessage(r));
  return r.data ?? {};
}

// --- Mapping helpers --------------------------------------------------------
// Coerce TikTok's string|number money to a finite number, or null.
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Map one TikTok product (detail payload) -> N product rows (one per SKU).
function mapProduct(shop: Shop, p: Record<string, unknown>, now: string): ProductRow[] {
  const chains = Array.isArray(p.category_chains) ? (p.category_chains as Record<string, unknown>[]) : [];
  const leafCategory =
    chains.length && typeof chains[chains.length - 1]?.local_name === "string"
      ? (chains[chains.length - 1].local_name as string)
      : null;
  const status = p.status === "ACTIVATE" ? "active" : "inactive";
  const title = typeof p.title === "string" ? p.title : null;
  const skus = Array.isArray(p.skus) ? (p.skus as Record<string, unknown>[]) : [];

  return skus.map((sku): ProductRow => {
    const rawSellerSku = typeof sku.seller_sku === "string" ? sku.seller_sku.trim() : "";
    const sellerSku = rawSellerSku || `tt:${sku.id}`;

    const attrs = Array.isArray(sku.sales_attributes)
      ? (sku.sales_attributes as Record<string, unknown>[])
      : [];
    const variant = attrs.length
      ? attrs.map((a) => `${a.name}: ${a.value_name}`).join("; ")
      : null;

    const price = sku.price as Record<string, unknown> | undefined;
    const selling_price = price ? toNum(price.sale_price) : null;

    return {
      org_id: shop.org_id,
      brand_id: shop.brand_id as string, // validated non-null in upsertProducts
      sku: sellerSku,
      product_name: title,
      category: leafCategory,
      variant,
      selling_price,
      status,
      source: "tiktok_api",
      synced_at: now,
    };
  });
}

// --- Idempotent upsert: only API-owned columns ------------------------------
async function upsertProducts(db: Db, rows: ProductRow[]): Promise<UpsertTally> {
  if (!rows.length) return { upserted: 0, created: 0, updated: 0, skipped: 0 };
  // Dedupe within the batch on the conflict key. A single upsert payload that
  // repeats (org_id, brand_id, sku) would otherwise error ("cannot affect row a
  // second time"); dropping the repeat keeps the write idempotent. The dropped
  // repeats are the "skipped" count.
  const seen = new Set<string>();
  const clean = rows.filter((r) => {
    if (!r.brand_id) {
      throw new Error(`null brand_id for sku ${r.sku} — refusing (breaks (org,brand,sku) idempotency)`);
    }
    const k = `${r.org_id}|${r.brand_id}|${r.sku}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const skipped = rows.length - clean.length;

  // Which of these keys already exist? Read them first (grouped by org+brand,
  // which is constant per shop) so we can report created-vs-updated honestly.
  // A key present now will be UPDATED in place by the upsert (warehouse-managed
  // columns survive); a key absent now is a fresh INSERT.
  const existing = new Set<string>();
  const groups = new Map<string, { orgId: string; brandId: string; skus: string[] }>();
  for (const r of clean) {
    const gk = `${r.org_id}|${r.brand_id}`;
    let g = groups.get(gk);
    if (!g) {
      g = { orgId: r.org_id, brandId: r.brand_id, skus: [] };
      groups.set(gk, g);
    }
    g.skus.push(r.sku);
  }
  for (const g of groups.values()) {
    const { data, error } = await (db as unknown as SelectExistingDb)
      .from("products")
      .select("sku")
      .eq("org_id", g.orgId)
      .eq("brand_id", g.brandId)
      .in("sku", g.skus);
    if (error) throw error;
    for (const row of data ?? []) existing.add(`${g.orgId}|${g.brandId}|${row.sku}`);
  }
  let created = 0;
  let updated = 0;
  for (const r of clean) {
    if (existing.has(`${r.org_id}|${r.brand_id}|${r.sku}`)) updated += 1;
    else created += 1;
  }

  const { error, count } = await (db as unknown as UpsertDb)
    .from("products")
    .upsert(clean, { onConflict: "org_id,brand_id,sku", ignoreDuplicates: false, count: "exact" });
  if (error) throw error;
  return { upserted: count ?? clean.length, created, updated, skipped };
}

// --- Per-shop run: failure-isolated + logged to tiktok_sync_runs ------------
async function syncOneShop(db: Db, shop: Shop): Promise<ShopResult> {
  const started_at = new Date().toISOString();

  // Best-effort run row (a logging failure must not abort the sync).
  let runId: string | null = null;
  try {
    const { data: run, error } = await (db as unknown as RunInsertDb)
      .from("tiktok_sync_runs")
      .insert({
        org_id: shop.org_id,
        shop_id: shop.shop_id,
        endpoint: PRODUCTS_SEARCH_PATH,
        status: "running",
        started_at,
      })
      .select("id")
      .single();
    if (error) console.error("[tiktok] products run insert failed", { shop: shop.shop_id, error });
    runId = run?.id ?? null;
  } catch (e) {
    console.error("[tiktok] products run insert threw", { shop: shop.shop_id, error: e });
  }

  const finishRun = async (patch: Record<string, unknown>): Promise<void> => {
    if (!runId) return;
    try {
      const { error } = await (db as unknown as RunUpdateDb)
        .from("tiktok_sync_runs")
        .update({ ...patch, finished_at: new Date().toISOString() })
        .eq("id", runId);
      if (error) console.error("[tiktok] products run update failed", { shop: shop.shop_id, error });
    } catch (e) {
      console.error("[tiktok] products run update threw", { shop: shop.shop_id, error: e });
    }
  };

  try {
    const now = new Date().toISOString();
    const ids = await fetchAllProductIds(shop);
    let rows: ProductRow[] = [];
    for (const id of ids) {
      const detail = await fetchProductDetail(shop, id);
      rows = rows.concat(mapProduct(shop, detail, now));
    }
    const tally = await upsertProducts(db, rows);
    await finishRun({ status: "success", rows_upserted: tally.upserted });
    console.info("[tiktok] products synced", {
      shop: shop.shop_id,
      products: ids.length,
      rows_upserted: tally.upserted,
      created: tally.created,
      updated: tally.updated,
      skipped: tally.skipped,
    });
    return {
      shop_id: shop.shop_id,
      ok: true,
      rows_upserted: tally.upserted,
      rows_created: tally.created,
      rows_updated: tally.updated,
      rows_skipped: tally.skipped,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finishRun({ status: "error", error_message: message });
    console.error("[tiktok] products sync failed", { shop: shop.shop_id, message });
    return { shop_id: shop.shop_id, ok: false, error: message };
  }
}

// --- Entry point ------------------------------------------------------------
// Walk every active shop SEQUENTIALLY so one shop's failure never aborts the
// rest, tallying a summary the route returns verbatim.
export async function syncProducts(): Promise<SyncProductsSummary> {
  const db = createServiceRoleClient();
  const shops = await loadActiveShops(db);
  const results: ShopResult[] = [];
  for (const shop of shops) results.push(await syncOneShop(db, shop));
  const okRows = results.filter((r): r is Extract<ShopResult, { ok: true }> => r.ok);
  return {
    shops_total: shops.length,
    shops_ok: okRows.length,
    rows_upserted: okRows.reduce((n, r) => n + r.rows_upserted, 0),
    rows_created: okRows.reduce((n, r) => n + r.rows_created, 0),
    rows_updated: okRows.reduce((n, r) => n + r.rows_updated, 0),
    rows_skipped: okRows.reduce((n, r) => n + r.rows_skipped, 0),
    results,
  };
}
