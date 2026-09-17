"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import { type WorkspaceRole } from "@/lib/auth/module-access";

import { canAccessPreviewRequest } from "@/lib/auth/preview-access";

const PreviewRoleContext = createContext<WorkspaceRole | undefined>(undefined);

export function ModuleAccessProvider({ role, children }: {
  role?: WorkspaceRole; children: React.ReactNode;
}) {
  return <PreviewRoleContext.Provider value={role}>{children}</PreviewRoleContext.Provider>;
}

export function useModuleAccess() {
  const role = useContext(PreviewRoleContext);
  return (href: string) => role === undefined || canAccessPreviewRequest(role, href, href.includes("?") ? href.slice(href.indexOf("?")) : "");
}

// Navigation convenience only. Every destination is also guarded server-side.
export function ModuleLink(props: React.ComponentProps<typeof Link>) {
  const canAccess = useModuleAccess();
  if (typeof props.href === "string" && props.href.startsWith("/") && !canAccess(props.href)) return null;
  return <Link {...props} />;
}
