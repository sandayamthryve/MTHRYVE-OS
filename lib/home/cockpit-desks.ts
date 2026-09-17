import type { OsSnapshot } from "@/lib/os/snapshot";

// The nine desks of the Department Cockpits overview.
//
// Every desk reads the SAME snapshot the Home dashboard and the client views
// read. That is the point of the board: one source, so Home, the cockpits and
// the client cannot disagree. The corollary is that a desk may only show a
// figure the snapshot actually carries -- a hardcoded headline would be the
// "frozen data block" this board exists to abolish, and it would drift the
// moment the real number moved.
//
// Today the snapshot carries commerce, clients and the per-department RAG
// health. The other desks' domain figures (creator counts, creative items, SLA
// breaches, ticket queues, hiring pipeline) have no source in buildSnapshot yet,
// so those desks show their health and an explicit "not in the snapshot yet"
// rather than a number nobody computed.

export type Desk = {
  key: string;
  label: string;
  icon: string;
  // The dimensions this desk answers for — the subtitle line.
  dimensions: string;
  // Matches departments[].label from the snapshot, when one exists.
  departmentName: string | null;
  // Leadership-only, mirroring snapshot.finance being null for everyone else.
  gated?: boolean;
  // The accent on the card's top edge.
  accent: string;
  // Reads the desk's headline from the snapshot, or null when unsourced.
  headline: (snapshot: OsSnapshot) => string | null;
};

const peso = (value: number | null): string | null =>
  value == null ? null : `₱${(value / 1_000_000).toFixed(1)}M`;

export const DESKS: readonly Desk[] = [
  {
    key: "ecommerce", label: "E-Commerce Growth", icon: "🛒",
    dimensions: "GMV per brand · sync health · unmapped",
    departmentName: "E-Commerce Ops", accent: "#2dd4bf",
    headline: (s) => {
      const gmv = peso(s.company.gmv);
      const shops = s.company.active_brands;
      const unmapped = s.brands.filter((brand) => brand.unmapped).length;
      if (gmv == null && shops == null) return null;
      return [gmv, shops == null ? null : `${shops} shops`, `${unmapped} unmapped`]
        .filter(Boolean)
        .join(" · ");
    },
  },
  {
    key: "affiliate", label: "Affiliate & Creator", icon: "🌟",
    dimensions: "creators · outreach · activation",
    departmentName: "Affiliate Marketing", accent: "#60a5fa",
    headline: () => null,
  },
  {
    key: "creative", label: "Creative", icon: "🎬",
    dimensions: "items · published · Vesper",
    departmentName: "Creative", accent: "#f5b544",
    headline: () => null,
  },
  {
    key: "live", label: "Live Operations", icon: "📺",
    dimensions: "sessions · hosts · video wall",
    departmentName: "Live Operations", accent: "#f472b6",
    headline: () => null,
  },
  {
    key: "warehouse", label: "Warehouse & Fulfillment", icon: "📦",
    dimensions: "stock · dispatch SLA · returns · QC",
    departmentName: "Warehouse & Fulfillment", accent: "#60a5fa",
    headline: () => null,
  },
  {
    key: "cs", label: "Customer Service", icon: "💬",
    dimensions: "ticket queue · refunds · CSR score",
    departmentName: "Customer Service", accent: "#2dd4bf",
    headline: () => null,
  },
  {
    key: "finance", label: "Finance", icon: "💰",
    dimensions: "settlement · margin · cash · NET",
    departmentName: "Finance", gated: true, accent: "#3ecf8e",
    // snapshot.finance is populated ONLY for ceo/coo and null for everyone
    // else, so this line disappears for non-leadership without a second check.
    headline: (s) => (s.finance ? "settlement tracked" : null),
  },
  {
    key: "manpower", label: "Manpower", icon: "👥",
    dimensions: "pipeline · vacancies · probation",
    departmentName: "Human Resources", accent: "#a78bfa",
    headline: () => null,
  },
  {
    key: "partnership", label: "Partnership / BizDev", icon: "🔗",
    dimensions: "brand · supplier · white-label",
    departmentName: null, accent: "#f87171",
    headline: (s) =>
      s.company.active_clients == null ? null : `${s.company.active_clients} active partners`,
  },
];

export type DeskView = {
  desk: Desk;
  headline: string | null;
  // RAG from departments[], when the snapshot knows this department.
  status: "green" | "amber" | "red" | null;
  health: number | null;
};

export function deskViews(snapshot: OsSnapshot): DeskView[] {
  const byLabel = new Map(snapshot.departments.map((entry) => [entry.label, entry] as const));
  return DESKS.map((desk) => {
    const match = desk.departmentName ? byLabel.get(desk.departmentName) ?? null : null;
    return {
      desk,
      headline: desk.headline(snapshot),
      status: match?.status ?? null,
      health: match?.headline_metric ?? null,
    };
  });
}
