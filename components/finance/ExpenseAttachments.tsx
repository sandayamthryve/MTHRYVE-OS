"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_KINDS,
  ATTACHMENT_KIND_LABEL,
  MAX_ATTACHMENT_BYTES,
  checkAttachment,
  type AttachmentKind,
} from "@/lib/expenses/attachments";

export type ExpenseAttachment = {
  id: string;
  file_name: string;
  kind: string;
  byte_size: number;
  created_at: string;
};

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The Docs cell: a count that opens the documents for one expense.
 *
 * Attachments are listed by the server with the row, so the closed state costs
 * nothing and the count is right before anyone clicks. Uploading goes straight
 * to the API route rather than a server action, because a server action would
 * have to carry the file through a form post and we already have an endpoint
 * that validates and stores it.
 */
export function ExpenseAttachments({
  expenseId,
  attachments,
  canUpload,
}: {
  expenseId: string;
  attachments: ExpenseAttachment[];
  canUpload: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<AttachmentKind>("official_receipt");
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    // Check before the round trip so an obviously wrong file fails instantly
    // with the same message the server would give. The server re-checks; this
    // is for the person, not for safety.
    const check = checkAttachment(file.name, file.size, file.type);
    if (!check.ok) {
      setError(check.reason);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("expense_id", expenseId);
      body.set("kind", kind);
      body.set("file", file);

      const response = await fetch("/api/finance/expenses/attachments", { method: "POST", body });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error ?? "Could not attach that file.");
        return;
      }
      if (fileRef.current) fileRef.current.value = "";
      // The row's count is server-rendered, so refresh rather than patch local
      // state — otherwise the badge and the list disagree after a failure.
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const count = attachments.length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={count ? `${count} document${count === 1 ? "" : "s"}` : "No documents yet"}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-bold transition ${
          count
            ? "border-teal-400/40 bg-teal-400/10 text-teal-300 hover:bg-teal-400/20"
            : "border-charcoal-700 text-ink-muted hover:text-ink"
        }`}
      >
        <span aria-hidden>📎</span>
        {count || "—"}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[320px] rounded-xl border border-charcoal-700 bg-charcoal-900 p-3 shadow-[0_18px_44px_rgba(0,0,0,.55)]">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-bold text-ink">Supporting documents</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close documents"
              className="text-ink-muted hover:text-ink"
            >
              ×
            </button>
          </div>

          {count === 0 ? (
            <p className="text-xs text-ink-muted">Nothing attached yet.</p>
          ) : (
            <ul className="mb-3 space-y-1.5">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2 text-xs">
                  <a
                    href={`/api/finance/expenses/attachments?id=${encodeURIComponent(a.id)}`}
                    className="min-w-0 flex-1 truncate text-teal-300 hover:underline"
                    title={a.file_name}
                  >
                    {a.file_name}
                  </a>
                  <span className="shrink-0 text-ink-dim">
                    {ATTACHMENT_KIND_LABEL[a.kind as AttachmentKind] ?? a.kind} · {readableSize(a.byte_size)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {canUpload && (
            <div className="border-t border-charcoal-700 pt-2.5">
              <label className="block text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                Document type
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as AttachmentKind)}
                  className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                >
                  {ATTACHMENT_KINDS.map((k) => (
                    <option key={k} value={k}>{ATTACHMENT_KIND_LABEL[k]}</option>
                  ))}
                </select>
              </label>

              <input
                ref={fileRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
                className="mt-2 block w-full text-xs text-ink-muted file:mr-2 file:rounded-md file:border-0 file:bg-teal-400 file:px-2 file:py-1 file:text-xs file:font-bold file:text-charcoal-950"
              />
              <p className="mt-1 text-[10px] text-ink-dim">
                PDF, JPG, PNG, DOCX, XLSX · up to {Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB
              </p>
              {busy && <p className="mt-1 text-[10px] text-teal-300">Uploading…</p>}
            </div>
          )}

          {error && (
            <p role="alert" className="mt-2 text-[11px] font-semibold text-red-400">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
