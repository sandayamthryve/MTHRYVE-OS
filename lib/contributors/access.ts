// lib/contributors/access.ts — shared server helpers for the in-OS contributor
// gates (moderation queue, attendance gate, management).
//
// Reads of contributor_logs are RLS-scoped in the database: a caller sees a log
// only if they are ceo/coo OR carry a moderator_brand_assignment for that log's
// brand (see the contriblogs_read policy). So the in-OS pages just query with the
// caller's own (cookie) client and let RLS do the scoping — no brand filter is
// duplicated in app code. The only privileged step is minting signed URLs for the
// private evidence bucket, which needs the service-role client.

import { createServiceRoleClient } from "@/lib/supabase/service";

type Db = { from: (t: string) => any };

// Whether the caller may act on the moderation / attendance queues at all. Mirrors
// the contributor_logs RLS: leadership (ceo/coo) OR anyone with at least one
// moderator_brand_assignment. Department heads (e.g. Joycel) qualify only via an
// assignment — the same rule the database enforces on every read/update.
export async function canModerate(
  supabase: Db,
  userId: string,
  role: string
): Promise<boolean> {
  if (role === "ceo" || role === "coo") return true;
  const { count } = await supabase
    .from("moderator_brand_assignments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  return (count ?? 0) > 0;
}

// Mint short-lived signed URLs for private 'evidence' bucket object paths. Best
// effort: a path that can't be signed maps to null so a broken photo never breaks
// the queue. Deduplicates identical paths. One hour is plenty for a review pass.
export async function signEvidenceUrls(
  paths: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(paths.filter((p): p is string => !!p)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;

  const service = createServiceRoleClient();
  await Promise.all(
    unique.map(async (path) => {
      try {
        const { data } = await service.storage.from("evidence").createSignedUrl(path, 3600);
        if (data?.signedUrl) out.set(path, data.signedUrl);
      } catch {
        /* best-effort — skip an unsignable path */
      }
    })
  );
  return out;
}
