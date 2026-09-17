import Link from "next/link";

// Persistent banner shown across the whole Leadership View-As surface. It states,
// unmissably, that the leader is looking at someone else's home in READ-ONLY mode —
// no write control renders anywhere beneath it. Sticky so it stays visible while
// scrolling the impersonated cockpit.
export function ViewAsBanner({
  name,
  roleLabel,
  exitHref = "/home/view-as",
}: {
  name: string;
  roleLabel: string;
  exitHref?: string;
}) {
  return (
    <div className="sticky top-0 z-10 -mx-4 mb-6 border-b border-amber-500/40 bg-amber-500/15 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-100">
          <span aria-hidden>👁</span>
          Viewing as {name} <span className="font-normal text-amber-200/80">· {roleLabel} · read-only</span>
        </p>
        <Link
          href={exitHref}
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/20"
        >
          Exit View-As
        </Link>
      </div>
    </div>
  );
}
