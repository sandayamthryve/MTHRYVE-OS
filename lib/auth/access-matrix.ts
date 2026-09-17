// Department-scoped access matrix — the single source of truth for which real
// department(s) may reach each team's tools. Shared by BOTH the nav gates
// (SidebarNav / MobileNav — cosmetic) and the page-level requireDepartment
// guards (the real enforcement) so the two can never drift.
//
// Names match public.departments.name EXACTLY (verified against the live
// departments table): 'E-Commerce Ops', 'Creative', 'Live Operations',
// 'Affiliate Marketing', 'Warehouse & Fulfillment'. This module is pure data —
// no server/client imports — so the client nav and the server pages can both
// consume it.

// Commerce — the e-commerce operating surface (Clients, Campaigns, Operational
// Records, and the whole Warehouse module). Owned by E-Commerce Ops and
// Warehouse & Fulfillment.
export const COMMERCE_DEPTS: string[] = ["E-Commerce Ops", "Warehouse & Fulfillment"];

// TikTok Orders — the individual-order evidence surface required by TikTok App
// Review. Narrower than COMMERCE_DEPTS: E-Commerce Ops owns it (Warehouse does
// not need order-level marketplace data). Leadership still bypasses. Shared by
// the nav gate and the page's requireDepartment so the two never drift.
export const ECOMMERCE_OPS_DEPTS: string[] = ["E-Commerce Ops"];

// Content Calendar — the Creative Studio planning surface. Creative owns it;
// Live Operations plans its own content here too. (Was company-wide in #197 —
// that visibility is intentionally removed; it is no longer everyone's tool.)
export const CONTENT_DEPTS: string[] = ["Creative", "Live Operations"];

// Vesper Reach — the growth/operator reach surface, worked by Creative and Live
// Operations.
export const VESPER_DEPTS: string[] = ["Creative", "Live Operations"];

// Affiliate Reach — Affiliate Marketing's campaign surface.
export const AFFILIATE_DEPTS: string[] = ["Affiliate Marketing"];

// Arrianne Castillo — HR & Admin department head granted EXPLICIT access to
// Affiliate Reach. She is not in the Affiliate Marketing department, so a
// department gate alone would not reach her; the user-id allowlist does.
// (Dana Jean Morales is coo → already covered by the leadership bypass.)
export const AFFILIATE_EXTRA_USER_IDS: string[] = [
  "5fa6d925-5ff3-4898-a8a2-95c927b42f88",
];

// HR — People/HRMS module access. Adjust name to match public.departments exactly.
export const HR_DEPTS: string[] = ["Human Resources"];

// Finance — Money module access. Adjust name to match public.departments exactly.
export const FINANCE_DEPTS: string[] = ["Finance"];
