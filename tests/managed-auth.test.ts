import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

const PUBLIC_ORIGIN = "https://canvas.test";
const SESSION_SECRET = randomBytes(32).toString("base64");

// Set hosted-mode configuration before loading any modules that snapshot it.
process.env.SUB2API_MANAGED_MODE = "true";
process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE = "true";
process.env.HELIOS_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
process.env.HELIOS_SESSION_SECRET = SESSION_SECRET;
process.env.HELIOS_WORKBENCH_CLIENT_ID = "heliosgen-test";
process.env.HELIOS_WORKBENCH_CLIENT_SECRET = randomBytes(32).toString("base64");
process.env.SUB2API_INTERNAL_BASE_URL = "http://sub2api.test/api/v1";

let session: typeof import("@/lib/sub2api/session");
let bootstrap: typeof import("@/app/api/integrations/sub2api/bootstrap/route");
let proxy: typeof import("@/proxy");
let generate: typeof import("@/app/api/generate/route");
beforeAll(async () => {
  vi.resetModules();
  session = await import("@/lib/sub2api/session");
  bootstrap = await import("@/app/api/integrations/sub2api/bootstrap/route");
  proxy = await import("@/proxy");
  generate = await import("@/app/api/generate/route");
});

function validSession(userId = "user-a", ttl = 900): string {
  const now = Math.floor(Date.now() / 1000);
  return session.sealSession({
    userId,
    apiBaseUrl: "https://sub2api.test/v1",
    apiKey: `synthetic-key-${userId}`,
    iat: now,
    exp: now + ttl,
  });
}

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`${PUBLIC_ORIGIN}${path}`, init);
}

function cookieFor(value: string): string {
  return `${session.SESSION_COOKIE}=${encodeURIComponent(value)}`;
}

describe("managed bootstrap handoff", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      user_id: "user-a",
      api_base_url: "https://sub2api.test/v1",
      api_key: "synthetic-upstream-key",
      session_expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("exchanges a grant server-side without returning the long-lived key", async () => {
    const response = await bootstrap.POST(request("/api/integrations/sub2api/bootstrap", {
      method: "POST",
      headers: { origin: PUBLIC_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ code: "synthetic-grant-code-123456" }),
    }));
    const body = await response.json();
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain("synthetic-upstream-key");
    expect(setCookie).toContain(session.SESSION_COOKIE);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("synthetic-upstream-key");

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) });
    expect(String(init?.body)).toBe(JSON.stringify({ code: "synthetic-grant-code-123456" }));
  });

  it("rejects anonymous or cross-origin bootstrap requests before contacting Sub2API", async () => {
    const fetchMock = vi.mocked(fetch);
    const anonymous = await bootstrap.POST(request("/api/integrations/sub2api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "synthetic-grant-code-123456" }),
    }));
    const crossOrigin = await bootstrap.POST(request("/api/integrations/sub2api/bootstrap", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ code: "synthetic-grant-code-123456" }),
    }));

    expect(anonymous.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("managed request boundary", () => {
  it("redirects anonymous pages and returns structured API 401 responses", async () => {
    const page = await proxy.proxy(request("/workflow"));
    const api = await proxy.proxy(request("/api/settings/kie-key"));

    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/bootstrap?reason=session_expired");
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "unauthorized", code: "session_required" });
    expect(api.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects a forged Codex provider request in managed mode", async () => {
    const response = await generate.POST(request("/api/generate", {
      method: "POST",
      headers: { origin: PUBLIC_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "synthetic prompt", codexProvider: true }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "provider_unavailable", code: "provider_unavailable" });
  });


  it("requires the configured Origin for state-changing requests", async () => {
    const cookie = cookieFor(validSession());
    const noOrigin = await proxy.proxy(request("/api/settings/kie-key", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kieApiToken: "synthetic-token" }),
    }));
    const crossOrigin = await proxy.proxy(request("/api/settings/kie-key", {
      method: "POST",
      headers: { cookie, origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ kieApiToken: "synthetic-token" }),
    }));
    const sameOrigin = await proxy.proxy(request("/api/settings/kie-key", {
      method: "POST",
      headers: { cookie, origin: PUBLIC_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ kieApiToken: "synthetic-token" }),
    }));

    expect(noOrigin.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: "forbidden", code: "origin_required" });
    expect(sameOrigin.status).toBe(200);
  });

  it("treats an expired sealed session as anonymous", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = session.sealSession({
      userId: "user-a",
      apiBaseUrl: "https://sub2api.test/v1",
      apiKey: "synthetic-key-user-a",
      iat: now - 120,
      exp: now - 1,
    });
    const response = await proxy.proxy(request("/api/settings/kie-key", {
      headers: { cookie: cookieFor(expired) },
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized", code: "session_required" });
  });
});
