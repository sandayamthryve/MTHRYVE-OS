"use client";
// components/vesper/VesperUploadCard.tsx
// Vesper Studio ▸ Ingest. Uploads a TikTok LIVE replay file to Cloudinary via a
// SIGNED DIRECT upload (browser → Cloudinary), then creates a vesper_clip_jobs
// row. The file bytes NEVER pass through Vercel — replays are large, so proxying
// them would blow the serverless body/time limits.
//
// Flow:
//   1. POST /api/vesper/upload-signature  → { signature, timestamp, apiKey,
//      cloudName, folder }                  (server-side; the API secret stays there)
//   2. POST the file DIRECTLY to https://api.cloudinary.com/v1_1/<cloud>/video/upload
//      with the signature (XHR, so we can show a real upload progress bar)
//   3. POST /api/vesper/jobs with the Cloudinary result → { job_id }
//
// resource_type=video only: non-video files are rejected before any request.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Brand = { id: string; name: string };

type Phase = "idle" | "signing" | "uploading" | "creating" | "done" | "error";

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Signature response from our own route.
type SignatureResponse = {
  ok?: boolean;
  error?: string;
  detail?: string;
  signature?: string;
  timestamp?: number;
  apiKey?: string;
  cloudName?: string;
  folder?: string;
};

// The subset of Cloudinary's upload response we care about.
type CloudinaryResult = {
  secure_url?: string;
  public_id?: string;
  duration?: number;
  bytes?: number;
  format?: string;
  error?: { message?: string };
};

export function VesperUploadCard({ brands }: { brands: Brand[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [brandId, setBrandId] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const busy = phase === "signing" || phase === "uploading" || phase === "creating";
  const isVideo = file ? file.type.startsWith("video/") : false;
  const canSubmit = Boolean(file) && isVideo && !busy;

  function pickFile(f: File | null) {
    setMessage(null);
    if (phase === "done" || phase === "error") setPhase("idle");
    if (f && !f.type.startsWith("video/")) {
      setFile(null);
      setPhase("error");
      setMessage("That isn't a video file. Vesper only accepts video replays.");
      return;
    }
    setFile(f);
    // Pre-fill the title from the filename (minus extension) when empty.
    if (f && !title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  // Upload directly to Cloudinary via XHR so we get progress events. Resolves the
  // parsed JSON result, rejects with a friendly message on any failure.
  function uploadToCloudinary(uploadUrl: string, form: FormData): Promise<CloudinaryResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", uploadUrl);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let parsed: CloudinaryResult = {};
        try {
          parsed = JSON.parse(xhr.responseText) as CloudinaryResult;
        } catch {
          reject(new Error("Cloudinary returned an unreadable response."));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && parsed.secure_url) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error?.message || `Upload failed (HTTP ${xhr.status}).`));
        }
      };
      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.onabort = () => reject(new Error("Upload canceled."));
      xhr.send(form);
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setPhase("error");
      setMessage("That isn't a video file. Vesper only accepts video replays.");
      return;
    }

    setProgress(0);
    setMessage(null);

    // 1) Signature (server-side; gated).
    setPhase("signing");
    let sig: SignatureResponse;
    try {
      const res = await fetch("/api/vesper/upload-signature", { method: "POST" });
      sig = (await res.json()) as SignatureResponse;
      if (!res.ok || !sig.ok || !sig.signature || !sig.cloudName || !sig.apiKey) {
        setPhase("error");
        setMessage(sig.detail || "Could not start the upload. You may not have access, or Cloudinary isn't configured.");
        return;
      }
    } catch {
      setPhase("error");
      setMessage("Could not reach the signing service. Try again.");
      return;
    }

    // 2) Direct upload to Cloudinary. Send EXACTLY the signed params + the file.
    setPhase("uploading");
    const uploadUrl = `https://api.cloudinary.com/v1_1/${sig.cloudName}/video/upload`;
    const form = new FormData();
    form.append("file", file);
    form.append("api_key", sig.apiKey);
    form.append("timestamp", String(sig.timestamp));
    form.append("signature", sig.signature);
    if (sig.folder) form.append("folder", sig.folder);

    let result: CloudinaryResult;
    try {
      result = await uploadToCloudinary(uploadUrl, form);
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Upload failed.");
      return;
    }

    // 3) Create the job pointing at the Cloudinary secure_url.
    setPhase("creating");
    try {
      const res = await fetch("/api/vesper/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_url: result.secure_url,
          public_id: result.public_id,
          title: title.trim() || file.name,
          duration: typeof result.duration === "number" ? result.duration : undefined,
          bytes: typeof result.bytes === "number" ? result.bytes : undefined,
          format: result.format,
          brand_id: brandId || null,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; job_id?: string; error?: string };
      if (!res.ok || !data.ok) {
        setPhase("error");
        setMessage("The file uploaded, but the clip job couldn't be created. Try again.");
        return;
      }
    } catch {
      setPhase("error");
      setMessage("The file uploaded, but the clip job couldn't be created. Try again.");
      return;
    }

    // Done — reset the form and refresh the jobs list below.
    setPhase("done");
    setMessage("Replay uploaded and queued. The clipping worker will pick it up.");
    setFile(null);
    setTitle("");
    setBrandId("");
    setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  const fieldCls =
    "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink placeholder:text-ink-dim";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Brand</span>
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            disabled={busy}
            className={fieldCls}
          >
            <option value="">— None —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy}
            placeholder="e.g. Friday night LIVE — Acme"
            maxLength={300}
            className={fieldCls}
          />
        </label>
      </div>

      {/* File picker — video only. */}
      <label
        onDragOver={(e) => {
          if (busy) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (busy) return;
          e.preventDefault();
          setDragging(false);
          const dropped = e.dataTransfer.files?.[0] ?? null;
          if (inputRef.current && e.dataTransfer.files?.length) {
            inputRef.current.files = e.dataTransfer.files;
          }
          pickFile(dropped);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition ${
          dragging
            ? "border-teal-400 bg-teal-500/10"
            : file && isVideo
              ? "border-teal-500/50 bg-teal-500/5"
              : "border-charcoal-700 bg-charcoal-950 hover:border-teal-500/50"
        } ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        <span aria-hidden className="text-3xl opacity-70">
          🎥
        </span>
        {file ? (
          <span className="text-sm font-medium text-ink">
            {file.name} <span className="font-mono text-ink-dim">({bytesLabel(file.size)})</span>
          </span>
        ) : (
          <>
            <span className="text-sm font-medium text-ink">Choose a replay video, or drop it here</span>
            <span className="text-xs text-ink-muted">Video only — uploads straight to Cloudinary, not through the app.</span>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="sr-only"
          disabled={busy}
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
      </label>

      {/* Progress — only while uploading the bytes. */}
      {phase === "uploading" && (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-charcoal-800">
            <div
              className="h-full rounded-full bg-teal-500 transition-[width] duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="font-mono text-[10px] text-ink-dim">Uploading to Cloudinary — {progress}%</p>
        </div>
      )}

      {message && (
        <p
          className={`text-sm ${
            phase === "error" ? "text-red-300" : phase === "done" ? "text-teal-300" : "text-ink-muted"
          }`}
        >
          {message}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-50"
        >
          {phase === "signing"
            ? "Preparing…"
            : phase === "uploading"
              ? "Uploading…"
              : phase === "creating"
                ? "Queuing…"
                : "Upload & queue clip job"}
        </button>
        {file && !busy && (
          <button
            type="button"
            onClick={() => {
              setFile(null);
              setMessage(null);
              if (phase !== "done") setPhase("idle");
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="text-sm text-ink-muted hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>
    </form>
  );
}
