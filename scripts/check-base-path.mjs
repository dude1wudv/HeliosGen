/** Built-app acceptance against isolated data and a synthetic upstream; never uses production. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dataDir = await mkdtemp(path.join(tmpdir(), "helios-cancas-acceptance-"));
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");
let upstreamImages = 0;
let mockPort;
const mock = createServer(async (req, res) => {
  if (req.url === "/api/v1/workbenches/helios/token" && req.method === "POST") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ user_id: "synthetic-owner", api_base_url: `http://localhost:${mockPort}/v1`, api_key: "synthetic-not-a-real-key", session_expires_in: 600 }));
  } else if (req.url === "/v1/images/generations" && req.method === "POST") {
    upstreamImages++;
    for await (const chunk of req) void chunk;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }));
  } else { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
mockPort = mock.address().port;
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: "production", NEXT_PHASE: "phase-production-server", NEXT_PUBLIC_APP_BASE_PATH: "/cancas", SUB2API_MANAGED_MODE: "true", NEXT_PUBLIC_SUB2API_MANAGED_MODE: "true", HELIOS_PUBLIC_ORIGIN: origin, HELIOS_SESSION_SECRET: randomBytes(32).toString("base64"), HELIOS_DATA_DIR: dataDir, HELIOS_MEDIA_DIR: path.join(dataDir, "media"), SUB2API_INTERNAL_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`, HELIOS_WORKBENCH_CLIENT_SECRET: "synthetic-local-client-secret-only", NEXT_TELEMETRY_DISABLED: "1" },
});
let diagnostic = "";
server.stdout.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000); });
server.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000); });
let cookie = "";
async function request(route, init = {}) {
  return fetch(`${origin}${route}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(15000), headers: { ...(cookie ? { cookie } : {}), origin, ...init.headers } });
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await request("/cancas/api/health")).ok) { ready = true; break; } } catch { /* starting */ }
    if (server.exitCode !== null) throw new Error("Built server exited before readiness");
    await delay(500);
  }
  assert(ready, "Prefixed health endpoint did not become ready");
  assert.equal((await request("/api/health")).status, 404, "Root APIs must not claim the main site's namespace");
  assert.equal((await request("/cancas/HG.svg")).status, 200);
  assert.equal((await request("/cancas/legacy-recovery.html")).status, 200);
  const anonymous = await request("/cancas/workflow");
  assert.equal(anonymous.status, 307);
  assert.equal(new URL(anonymous.headers.get("location"), origin).pathname, "/cancas/bootstrap");
  const bootstrap = await request("/cancas/api/integrations/sub2api/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "synthetic-one-time-local-grant" }) });
  assert.equal(bootstrap.status, 200);
  const header = bootstrap.headers.get("set-cookie") ?? "";
  assert.match(header, /__Secure-helios_session=/);
  assert.match(header, /Path=\/cancas/);
  assert.match(header, /HttpOnly/);
  cookie = header.split(";", 1)[0];
  const page = await request("/cancas/workflow");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert(html.includes("/cancas/_next/"));
  assert(html.includes("/cancas/recover"));
  assert.equal((await request("/cancas/workflow/synthetic-deep-link")).status, 200);
  assert.equal((await request("/cancas/recover")).status, 200);
  const upload = await request("/cancas/api/upload-asset", { method: "POST", headers: { "Content-Type": "image/png" }, body: image });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert.match(uploaded.cdnUrl, /^\/cancas\/api\/media\//);
  assert.equal((await request(uploaded.cdnUrl)).status, 200);
  const legacy = uploaded.cdnUrl.replace(/^\/cancas/, "");
  for (const reference of [legacy, uploaded.cdnUrl]) {
    assert.equal((await request(`/cancas/api/thumb?url=${encodeURIComponent(reference)}&w=96`)).status, 200);
    assert.equal((await request(`/cancas/api/download?url=${encodeURIComponent(reference)}`)).status, 200);
  }
  const generation = await request("/cancas/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "synthetic local acceptance image", model: "gpt-image-2", aspectRatio: "1:1", quality: "low" }) });
  assert.equal(generation.status, 200);
  const { taskId } = await generation.json();
  assert.equal(typeof taskId, "string");
  let result;
  for (let attempt = 0; attempt < 40; attempt++) {
    result = await (await request(`/cancas/api/job-status?taskId=${encodeURIComponent(taskId)}`)).json();
    if (result.status !== "pending") break;
    await delay(100);
  }
  assert.equal(result.status, "done", result.error ?? "Synthetic generation did not finish");
  assert.match(result.imageUrl, /^\/cancas\/api\/media\//);
  assert.equal(upstreamImages, 1, "Exactly one synthetic upstream generation must run");
  const oldCookie = cookie.replace("__Secure-helios_session=", "__Host-helios_session=");
  assert.equal((await request("/cancas/api/gallery", { headers: { cookie: oldCookie } })).status, 401);
  const logout = await request("/cancas/api/logout", { method: "POST" });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Path=\/cancas/);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  console.log("PASS: /cancas built app, bootstrap/cookie, assets/deep links, upload, old/new media thumbnails/download, one mocked generation, logout.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Acceptance failed");
  console.error(diagnostic);
  process.exitCode = 1;
} finally {
  server.kill();
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(5000)]);
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  // mkdtemp created this exact task-owned directory; never clean an application data path.
  assert(dataDir.startsWith(path.join(tmpdir(), "helios-cancas-acceptance-")));
  await rm(dataDir, { recursive: true, force: true });
}
