import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/cancas");
  vi.stubEnv("SUB2API_MANAGED_MODE", "true");
  vi.stubEnv("NEXT_PUBLIC_SUB2API_MANAGED_MODE", "true");
  vi.stubEnv("HELIOS_PUBLIC_ORIGIN", "https://patrickapi.microedulab.com");
  vi.stubEnv("HELIOS_SESSION_SECRET", randomBytes(32).toString("base64"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("prefixed managed deployment", () => {
  it("routes local requests exactly once without altering upstream URLs", async () => {
    const { appPath, logicalAppPath, appFetch, normalizeAppBasePath } = await import("@/lib/appPaths");
    expect(appPath("/api/gallery?q=1")).toBe("/cancas/api/gallery?q=1");
    expect(appPath("/cancas/api/gallery")).toBe("/cancas/api/gallery");
    expect(appPath("/cancas-other/api/gallery")).toBe("/cancas/cancas-other/api/gallery");
    expect(logicalAppPath("/cancas/api/media/a")).toBe("/api/media/a");
    expect(logicalAppPath("/api/media/a")).toBe("/api/media/a");
    expect(appPath("https://upstream.test/v1")).toBe("https://upstream.test/v1");
    expect(appPath("blob:example")).toBe("blob:example");
    expect(appPath(undefined)).toBeUndefined();
    for (const invalid of ["https://test/cancas", "//test", "/../cancas", "/cancas%2fapi"]) expect(() => normalizeAppBasePath(invalid)).toThrow();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(String(input)));
    vi.stubGlobal("fetch", fetchMock);
    await appFetch("/api/health");
    await appFetch("https://upstream.test/v1");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/cancas/api/health", "https://upstream.test/v1"]);
  });

  it("scopes new cookies to the app and never accepts the old cookie name", async () => {
    const session = await import("@/lib/sub2api/session");
    const now = Math.floor(Date.now() / 1000);
    const value = { userId: "owner", apiBaseUrl: "https://api.test/v1", apiKey: "synthetic-key", iat: now, exp: now + 600 };
    const response = NextResponse.json({ ok: true });
    session.setSessionCookie(response, value);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Secure-helios_session=");
    expect(cookie).toContain("Path=/cancas");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toContain("synthetic-key");
    const sealed = session.sealSession(value);
    expect(session.readSession(new Request("https://patrickapi.microedulab.com/cancas/workflow", { headers: { cookie: `__Host-helios_session=${sealed}` } }))).toBeNull();
    session.clearSessionCookie(response);
    expect(response.headers.get("set-cookie")).toContain("Path=/cancas");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("treats malformed cookie encoding as anonymous instead of throwing", async () => {
    const session = await import("@/lib/sub2api/session");
    const request = new Request("https://patrickapi.microedulab.com/cancas/workflow", {
      headers: { cookie: `${session.SESSION_COOKIE}=%E0%A4%A` },
    });
    expect(session.readSession(request)).toBeNull();
  });

  it("keeps bootstrap, public assets and APIs under the prefix", async () => {
    const { proxy } = await import("@/proxy");
    const origin = "https://patrickapi.microedulab.com";
    const page = await proxy(new NextRequest(`${origin}/cancas/workflow`));
    expect(page.headers.get("location")).toBe(`${origin}/cancas/bootstrap?reason=session_expired`);
    const api = await proxy(new NextRequest(`${origin}/cancas/api/spaces`));
    expect(api.status).toBe(401);
    const asset = await proxy(new NextRequest(`${origin}/cancas/HG.svg`));
    expect(asset.headers.get("location")).toBeNull();
    const recovery = await proxy(new NextRequest(`${origin}/cancas/legacy-recovery.html`));
    expect(recovery.headers.get("location")).toBeNull();
  });

  it("prefixes signed URLs while keeping old-domain signatures valid", async () => {
    const signatures = await import("@/lib/mediaSignature");
    const url = new URL(signatures.createMediaSignature("asset", "owner", "https://patrickapi.microedulab.com"));
    expect(url.pathname).toBe("/cancas/api/media/asset");
    expect(signatures.verifyMediaSignature("asset", "owner", url.searchParams.get("expires"), url.searchParams.get("sig"))).toBe(true);
    const callback = new URL(signatures.createKieCallbackUrl("https://patrickapi.microedulab.com", signatures.createKieCallbackNonce()));
    expect(callback.pathname).toBe("/cancas/api/callback");
    callback.hostname = "canvas.sub.sunmmyapi.xyz";
    callback.pathname = "/api/callback";
    expect(signatures.verifyKieCallbackSignature(callback.searchParams.get("expires"), callback.searchParams.get("nonce"), callback.searchParams.get("sig"))).toBe(true);
    expect(signatures.verifyMediaSignature("asset", "another-owner", url.searchParams.get("expires"), url.searchParams.get("sig"))).toBe(false);
  });

  it("bundles historical and prefixed managed media and reports missing files", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(url.includes("missing") ? "" : new Uint8Array([1, 2, 3]), { status: url.includes("missing") ? 404 : 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { buildWorkflowZip } = await import("@/lib/exportWorkflow");
    const space = { id: "test", name: "Test", createdAt: 1, nodes: [{ id: "n", position: { x: 0, y: 0 }, data: { label: "Image", imageUrl: "/api/media/old", r2Url: "/cancas/api/media/new", videoUrl: "/api/media/missing" } }], edges: [], nodeCounters: {} };
    const { result } = await buildWorkflowZip(space);
    expect(result.assetCount).toBe(2);
    expect(result.skipped).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith("/cancas/api/download?"))).toBe(true);
  });

  it("uses browser-authenticated thumbnails for managed images", async () => {
    const { thumbSrc } = await import("@/lib/galleryUtils");
    for (const value of ["/api/media/owned", "/cancas/api/media/owned"]) {
      const thumbnail = new URL(thumbSrc(value), "https://patrickapi.microedulab.com");
      expect(thumbnail.pathname).toBe("/cancas/api/thumb");
      expect(thumbnail.searchParams.get("url")).toBe(value);
    }
    expect(thumbSrc("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
  });

  it("restores copies and media references without changing the source", async () => {
    const { parseWorkflowRecovery } = await import("@/lib/workflowRecovery");
    const workflow = { id: "existing-id", name: "Local only", createdAt: 1, nodes: [{ id: "n", position: { x: 0, y: 0 }, data: { label: "Image", imageUrl: "/api/media/owned", prompt: "do not change /api/media/mentioned" } }], edges: [], nodeCounters: {} };
    const original = JSON.stringify({ format: "heliosgen-recovery", version: 1, workflows: [workflow] });
    const [copy] = parseWorkflowRecovery(original);
    expect(copy.id).toBe("");
    expect(copy.name).toBe("Local only（恢复副本）");
    expect(copy.nodes[0].data.imageUrl).toBe("/cancas/api/media/owned");
    expect(copy.nodes[0].data.prompt).toBe(workflow.nodes[0].data.prompt);
    expect(workflow.nodes[0].data.imageUrl).toBe("/api/media/owned");
    expect(() => parseWorkflowRecovery(JSON.stringify({ format: "heliosgen-recovery", version: 1, workflows: [workflow, { name: "bad", nodes: [{}], edges: [] }] }))).toThrow("未导入任何内容");
  });
});
