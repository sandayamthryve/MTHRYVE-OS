// Movie-template builder — composes an item's categorised Creative Kit assets
// (clips + visuals + captions + music/voiceover) into a JSON2Video "movie" object
// the client renders into one finished MP4. This is the "via a template" step:
// one place that decides scene order, image hold time, caption overlays and the
// music/voiceover bed, so the shape is consistent and easy to tune.
//
// Pure — no key reads, no network. Runs server-side inside the approve action,
// but importing it into a client bundle would leak nothing sensitive.

import {
  type AssemblySelection,
  type AssemblyResolution,
  type AssemblySourceAsset,
  ASSEMBLY_QUALITY,
  IMAGE_SCENE_SECONDS,
} from "@/lib/json2video/assembly";

export interface BuildMovieOptions {
  resolution: AssemblyResolution;
  // Item title — used as the movie `comment` (a human label in the JSON2Video
  // dashboard) and as a fallback caption when the kit carries no caption text.
  title: string;
  // When set, JSON2Video POSTs the completion to this endpoint (our webhook
  // receiver). Left off in dev / when the origin can't be resolved — the /status
  // poll is the fallback and completion still lands.
  webhookUrl?: string | null;
  // Echoed back verbatim in the webhook payload's `client-data` so the receiver
  // can find our ledger row without parsing anything else.
  clientData?: Record<string, unknown>;
}

// True when a caption asset points at a subtitle FILE (SRT/VTT) rather than
// carrying its text inline in `title`.
function isSubtitleFile(url: string | null): boolean {
  if (!url) return false;
  return /\.(srt|vtt)(\?|#|$)/i.test(url.trim());
}

// A single movie-level audio bed (music or voiceover), looped so it covers the
// whole cut. `volume` keeps music under a voiceover when both are present.
function audioElement(asset: AssemblySourceAsset, volume: number): Record<string, unknown> {
  return { type: "audio", src: asset.url, volume, loop: true };
}

// A caption text overlay, bottom-centre, shown for the length of its scene.
function captionElement(text: string): Record<string, unknown> {
  return { type: "text", text, position: "bottom-center" };
}

// Build the JSON2Video movie object from a categorised selection. Scenes run
// clips-first (chronological) then still visuals; plain-text captions are
// distributed across the scenes in order; a subtitle-file caption and the
// music/voiceover beds are attached at the movie level. Callers guarantee the
// selection has at least one scene (see hasRenderableScenes).
export function buildMovie(
  sel: AssemblySelection,
  opts: BuildMovieOptions
): Record<string, unknown> {
  // Plain-text captions to sprinkle across scenes, and any subtitle files to
  // attach movie-wide.
  const textCaptions = sel.captions
    .filter((c) => !isSubtitleFile(c.url) && c.title && c.title.trim())
    .map((c) => c.title!.trim());
  const subtitleFiles = sel.captions.filter((c) => isSubtitleFile(c.url));

  const scenes: Record<string, unknown>[] = [];
  let captionIdx = 0;
  const nextCaption = (): string | null =>
    textCaptions.length ? textCaptions[captionIdx++ % textCaptions.length] : null;

  // Moving-footage scenes — the video element sets the scene length.
  for (const clip of sel.clips) {
    const elements: Record<string, unknown>[] = [{ type: "video", src: clip.url }];
    const cap = nextCaption();
    if (cap) elements.push(captionElement(cap));
    scenes.push({ comment: clip.title ?? "clip", elements });
  }

  // Still-visual scenes — images have no intrinsic length, so hold each for a
  // fixed beat.
  for (const visual of sel.visuals) {
    const elements: Record<string, unknown>[] = [{ type: "image", src: visual.url }];
    const cap = nextCaption();
    if (cap) elements.push(captionElement(cap));
    scenes.push({ comment: visual.title ?? "visual", duration: IMAGE_SCENE_SECONDS, elements });
  }

  // Movie-level overlays: voiceover at full volume, music ducked beneath it (or
  // full when it's the only bed), and any subtitle files.
  const elements: Record<string, unknown>[] = [];
  if (sel.voiceover) elements.push(audioElement(sel.voiceover, 1));
  if (sel.music) elements.push(audioElement(sel.music, sel.voiceover ? 0.3 : 0.8));
  for (const sub of subtitleFiles) elements.push({ type: "subtitles", src: sub.url });

  const movie: Record<string, unknown> = {
    comment: `Listing video: ${opts.title}`.slice(0, 250),
    resolution: opts.resolution.value,
    quality: ASSEMBLY_QUALITY,
    scenes,
  };
  if (elements.length) movie.elements = elements;
  if (opts.clientData) movie["client-data"] = opts.clientData;
  if (opts.webhookUrl) {
    movie.exports = [{ destinations: [{ type: "webhook", endpoint: opts.webhookUrl }] }];
  }

  return movie;
}
