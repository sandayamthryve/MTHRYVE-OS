"use client";

import { useEffect, useRef } from "react";
import { resolveVideoEmbed } from "@/lib/live-wall/embed";

// The library player — posted content played through each platform's OFFICIAL
// player: the TikTok embed for a TikTok video, the YouTube privacy-enhanced
// iframe for a YouTube link, and an HTML5 <video> for a direct MP4. A stored URL
// we can no longer classify (or a TikTok short-link with no extractable id) falls
// back to an honest "open on platform" link rather than a broken frame.

// The TikTok embed script hydrates any <blockquote class="tiktok-embed"> on the
// page. We load it once and re-run its renderer as tiles mount.
const TIKTOK_SCRIPT_ID = "tiktok-embed-js";

declare global {
  interface Window {
    tiktokEmbed?: { lib?: { render?: (el?: Element | null) => void } };
  }
}

function useTikTokEmbed(active: boolean, ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (!active) return;
    const render = () => window.tiktokEmbed?.lib?.render?.(ref.current ?? undefined);
    const existing = document.getElementById(TIKTOK_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      // Script already present — ask it to (re)scan this newly-mounted blockquote.
      render();
      return;
    }
    const s = document.createElement("script");
    s.id = TIKTOK_SCRIPT_ID;
    s.src = "https://www.tiktok.com/embed.js";
    s.async = true;
    s.onload = render;
    document.body.appendChild(s);
  }, [active, ref]);
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-charcoal-700/60 bg-black">
      {children}
    </div>
  );
}

function OpenLink({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-charcoal-950">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs text-teal-300 hover:bg-charcoal-700"
      >
        {label} ↗
      </a>
    </div>
  );
}

export function VideoPlayer({
  url,
  embedType,
  title,
}: {
  url: string;
  embedType: string;
  title: string;
}) {
  const embed = resolveVideoEmbed(url, embedType);
  const tiktokRef = useRef<HTMLElement>(null);
  useTikTokEmbed(embed.kind === "tiktok", tiktokRef);

  if (embed.kind === "youtube") {
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

  if (embed.kind === "mp4") {
    return (
      <Frame>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user-posted clip, no caption track available */}
        <video src={embed.src} controls playsInline className="absolute inset-0 h-full w-full bg-black" />
      </Frame>
    );
  }

  if (embed.kind === "tiktok") {
    // TikTok's official embed. The blockquote is hydrated into a player by
    // embed.js (loaded above); until then the link inside is the graceful
    // fallback. We cap the height so a tall vertical embed doesn't blow out the
    // grid row.
    return (
      <div className="max-h-[560px] overflow-hidden rounded-lg">
        <blockquote
          ref={tiktokRef as React.RefObject<HTMLQuoteElement>}
          className="tiktok-embed"
          cite={embed.url}
          data-video-id={embed.videoId}
          style={{ maxWidth: "100%", minWidth: "260px" }}
        >
          <section>
            <a href={embed.url} target="_blank" rel="noopener noreferrer">
              {title} — watch on TikTok ↗
            </a>
          </section>
        </blockquote>
      </div>
    );
  }

  // tiktok-link (no id) or an unclassifiable stored URL → link out.
  return (
    <Frame>
      <OpenLink url={embed.url} label={embed.kind === "tiktok-link" ? "Watch on TikTok" : "Open video"} />
    </Frame>
  );
}
