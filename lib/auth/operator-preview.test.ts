import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => state.cookies.has(name) ? { value: state.cookies.get(name) } : undefined }),
  headers: () => ({ get: (name: string) => state.headers.get(name) ?? null }),
}));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn(() => { throw new Error("Unexpected database access"); }) }));

import { middleware } from "../../middleware";
import { POST } from "../../app/api/dev/role/route";
import { getSessionProfile, requireModule, requireRole } from "./session";
import { DEV_SESSION_COOKIE, DEV_ROLE_COOKIE, PREVIEW_PATH_HEADER, PREVIEW_QUERY_HEADER } from "./preview-access";

beforeEach(() => {
  vi.stubEnv("DEV_CHANNEL_BYPASS_AUTH", "true");
  vi.stubEnv("AGENT_MOCK_MODE", "true");
  vi.stubEnv("APP_GATE_ENABLED", "false");
  state.cookies.clear(); state.headers.clear();
});
afterEach(() => vi.unstubAllEnvs());

function request(path: string, role?: string, method = "GET") {
  return new NextRequest(`https://dev.example${path}`, {
    method,
    headers: {
      cookie: `${DEV_SESSION_COOKIE}=active${role === undefined ? "" : `; ${DEV_ROLE_COOKIE}=${role}`}`,
      origin: "https://dev.example",
      [PREVIEW_PATH_HEADER]: "/finance",
    },
  });
}

describe("operator-only role endpoint", () => {
  it("rejects requests without an existing operator session", async () => {
    const response = await POST(new NextRequest("https://dev.example/api/dev/role", { method: "POST" }));
    expect(response.status).toBe(401);
  });
  it("is unavailable outside devchannel preview", async () => {
    vi.stubEnv("DEV_CHANNEL_BYPASS_AUTH", "false"); vi.stubEnv("AGENT_MOCK_MODE", "false");
    expect((await POST(request("/api/dev/role", "operator", "POST"))).status).toBe(404);
  });
  it("switches a scoped view back to operator without creating any identity", async () => {
    const response = await POST(new NextRequest(request("/api/dev/role", "hr", "POST"), { body: JSON.stringify({ role: "operator" }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: "operator", href: "/" });
    expect(response.cookies.get(DEV_ROLE_COOKIE)).toMatchObject({ value: "operator", httpOnly: true, sameSite: "lax", secure: true });
  });
  it("rejects unknown roles and cross-origin changes", async () => {
    const invalid = new NextRequest(request("/api/dev/role", "operator", "POST"), { body: JSON.stringify({ role: "ceo" }) });
    expect((await POST(invalid)).status).toBe(400);
    const external = new NextRequest(request("/api/dev/role", "operator", "POST"), { headers: { cookie: `${DEV_SESSION_COOKIE}=active`, origin: "https://evil.example" }, body: JSON.stringify({ role: "finance" }) });
    expect((await POST(external)).status).toBe(403);
  });
  it("accepts the original host when Next normalizes the internal URL", async () => {
    const response = await POST(new NextRequest("http://localhost:3106/api/dev/role", {
      method: "POST",
      headers: { host: "127.0.0.1:3106", origin: "http://127.0.0.1:3106", cookie: `${DEV_SESSION_COOKIE}=active` },
      body: JSON.stringify({ role: "cs" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: "cs", href: "/" });
  });
});

describe("preview request enforcement", () => {
  it("rejects unauthenticated API requests", async () => {
    const response = await middleware(new NextRequest("https://dev.example/api/os/snapshot"));
    expect(response.status).toBe(401);
  });
  it("redirects restricted pages and returns 403 for APIs and action posts", async () => {
    const page = await middleware(request("/payroll", "hr"));
    expect(page.headers.get("location")).toBe("https://dev.example/access-denied");
    expect((await middleware(request("/api/finance/expenses", "hr"))).status).toBe(403);
    expect((await middleware(request("/payroll", "hr", "POST"))).status).toBe(403);
    // The attachment upload is part of the expenses module, so it follows that
    // module's access — open to finance, closed to hr — rather than being
    // reachable just because it sits under the same path prefix.
    expect((await middleware(request("/api/finance/expenses/attachments", "hr", "POST"))).status).toBe(403);
    expect((await middleware(request("/api/finance/expenses/attachments", "finance", "POST"))).status).not.toBe(403);
    // A sibling route nobody has reviewed must NOT inherit the grant.
    expect((await middleware(request("/api/finance/expenses/anything", "finance", "POST"))).status).toBe(403);
  });
  it("overwrites spoofed request-path headers and disables shared caching", async () => {
    const response = await middleware(request("/warehouse/rts", "cs"));
    expect(response.headers.get(`x-middleware-request-${PREVIEW_PATH_HEADER}`)).toBe("/warehouse/rts");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("serves the shared dashboard at / instead of looping, and sends scoped roles to their own home", async () => {
    // A role whose home IS "/" must render it: redirecting "/" to "/" was an
    // infinite loop. Only a path that is NOT already home may redirect there.
    // E-Commerce is used here because it still homes at "/" -- Finance used to
    // and no longer does, which is why this case needs a role named on purpose
    // rather than whichever one happened to be unscoped at the time.
    expect((await middleware(request("/", "ecom"))).headers.get("location")).toBeNull();
    expect((await middleware(request("/home", "ecom"))).headers.get("location")).toBe("https://dev.example/");
    // HR opens on the Review Gate, so "/" does redirect for that role -- and the
    // destination must not bounce back, or the loop returns in a new shape.
    expect((await middleware(request("/", "hr"))).headers.get("location")).toBe("https://dev.example/reviewgate");
    expect((await middleware(request("/reviewgate", "hr"))).headers.get("location")).toBeNull();
    // Finance opens on its own dashboard rather than the shared company board,
    // and that destination must not bounce back either.
    expect((await middleware(request("/", "finance"))).headers.get("location")).toBe("https://dev.example/finance/dashboard");
    expect((await middleware(request("/home", "finance"))).headers.get("location")).toBe("https://dev.example/finance/dashboard");
    expect((await middleware(request("/finance/dashboard", "finance"))).headers.get("location")).toBeNull();
  });
  it("keeps denial redirects on the original host so the session is retained", async () => {
    const response = await middleware(new NextRequest("http://localhost:3106/payroll", {
      headers: { host: "127.0.0.1:3106", cookie: `${DEV_SESSION_COOKIE}=active; ${DEV_ROLE_COOKIE}=hr` },
    }));
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3106/access-denied");
  });
  it("requires a valid session even when mock mode is enabled", async () => {
    expect(await getSessionProfile()).toBeNull();
  });
  it("enforces module checks without granting privileged action roles", async () => {
    state.cookies.set(DEV_SESSION_COOKIE, "active"); state.cookies.set(DEV_ROLE_COOKIE, "finance");
    state.headers.set(PREVIEW_PATH_HEADER, "/payroll"); state.headers.set(PREVIEW_QUERY_HEADER, "");
    expect((await requireModule("/payroll")).role).toBe("team_member");
    await expect(requireRole(["ceo", "coo"])).rejects.toThrow("redirect:/");
    await expect(requireModule("/people")).rejects.toThrow("redirect:/access-denied");
    state.headers.set(PREVIEW_PATH_HEADER, "/people");
    expect(await getSessionProfile()).toBeNull();
  });
});
