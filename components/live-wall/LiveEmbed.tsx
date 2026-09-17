import { resolveLiveEmbed } from "@/lib/live-wall/embed";

// The media area of a live tile. It reuses the shared resolver to decide, per
// the guardrails, whether the session PLAYS inline or LINKS OUT:
//
//   • embed_url is an embeddable player (YouTube Live / HLS / MP4 restream)
//        → play it inline in the grid (official YouTube iframe or <video>).
//   • embed_url is set but not embeddable (a native TikTok / Shopee / Lazada
//     live page) → show the thumbnail + a "Watch Live" button that opens the
//     platform. Native lives cannot be embedded, so we never fake a player.
//   • no embed_url at all → thumbnail (if any) with an honest "not linked" note.
//
// This component is presentational and server-safe (no client hooks): a YouTube
// iframe and an HTML5 <video> both render fine from the server.

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-charcoal-700/60 bg-charcoal-950">
      {children}
    </div>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-charcoal-950 text-center">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-dim" aria-hidden>
        <rect x="2" y="5" width="15" height="14" rx="2" />
        <path d="M17 9l5-3v12l-5-3" />
      </svg>
      <p className="px-3 text-[11px] text-ink-dim">{label}</p>
    </div>
  );
}

export function LiveEmbed({
  embedUrl,
  platform,
  thumbnailUrl,
  title,
}: {
  embedUrl: string | null;
  platform: string;
  thumbnailUrl: string | null;
  title: string;
}) {
  const embed = resolveLiveEmbed(embedUrl, platform);

  if (embed.mode === "embed" && embed.kind === "youtube") {
    return (
      <Frame>
        <iframe
          src={embed.src}
          title={title}
          className="absolute inset-0 h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
        />
      </Frame>
    );
  }

  if (embed.mode === "embed" && embed.kind === "video") {
    return (
      <Frame>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- live stream, no caption track */}
        <video
          src={embed.src}
          controls
          playsInline
          poster={thumbnailUrl ?? undefined}
          className="absolute inset-0 h-full w-full bg-black"
        />
        {embed.hls && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-charcoal-950/80 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-dim">
            HLS
          </span>
        )}
      </Frame>
    );
  }

  if (embed.mode === "link") {
    return (
      <Frame>
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external thumbnail, no loader needed
          <img src={thumbnailUrl} alt={title} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <Placeholder label="Native live — not embeddable" />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-charcoal-950/40">
          <a
            href={embed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-red-500/90 px-3 py-1.5 text-xs font-semibold text-charcoal-950 shadow-elevate hover:bg-red-400"
          >
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-charcoal-950" />
            Watch Live ↗
          </a>
        </div>
      </Frame>
    );
  }

  // mode === "none" — no stream URL on the session.
  return (
    <Frame>
      {thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external thumbnail, no loader needed
        <img src={thumbnailUrl} alt={title} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <Placeholder label="No stream linked" />
      )}
    </Frame>
  );
}
