import { requireModule } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { requireDepartment } from "@/lib/auth/session";
import { CONTENT_DEPTS } from "@/lib/auth/access-matrix";

// The Content Calendar has moved into the unified Creative Studio workspace as
// its "Plan" tab. This route now permanently redirects there, preserving the
// deep-link params (?brand=, ?month=) plus any Canva OAuth flags that older
// links / the Canva callback may still carry, so nothing breaks.
export const dynamic = "force-dynamic";

export default async function ContentCalendarRedirect({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Content Calendar is department-scoped to Creative + Live Operations
  // (leadership bypasses). Gate the entry point BEFORE the redirect so a
  // non-Creative/Live-Ops user is bounced home rather than forwarded on.
  await requireModule("/content-calendar");
  const p = new URLSearchParams();
  const carry = ["brand", "month", "canva", "canva_error", "canva_connected", "heygen", "berr", "edit"];
  for (const key of carry) {
    const v = searchParams[key];
    const val = Array.isArray(v) ? v[0] : v;
    if (val) p.set(key, val);
  }
  // An ?edit= link opens the item on the Produce tab; otherwise land on Plan.
  p.set("tab", p.get("edit") ? "produce" : "plan");
  redirect(`/creative-studio?${p.toString()}`);
}
