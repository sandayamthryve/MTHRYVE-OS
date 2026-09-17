"use client";
// components/creative-studio/MediaUploader.tsx
// The Media Library's drag-and-drop upload zone. Purely a client-side UX shell:
// it collects files (drop or picker), lets the user choose the target folder +
// brand, and submits to the server action, which does the RLS-scoped upload into
// the private creative-media bucket and the media_assets insert. No file data or
// storage credentials touch the client beyond the File objects the browser holds.

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-50"
    >
      {pending
        ? "Uploading…"
        : count > 0
          ? `Upload ${count} file${count === 1 ? "" : "s"}`
          : "Upload"}
    </button>
  );
}

export function MediaUploader({
  folders,
  folder,
  brands,
  brand,
  action,
}: {
  folders: { value: string; label: string }[];
  folder: string;
  brands: { id: string; name: string }[];
  brand: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<{ name: string; size: number }[]>([]);
  const [dragging, setDragging] = useState(false);

  const defaultFolder = folders.some((f) => f.value === folder) ? folder : folders[0]?.value;

  function readFiles(list: FileList | null) {
    setFiles(
      list ? Array.from(list).map((f) => ({ name: f.name, size: f.size })) : []
    );
  }

  return (
    <form action={action} className="space-y-3">
      {/* Carry the active filters so the redirect returns to the same view. */}
      <input type="hidden" name="brand" value={brand} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Folder
          </span>
          <select
            name="folder"
            defaultValue={defaultFolder}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          >
            {folders.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Brand (optional)
          </span>
          <select
            name="brand_id"
            defaultValue={brand}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          >
            <option value="">— None —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Drop zone — a big label over the (visually hidden) multi-file input. */}
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (inputRef.current && e.dataTransfer.files.length) {
            inputRef.current.files = e.dataTransfer.files;
            readFiles(e.dataTransfer.files);
          }
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition ${
          dragging
            ? "border-teal-400 bg-teal-500/10"
            : "border-charcoal-700 bg-charcoal-950 hover:border-teal-500/50"
        }`}
      >
        <span aria-hidden className="text-3xl opacity-70">
          ⬆️
        </span>
        <span className="text-sm font-medium text-ink">
          Drag &amp; drop files here, or click to browse
        </span>
        <span className="text-xs text-ink-muted">Videos, images, and graphics — multiple at once.</span>
        <input
          ref={inputRef}
          type="file"
          name="files"
          multiple
          className="sr-only"
          onChange={(e) => readFiles(e.target.files)}
        />
      </label>

      {files.length > 0 && (
        <ul className="space-y-1 rounded-md border border-charcoal-700/60 bg-charcoal-950 p-2 text-xs text-ink-muted">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 font-mono text-ink-dim">{bytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <UploadButton count={files.length} />
        {files.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (inputRef.current) inputRef.current.value = "";
              setFiles([]);
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
