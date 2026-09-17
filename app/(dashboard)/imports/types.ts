// Shared types for the Bulk Import UI + server actions. Kept in a plain module
// (NOT the "use server" actions file, which may only export async functions) so
// both the client wizard and the server actions can import them.

import type { EntityType } from "@/lib/import/registry";
import type { PreviewResult } from "@/lib/import/engine";

export interface ColumnMeta {
  key: string;
  label: string;
  required: boolean;
  note?: string;
}

export type PreviewState =
  | null
  | {
      ok: boolean;
      error?: string;
      entity?: EntityType;
      fileName?: string;
      fileSize?: number;
      // 1-based index of the detected header row (not assumed to be row 1).
      headerRow?: number;
      csv?: string;
      headers?: string[];
      columns?: ColumnMeta[];
      mapping?: Record<number, string>;
      // Present header columns left unmapped (shown as "ignored: …" in preview).
      ignoredColumns?: string[];
      // Products only: the distinct brand cell value → resolved client name.
      resolvedBrands?: Array<{ value: string; brand: string }>;
      preview?: PreviewResult;
      droppedRows?: number;
    };

export type CommitState =
  | null
  | {
      ok: boolean;
      error?: string;
      entity?: EntityType;
      imported?: number;
      duplicates?: number;
      invalid?: number;
      total?: number;
      droppedRows?: number;
      message?: string;
      // First rows that did NOT import, capped at 10 + "…and N more" so a bad file
      // shows a bounded list inline instead of one line per row (full set is in the
      // downloadable report).
      errorLines?: string[];
      report?: Array<{ line: number; status: string; label: string; reason: string }>;
    };
