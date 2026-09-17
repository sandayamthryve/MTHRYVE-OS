import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";

// The Warehouse sub-navigation, shared by the warehouse surfaces: Intelligence
// (the headline view + scan), Product Master (CRUD), Stock (on-hand vs reorder /
// expiry) and the Returns & RTS tracker. Purely presentational — the caller
// passes which tab is active. Kept as one component so the tabs read identically
// across pages.

type Tab = "overview" | "intelligence" | "products" | "stock" | "returns" | "rts" | "cases";

const TABS: { id: Tab; href: string; label: string }[] = [
  { id: "overview", href: "/warehouse/overview", label: "Overview" },
  { id: "intelligence", href: "/warehouse/intelligence", label: "Product Intelligence" },
  { id: "products", href: "/warehouse/products", label: "Product Master" },
  { id: "stock", href: "/warehouse/stock", label: "Stock" },
  { id: "returns", href: "/warehouse", label: "Returns" },
  { id: "rts", href: "/warehouse/rts", label: "RTS" },
  { id: "cases", href: "/warehouse/cases", label: "Case Monitoring" },
];

export function WarehouseTabs({ active }: { active: Tab }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-1 rounded-lg border border-charcoal-700/60 bg-charcoal-900 p-1">
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
            t.id === active
              ? "bg-teal-500/10 text-teal-300"
              : "text-ink-muted hover:bg-charcoal-800 hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
