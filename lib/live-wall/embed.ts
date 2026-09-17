// lib/live-wall/embed.ts — the Live & Video Wall's embed resolver.
//
// Pure, dependency-free URL logic shared by the live multiview tiles and the
// video library player. It decides, honestly, whether a link can be PLAYED
// inside the OS (official YouTube iframe / TikTok embed / <video>) or must be a
// LINK-OUT (native platform lives that cannot be embedded).
//
// GOVERNING RULES (task guardrails):
//   • A live tile embeds inline ONLY when the session actually has an embed_url
//     AND that URL resolves to a safe, embeddable player (YouTube / direct media
//     / HLS restream). Native TikTok / Shopee / Lazada lives have no embeddable
//     player, so they always fall through to a "Watch Live" link-out — never a
//     fabricated inline player.
//   • The library plays POSTED content through each platform's OFFICIAL player:
//     the TikTok embed for a TikTok video, the YouTube iframe for a YouTube
//     video, an HTML5 <video> for a direct MP4. Anything else is refused rather
//     than embedded blindly.
//
// Everything here is a pure function of its inputs (no I/O, no globals), so it is
// trivially unit-testable and safe to run on the server or the client.

// ── URL parsing helpers ───────────────────────────────────────────────────────

// Parse a string into a URL, tolerating a missing scheme (treat as https). Any
// unparseable value returns null rather than throwing.
function parseUrl(raw: string | null | undefined): URL | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^www\./i, "").toLowerCase();
}

// A YouTube video id is 11 chars of [A-Za-z0-9_-]. Extract it from any of the
// shapes YouTube hands out (watch, youtu.be, /live, /embed, /shorts), or null.
export function youtubeId(raw: string | null | undefined): string | null {
  const u = parseUrl(raw);
  if (!u) return null;
  const host = hostOf(u);
  const isYt = host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com";
  if (!isYt) return null;
  const idRe = /^[A-Za-z0-9_-]{11}$/;
  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
    return idRe.test(id) ? id : null;
  }
  // watch?v=<id>
  const v = u.searchParams.get("v");
  if (v && idRe.test(v)) return v;
  // /live/<id>, /embed/<id>, /shorts/<id>, /v/<id>
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && ["live", "embed", "shorts", "v"].includes(parts[0])) {
    return idRe.test(parts[1]) ? parts[1] : null;
  }
  return null;
}

// The numeric id of a TikTok VIDEO post, when the URL carries one
// (tiktok.com/@user/video/<digits> or tiktok.com/video/<digits>). Short links
// (vm./vt.tiktok.com, /t/…) do not expose the id without a network resolve, so
// they return null and the caller falls back to a link-out.
export function tiktokVideoId(raw: string | null | undefined): string | null {
  const u = parseUrl(raw);
  if (!u) return null;
  if (!hostOf(u).endsWith("tiktok.com")) return null;
  const m = u.pathname.match(/\/video\/(\d{6,25})/);
  return m ? m[1] : null;
}

function isTikTok(u: URL): boolean {
  return hostOf(u).endsWith("tiktok.com");
}

// A direct media file we can drop into an HTML5 <video> element. Query strings
// and fragments are ignored so a signed URL still classifies.
function isDirectMedia(u: URL): boolean {
  return /\.(mp4|webm|ogg|ogv|m4v|mov)$/i.test(u.pathname);
}

// An HLS manifest — playable in <video> where the browser supports it natively.
function isHls(u: URL): boolean {
  return /\.m3u8$/i.test(u.pathname);
}

// ── Store-time normalization (belt-and-suspenders) ────────────────────────────

// Canonicalize a pasted stream/embed URL to the exact form the resolvers embed,
// so the value written to the row is already the official player URL rather than
// a raw watch/shorts/short link. The resolvers below normalize again at render
// time, so this is defence-in-depth, not the only line of defence:
//
//   • Any YouTube WATCH shape (youtube.com/watch?v=ID, youtu.be/ID,
//     /shorts/ID, /live/ID, /v/ID, or an already-embed URL) collapses to the
//     privacy-enhanced player https://www.youtube-nocookie.com/embed/<VIDEO_ID>.
//   • Everything else — HLS (.m3u8), direct media (.mp4/…), a native TikTok /
//     Shopee / Lazada live page, or any unknown host — is returned trimmed and
//     otherwise unchanged, so the resolver's own <video> / link-out logic still
//     governs it. An empty or blank input returns null (never store "").
export function normalizeEmbedUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const yt = youtubeId(s);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt}`;
  return s;
}

// ── Live tile: embed inline vs link out ───────────────────────────────────────

// What a live tile should render for its stream.
//   • embed  → play inline (the tile has an embeddable player URL)
//   • link   → the session has a URL but it is a native live that can't be
//              embedded; show the thumbnail + a "Watch Live" button to that URL
//   • none   → no embed_url at all; nothing to play or link (honest empty)
export type LiveEmbed =
  | { mode: "embed"; kind: "youtube"; src: string }
  | { mode: "embed"; kind: "video"; src: string; hls: boolean }
  | { mode: "link"; url: string; host: string }
  | { mode: "none" };

// Resolve a live session's embed_url into a render decision. `platform` is
// accepted for symmetry / future policy but the decision is URL-driven: only a
// genuinely embeddable player (YouTube, direct media, HLS) plays inline; every
// other URL — including every native TikTok / Shopee / Lazada live page — becomes
// a link-out. `embed ONLY when embed_url is set` is enforced by construction:
// mode 'embed' is unreachable without a non-empty embed_url.
export function resolveLiveEmbed(embedUrl: string | null | undefined, _platform?: string): LiveEmbed {
  const u = parseUrl(embedUrl);
  if (!u) return { mode: "none" };

  const yt = youtubeId(u.toString());
  if (yt) {
    // Official YouTube privacy-enhanced iframe player (works for Live & VOD).
    return { mode: "embed", kind: "youtube", src: `https://www.youtube-nocookie.com/embed/${yt}` };
  }
  if (isHls(u)) return { mode: "embed", kind: "video", src: u.toString(), hls: true };
  if (isDirectMedia(u)) return { mode: "embed", kind: "video", src: u.toString(), hls: false };

  // A real URL we can't safely embed (native live, storefront, unknown host):
  // link out so the viewer opens it on the platform.
  return { mode: "link", url: u.toString(), host: hostOf(u) };
}

// ── Video library: classify a pasted link + resolve its player ────────────────

// The library supports exactly the three the task names: TikTok, YouTube, MP4.
export type VideoEmbedType = "tiktok" | "youtube" | "mp4";

// Classify a pasted link into a supported embed type, or null when it is none of
// the three (the add form then refuses it with an honest message rather than
// storing something it cannot play).
export function classifyVideoUrl(raw: string | null | undefined): VideoEmbedType | null {
  const u = parseUrl(raw);
  if (!u) return null;
  if (youtubeId(u.toString())) return "youtube";
  if (isTikTok(u)) return "tiktok";
  if (isDirectMedia(u)) return "mp4";
  return null;
}

// What the library player should render for one stored video. `embed_type` is
// the stored classification; the specifics (YouTube id, TikTok id) are re-derived
// from the URL at render time so nothing extra needs storing.
export type VideoEmbed =
  | { kind: "youtube"; src: string; url: string }
  | { kind: "tiktok"; videoId: string; url: string }
  | { kind: "tiktok-link"; url: string } // TikTok URL with no extractable id → link-out
  | { kind: "mp4"; src: string; url: string }
  | { kind: "link"; url: string }; // stored URL we can no longer classify → link-out

export function resolveVideoEmbed(url: string, embedType: string): VideoEmbed {
  const clean = (url ?? "").trim();
  if (embedType === "youtube") {
    const id = youtubeId(clean);
    if (id) return { kind: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}`, url: clean };
    return { kind: "link", url: clean };
  }
  if (embedType === "tiktok") {
    const id = tiktokVideoId(clean);
    return id ? { kind: "tiktok", videoId: id, url: clean } : { kind: "tiktok-link", url: clean };
  }
  if (embedType === "mp4") {
    return { kind: "mp4", src: clean, url: clean };
  }
  return { kind: "link", url: clean };
}
