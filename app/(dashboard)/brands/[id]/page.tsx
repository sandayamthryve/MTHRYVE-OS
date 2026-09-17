import { redirect } from "next/navigation";

// The per-brand commerce dashboard has been consolidated into the single,
// brand-switched Clients dashboard at /brands. There is now ONE dashboard for
// every brand rather than a page per brand, so this route simply forwards to the
// Clients dashboard with the brand preselected (?brand=<id>). Existing deep
// links (e.g. from Accounts) keep working through this redirect — the window
// param, if present, is carried across so the chosen window survives the hop.

export const dynamic = "force-dynamic";

export default function BrandDashboardRedirect({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { w?: string };
}) {
  const qs = new URLSearchParams({ brand: params.id });
  if (searchParams?.w) qs.set("w", searchParams.w);
  redirect(`/brands?${qs.toString()}`);
}
