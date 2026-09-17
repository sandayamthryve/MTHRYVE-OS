#!/usr/bin/env node
// Vesper Studio — auto-clipping WORKER (out-of-runtime).
//
// WHY THIS EXISTS: the heavy stages of the pipeline — extracting audio,
// transcribing long audio, and cutting/re-encoding vertical clips — need ffmpeg
// and minutes of CPU. None of that can run in the Vercel serverless runtime
// (no ffmpeg binary; strict function time/memory/body limits). So the Next.js
// app only ENQUEUES jobs (vesper_clip_jobs) and runs the Anthropic segment
// step; this standalone worker does the media work wherever ffmpeg is installed
// (a small VM, a container, a cron box, or a local machine).
//
// It talks to Supabase with the SERVICE ROLE (no user session — same pattern as
// the fal completion writer), scoping every write by row id. Nothing here
// publishes: it only produces reviewable DRAFTS in Creative Studio.
//
// SERVICES (honest attribution):
//   • Transcription  → OpenAI Whisper (whisper-1, verbose_json w/ segments).
//   • Segment select → Anthropic (Claude). The prompt below is kept in sync with
//                      lib/vesper/segment.ts — change both together.
//   • Cutting        → ffmpeg (vertical 1080x1920 by default).
//
// REQUIREMENTS: node >= 20, ffmpeg + ffprobe on PATH, and env:
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   OPENAI_API_KEY, ANTHROPIC_API_KEY
// Optional: VESPER_SEGMENT_MODEL (default claude-sonnet-5),
//           VESPER_POLL_MS (default 15000), VESPER_ONESHOT=1 (process one job
//           and exit — handy for cron).
//
// RUN:  node worker/vesper-clipper.mjs
// CRON: VESPER_ONESHOT=1 node worker/vesper-clipper.mjs   (e.g. every minute)

import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

const BUCKET = "creative-media";
const SEGMENT_MODEL = process.env.VESPER_SEGMENT_MODEL || "claude-sonnet-5";
const POLL_MS = Number(process.env.VESPER_POLL_MS || 15000);
const AUDIO_CHUNK_SECONDS = 600; // 10 min chunks keep each Whisper upload < 25MB
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";

// --- env / client -----------------------------------------------------------
const SUPABASE_URL = required("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_KEY = required("OPENAI_API_KEY");
const ANTHROPIC_KEY = required("ANTHROPIC_API_KEY");

function required(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[vesper-worker] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- helpers ----------------------------------------------------------------
function log(...a) {
  console.log("[vesper-worker]", ...a);
}

function resolveOptions(raw) {
  const o = raw || {};
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const aspect = ["9:16", "1:1", "16:9"].includes(o.aspect) ? o.aspect : "9:16";
  const min_seconds = clamp(o.min_seconds, 5, 120, 12);
  const max_seconds = Math.max(min_seconds + 1, clamp(o.max_seconds, 10, 180, 60));
  return { max_clips: clamp(o.max_clips, 1, 20, 6), min_seconds, max_seconds, aspect };
}

// Target frame size for an aspect (short-form defaults to 9:16 1080x1920).
function frameSize(aspect) {
  if (aspect === "1:1") return { w: 1080, h: 1080 };
  if (aspect === "16:9") return { w: 1920, h: 1080 };
  return { w: 1080, h: 1920 };
}

async function updateJob(id, patch) {
  const { error } = await supabase.from("vesper_clip_jobs").update(patch).eq("id", id);
  if (error) log("updateJob failed", id, error.message);
}

async function ffprobeDuration(file) {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch (e) {
    log("ffprobe failed", e.message);
    return null;
  }
}

// --- claim the next queued job (guarded so two workers don't grab the same one) ---
async function claimNextJob() {
  const { data: candidates } = await supabase
    .from("vesper_clip_jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);
  const candidate = candidates?.[0];
  if (!candidate) return null;

  // Conditional update: only succeeds if the row is still 'queued'.
  const { data, error } = await supabase
    .from("vesper_clip_jobs")
    .update({ status: "transcribing", claimed_at: new Date().toISOString(), stage_detail: "Claimed by worker" })
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select("*");
  if (error) {
    log("claim update failed", error.message);
    return null;
  }
  return data?.[0] ?? null; // empty → another worker won the race
}

// --- source resolution: ensure the raw video is in the bucket, return its path ---
async function resolveSource(job, workdir) {
  // Already a stored raw asset → read its storage_path.
  if (job.source_asset_id) {
    const { data } = await supabase
      .from("media_assets")
      .select("id, storage_path, title, mime_type")
      .eq("id", job.source_asset_id)
      .maybeSingle();
    if (!data?.storage_path) throw new Error("source media_asset has no storage_path");
    return { storagePath: data.storage_path, title: data.title, assetId: data.id };
  }

  // URL-only ingest → download, upload into creative-media/{org}/raw, register.
  if (!job.source_url) throw new Error("job has neither source_asset_id nor source_url");
  log("fetching source url", job.source_url);
  const res = await fetch(job.source_url);
  if (!res.ok) throw new Error(`source url fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "video/mp4";
  const nameGuess = safeName(new URL(job.source_url).pathname.split("/").pop() || "source.mp4");
  const storagePath = `${job.org_id}/raw/${randomUUID()}-${nameGuess}`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buf, { contentType, upsert: false });
  if (upErr) throw new Error(`raw upload failed: ${upErr.message}`);

  const { data: inserted, error: insErr } = await supabase
    .from("media_assets")
    .insert({
      org_id: job.org_id,
      brand_id: job.brand_id,
      folder: "raw",
      title: job.source_title || nameGuess,
      storage_path: storagePath,
      mime_type: contentType,
      size_bytes: buf.length,
      uploaded_by: job.requested_by,
      metadata: { ingested_by: "vesper", vesper_job_id: job.id, source_url: job.source_url },
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`raw media_assets insert failed: ${insErr.message}`);

  await updateJob(job.id, { source_asset_id: inserted.id });
  return { storagePath, title: job.source_title || nameGuess, assetId: inserted.id };
}

function safeName(name) {
  return (name.replace(/[^\w.\-]+/g, "_") || "file").slice(-120);
}

async function downloadToFile(storagePath, dest) {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error || !data) throw new Error(`download failed: ${error?.message || "no data"}`);
  const buf = Buffer.from(await data.arrayBuffer());
  await writeFile(dest, buf);
  return dest;
}

// --- STAGE 2a: transcription (OpenAI Whisper) -------------------------------
async function transcribe(videoFile, workdir) {
  // Extract mono 16kHz mp3 (small, Whisper-friendly), then split into chunks.
  const audioFile = join(workdir, "audio.mp3");
  await execFileP("ffmpeg", ["-y", "-i", videoFile, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioFile]);

  const chunkPattern = join(workdir, "chunk-%03d.mp3");
  await execFileP("ffmpeg", [
    "-y", "-i", audioFile, "-f", "segment",
    "-segment_time", String(AUDIO_CHUNK_SECONDS), "-c", "copy", chunkPattern,
  ]);
  const files = (await readdir(workdir)).filter((f) => /^chunk-\d+\.mp3$/.test(f)).sort();
  const chunks = files.length ? files : ["audio.mp3"];

  const cues = [];
  let language = null;
  for (let i = 0; i < chunks.length; i++) {
    const offset = i * AUDIO_CHUNK_SECONDS;
    const fpath = join(workdir, chunks[i]);
    const bytes = (await stat(fpath)).size;
    log(`transcribing chunk ${i + 1}/${chunks.length} (${Math.round(bytes / 1024)}KB, +${offset}s)`);
    const form = new FormData();
    const blob = new Blob([await readFile(fpath)], { type: "audio/mpeg" });
    form.append("file", blob, `chunk-${i}.mp3`);
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`whisper ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    language = language || json.language || null;
    for (const seg of json.segments || []) {
      const text = (seg.text || "").trim();
      if (!text) continue;
      cues.push({ start: (seg.start || 0) + offset, end: (seg.end || 0) + offset, text });
    }
  }
  const duration = cues.length ? cues[cues.length - 1].end : null;
  return { service: "openai-whisper", language, cues, duration_seconds: duration };
}

// --- STAGE 2b: segment selection (Anthropic) — mirrors lib/vesper/segment.ts ---
function stamp(s) {
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function buildSegmentSystemPrompt(opts) {
  return (
    "You are a short-form video editor for a Southeast Asian social-commerce agency. " +
    "You are given the timestamped transcript of a long video or livestream. Your job is to " +
    "select the strongest moments to cut into vertical short-form clips.\n\n" +
    "Bias HARD toward SELLABLE moments — the ones that move product: a scroll-stopping " +
    "HOOK, a product REVEAL or demo, a PRICE DROP / discount / deal callout, a strong CTA " +
    '("add to cart", "checkout", "cop now", "link in bio"), or a high-energy / emotional beat ' +
    "tied to a product. A self-contained useful thought counts too, but a selling moment always " +
    "wins over generic chatter. Each clip must stand alone without the surrounding context.\n\n" +
    "Rules:\n" +
    `- Return at most ${opts.max_clips} clips, best first.\n` +
    `- Each clip must be between ${opts.min_seconds} and ${opts.max_seconds} seconds long ` +
    "(end - start), snapped to natural sentence boundaries from the transcript.\n" +
    "- start/end are SECONDS from the beginning of the video (numbers, not strings).\n" +
    "- Never invent facts, prices, or claims not present in the transcript. Base the hook and " +
    "caption only on what is actually said.\n" +
    "- Clips must not overlap each other.\n\n" +
    "Respond with ONLY a JSON object, no prose, no markdown fences, of the exact shape:\n" +
    '{"clips":[{"start":number,"end":number,"title":string,"hook":string,"caption":string,"reason":string,"score":number}]}\n' +
    'score is your 0..1 confidence the clip will perform. If nothing is worth clipping, return {"clips":[]}.'
  );
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function coerceHighlights(raw, opts) {
  const clips = raw?.clips;
  if (!Array.isArray(clips)) return [];
  const out = [];
  for (const c of clips) {
    if (!c || typeof c !== "object") continue;
    const s = Math.max(0, Number(c.start));
    let e = Number(c.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    if (e - s < opts.min_seconds) e = s + opts.min_seconds;
    if (e - s > opts.max_seconds) e = s + opts.max_seconds;
    if (out.some((h) => s < h.end && e > h.start)) continue;
    const score = Number(c.score);
    out.push({
      start: Math.round(s * 100) / 100,
      end: Math.round(e * 100) / 100,
      title: String(c.title || "").trim().slice(0, 120) || "Untitled clip",
      hook: String(c.hook || "").trim().slice(0, 400),
      caption: String(c.caption || "").trim().slice(0, 1000),
      reason: String(c.reason || "").trim().slice(0, 500),
      score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0.5,
    });
    if (out.length >= opts.max_clips) break;
  }
  return out;
}

async function selectHighlights(transcript, opts) {
  if (!transcript.cues.length) return [];
  const lines = transcript.cues
    .slice(0, 1200)
    .map((c) => `[${stamp(c.start)}-${stamp(c.end)}] ${c.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: SEGMENT_MODEL,
      max_tokens: 2000,
      system: buildSegmentSystemPrompt(opts),
      messages: [{ role: "user", content: `Here is the transcript (timestamps are mm:ss). Select the clips.\n\n${lines}` }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return coerceHighlights(extractJson(text), opts);
}

// --- STAGE 3: cut a vertical clip with ffmpeg -------------------------------
async function cutClip(videoFile, clip, opts, outFile) {
  const { w, h } = frameSize(opts.aspect);
  // Scale to cover the frame then center-crop — fills 9:16 without letterboxing.
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
  const dur = Math.max(1, clip.end - clip.start);
  await execFileP("ffmpeg", [
    "-y",
    "-ss", String(clip.start),
    "-i", videoFile,
    "-t", String(dur),
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outFile,
  ]);
  return outFile;
}

async function makeThumbnail(clipFile, outFile) {
  try {
    await execFileP("ffmpeg", ["-y", "-ss", "0.5", "-i", clipFile, "-frames:v", "1", outFile]);
    return outFile;
  } catch {
    return null;
  }
}

// --- STAGE 4: store the clip + create a DRAFT (nothing publishes) -----------
async function storeClipAndDraft(job, source, clip, index, clipFile, thumbFile) {
  const clipBuf = await readFile(clipFile);
  const clipPath = `${job.org_id}/edited/${randomUUID()}-clip-${index + 1}.mp4`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(clipPath, clipBuf, { contentType: "video/mp4", upsert: false });
  if (upErr) throw new Error(`clip upload failed: ${upErr.message}`);

  let thumbPath = null;
  let thumbSignedUrl = null;
  if (thumbFile) {
    try {
      const tbuf = await readFile(thumbFile);
      thumbPath = `${job.org_id}/edited/${randomUUID()}-clip-${index + 1}.jpg`;
      const { error: tErr } = await supabase.storage
        .from(BUCKET)
        .upload(thumbPath, tbuf, { contentType: "image/jpeg", upsert: false });
      if (tErr) thumbPath = null;
      else {
        const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(thumbPath, 60 * 60 * 24 * 7);
        thumbSignedUrl = signed?.signedUrl || null;
      }
    } catch {
      thumbPath = null;
    }
  }

  const durationSeconds = Math.round((clip.end - clip.start) * 100) / 100;

  // 3) The cut clip is a media_assets row in the 'edited' folder, linked to its
  //    source + job via metadata (no schema change needed — metadata is jsonb).
  const { data: mediaRow, error: mErr } = await supabase
    .from("media_assets")
    .insert({
      org_id: job.org_id,
      brand_id: job.brand_id,
      folder: "edited",
      title: clip.title,
      storage_path: clipPath,
      mime_type: "video/mp4",
      size_bytes: clipBuf.length,
      uploaded_by: job.requested_by,
      notes: clip.hook,
      metadata: {
        produced_by: "vesper",
        vesper_job_id: job.id,
        source_asset_id: source.assetId,
        start_seconds: clip.start,
        end_seconds: clip.end,
        duration_seconds: durationSeconds,
        thumbnail_path: thumbPath,
        aspect: resolveOptions(job.options).aspect,
      },
    })
    .select("id")
    .single();
  if (mErr) throw new Error(`edited media_assets insert failed: ${mErr.message}`);

  // A long-lived signed URL so the reviewer can play the private clip directly.
  const { data: clipSigned } = await supabase.storage.from(BUCKET).createSignedUrl(clipPath, 60 * 60 * 24 * 7);

  // 4) Surface as a DRAFT content item + its short_clip Kit asset. status stays
  //    'idea'/'draft' — a human reviews and publishes; nothing auto-publishes.
  const { data: itemRow, error: iErr } = await supabase
    .from("content_items")
    .insert({
      org_id: job.org_id,
      brand_id: job.brand_id,
      title: clip.title,
      content_type: "video",
      status: "idea",
      sales_source: "video",
      brief: `HOOK\n${clip.hook}\n\nCAPTION\n${clip.caption}\n\nWhy this moment\n${clip.reason}`,
      notes: `Auto-clipped by Vesper Studio from ${source.title || "source video"} (${stamp(clip.start)}–${stamp(clip.end)}).`,
      created_by: job.requested_by,
    })
    .select("id")
    .single();
  if (iErr) throw new Error(`draft content_items insert failed: ${iErr.message}`);

  const { error: aErr } = await supabase.from("content_assets").insert({
    org_id: job.org_id,
    content_item_id: itemRow.id,
    brand_id: job.brand_id,
    kind: "short_clip",
    provider: "vesper",
    title: clip.title,
    url: clipSigned?.signedUrl || null,
    thumbnail_url: thumbSignedUrl,
    status: "draft",
    duration_seconds: durationSeconds,
    created_by: job.requested_by,
    meta: {
      vesper_job_id: job.id,
      media_asset_id: mediaRow.id,
      source_asset_id: source.assetId,
      storage_path: clipPath,
      start_seconds: clip.start,
      end_seconds: clip.end,
      hook: clip.hook,
      caption: clip.caption,
      reason: clip.reason,
      score: clip.score,
    },
  });
  if (aErr) throw new Error(`short_clip content_assets insert failed: ${aErr.message}`);

  return { mediaAssetId: mediaRow.id, contentItemId: itemRow.id };
}

// --- process one job end-to-end ---------------------------------------------
async function processJob(job) {
  const opts = resolveOptions(job.options);
  const workdir = await mkdtemp(join(tmpdir(), `vesper-${job.id.slice(0, 8)}-`));
  log("processing job", job.id, "opts", JSON.stringify(opts));
  try {
    // Resolve + download the source video.
    await updateJob(job.id, { status: "transcribing", stage_detail: "Fetching source" });
    const source = await resolveSource(job, workdir);
    const videoFile = join(workdir, "source");
    await downloadToFile(source.storagePath, videoFile);

    // Stage 2a — transcription (Whisper).
    await updateJob(job.id, { stage_detail: "Transcribing (OpenAI Whisper)" });
    const transcript = await transcribe(videoFile, workdir);
    await updateJob(job.id, {
      transcript,
      transcript_service: transcript.service,
      status: "segmenting",
      stage_detail: `Transcribed ${transcript.cues.length} cues — selecting highlights`,
    });

    // Stage 2b — segment selection (Anthropic).
    const highlights = await selectHighlights(transcript, opts);
    await updateJob(job.id, { segments: highlights, segment_model: SEGMENT_MODEL });
    if (!highlights.length) {
      await updateJob(job.id, {
        status: "done",
        stage_detail: "No clip-worthy highlights found",
        completed_at: new Date().toISOString(),
      });
      log("job", job.id, "→ done (no highlights)");
      return;
    }

    // Stage 3 + 4 — cut each clip and create a draft.
    await updateJob(job.id, { status: "clipping", stage_detail: `Cutting ${highlights.length} clip(s)` });
    let created = 0;
    for (let i = 0; i < highlights.length; i++) {
      const clip = highlights[i];
      log(`cutting clip ${i + 1}/${highlights.length}: ${stamp(clip.start)}–${stamp(clip.end)}`);
      const clipFile = join(workdir, `clip-${i + 1}.mp4`);
      await cutClip(videoFile, clip, opts, clipFile);
      const thumbFile = await makeThumbnail(clipFile, join(workdir, `clip-${i + 1}.jpg`));
      await updateJob(job.id, { status: "drafting", stage_detail: `Drafting clip ${i + 1}/${highlights.length}` });
      await storeClipAndDraft(job, source, clip, i, clipFile, thumbFile);
      created++;
      await updateJob(job.id, { clips_created: created });
    }

    await updateJob(job.id, {
      status: "done",
      clips_created: created,
      stage_detail: `Created ${created} clip draft(s) for review`,
      completed_at: new Date().toISOString(),
    });
    log("job", job.id, `→ done (${created} clips)`);
  } catch (e) {
    log("job", job.id, "FAILED", e.message);
    await updateJob(job.id, {
      status: "failed",
      error: String(e.message || e).slice(0, 1000),
      completed_at: new Date().toISOString(),
    });
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- main loop --------------------------------------------------------------
async function main() {
  log("started. model", SEGMENT_MODEL, "oneshot", Boolean(process.env.VESPER_ONESHOT));
  // Fail fast if ffmpeg is missing — this worker is pointless without it.
  try {
    await execFileP("ffmpeg", ["-version"]);
    await execFileP("ffprobe", ["-version"]);
  } catch {
    log("FATAL: ffmpeg/ffprobe not found on PATH. Install ffmpeg and retry.");
    process.exit(1);
  }

  const oneshot = Boolean(process.env.VESPER_ONESHOT);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let job = null;
    try {
      job = await claimNextJob();
    } catch (e) {
      log("claim error", e.message);
    }
    if (job) {
      await processJob(job);
      if (oneshot) break;
    } else {
      if (oneshot) {
        log("no queued jobs — exiting (oneshot)");
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

main().catch((e) => {
  console.error("[vesper-worker] fatal", e);
  process.exit(1);
});
