// Extracts plain text from an uploaded document so it can be chunked + embedded.
// One entry point per supported type:
//   • pdf  → pdf-parse
//   • docx → mammoth (raw text, styles discarded)
//   • txt / md → decoded as UTF-8 (markdown is embedded as-is; its syntax is
//     low-noise and keeps headings/lists that help retrieval)
//
// Node-only (pdf-parse and mammoth both need the Node runtime). Callers pass the
// raw file bytes plus the extension derived from the stored filename.

export type ExtractableExt = "pdf" | "docx" | "txt" | "md";

const EXT_BY_KEY: Record<string, ExtractableExt> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  md: "md",
  markdown: "md",
  text: "txt",
};

/** Map a filename or bare extension to a supported type, or null if unsupported. */
export function extForFilename(name: string): ExtractableExt | null {
  const dot = name.lastIndexOf(".");
  const raw = (dot >= 0 ? name.slice(dot + 1) : name).toLowerCase().trim();
  return EXT_BY_KEY[raw] ?? null;
}

/** Human list of accepted uploads, for the file input + error copy. */
export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"] as const;

export class ExtractionError extends Error {
  reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "ExtractionError";
    this.reason = reason;
  }
}

/**
 * Extract text from `bytes` given its type. Throws ExtractionError when the file
 * can't be parsed or yields no usable text (e.g. a scanned/image-only PDF).
 */
export async function extractText(bytes: Buffer, ext: ExtractableExt): Promise<string> {
  let text: string;

  switch (ext) {
    case "pdf": {
      try {
        // Import the library's inner module directly: the package's index.js
        // runs a debug branch that reads a bundled test PDF when it thinks it's
        // the entry module, which breaks under bundlers. The lib entry is pure.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - no bundled types for the subpath
        const mod = await import("pdf-parse/lib/pdf-parse.js");
        const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>;
        const parsed = await pdfParse(bytes);
        text = parsed.text ?? "";
      } catch (e) {
        console.error("[knowledge] pdf extract failed", e);
        throw new ExtractionError("pdf-parse", "Could not read this PDF.");
      }
      break;
    }
    case "docx": {
      try {
        const mammoth = (await import("mammoth")).default;
        const { value } = await mammoth.extractRawText({ buffer: bytes });
        text = value ?? "";
      } catch (e) {
        console.error("[knowledge] docx extract failed", e);
        throw new ExtractionError("mammoth", "Could not read this Word document.");
      }
      break;
    }
    case "txt":
    case "md": {
      text = bytes.toString("utf-8");
      break;
    }
    default: {
      throw new ExtractionError("unsupported", `Unsupported file type: ${ext}`);
    }
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new ExtractionError(
      "empty",
      "No extractable text was found (a scanned or image-only file?)."
    );
  }
  return trimmed;
}
