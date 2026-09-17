import { canAccessModulePath, isWorkspaceRole, pathOnly, type WorkspaceRole } from "./module-access";

export const DEV_SESSION_COOKIE = "mthryve_dev_demo";
export const DEV_ROLE_COOKIE = "mthryve_dev_role";
export const PREVIEW_PATH_HEADER = "x-mthryve-preview-path";
export const PREVIEW_QUERY_HEADER = "x-mthryve-preview-query";

// Missing means the existing operator session. Invalid values must not elevate
// to operator; the role endpoint can reset a malformed preference explicitly.
export function resolvePreviewRole(value: string | undefined): WorkspaceRole | null {
  return value === undefined ? "operator" : isWorkspaceRole(value) ? value : null;
}

const API_MODULES: readonly [RegExp, string][] = [
  // Named exhaustively rather than by prefix, so /api/finance/expenses/... never
  // becomes a wildcard that admits a route added later without review.
  [/^\/api\/finance\/expenses(\/export\/(csv|pdf|xlsx)|\/attachments)?$/, "/finance/expenses"],
  [/^\/api\/content-calendar\/export\/(pdf|xlsx)$/, "/content-calendar"],
  [/^\/api\/content-studio\/generate$/, "/creative-studio"],
  [/^\/api\/vesper\/(jobs(\/[^/]+(\/segment)?)?|ingest|segment|transcribe|upload-signature)$/, "/studio/vesper"],
  [/^\/api\/knowledge\/ingest$/, "/knowledge"],
];

export function canAccessPreviewRequest(
  role: WorkspaceRole | null, value: string, search = ""
): boolean {
  const path = pathOnly(value);
  if (!role || !path) return false;
  if (role === "operator") return true;

  // All preview roles share the dashboard shell/home. This does NOT grant any
  // extra module/API permission; destination pages and APIs remain role-scoped.
  if (["/", "/home", "/workspace", "/access-denied", "/api/dev/role"].includes(path)) return true;

  if (!path.startsWith("/api/")) return canAccessModulePath(role, path);
  // Shared metrics APIs must name a permitted department. No unscoped reads.
  if (/^\/api\/metrics\/(entries|export)$/.test(path)) {
    const departments = new URLSearchParams(search).getAll("department");
    return departments.length === 1 &&
      canAccessModulePath(role, `/analytics/${departments[0]}`);
  }
  const module = API_MODULES.find(([pattern]) => pattern.test(path))?.[1];
  return !!module && canAccessModulePath(role, module);
}
