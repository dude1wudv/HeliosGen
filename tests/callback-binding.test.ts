import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ mirror: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/r2", () => ({ mirrorToR2: mocks.mirror }));
vi.mock("@/lib/guest/db", () => ({ updateGeneration: mocks.update }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

const dataDir = mkdtempSync(join(tmpdir(), "helios-callback-binding-"));
let signatures: typeof import("@/lib/mediaSignature");
let jobs: typeof import("@/lib/jobStore");
let callback: typeof import("@/app/api/callback/route");

beforeAll(async () => {
  process.env.HELIOS_DATA_DIR = dataDir;
  process.env.SUB2API_MANAGED_MODE = "true";
  process.env.HELIOS_SESSION_SECRET = Buffer.alloc(32, 11).toString("base64");
  vi.resetModules();
  signatures = await import("@/lib/mediaSignature");
  jobs = await import("@/lib/jobStore");
  callback = await import("@/app/api/callback/route");
});
beforeEach(() => {
  mocks.update.mockReset();
  mocks.mirror.mockReset().mockResolvedValue("/cancas/api/media/owned-output");
});
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }); });

function seed(taskId: string, userId: string) {
  const nonce = signatures.createKieCallbackNonce();
  jobs.jobStore.set(taskId, { status: "pending", type: "image", userId, callbackNonce: nonce });
  return new URL(signatures.createKieCallbackUrl("https://canvas.test", nonce));
}
function post(url: URL, taskId: string) {
  return callback.POST(new NextRequest(url, { method: "POST", body: JSON.stringify({
    code: 200, data: { taskId, state: "success", resultJson: JSON.stringify({ resultUrls: ["https://upstream.test/image.png"] }) },
  }) }));
}

describe("managed callback task binding", () => {
  it("settles only the task bound to the signed nonce and preserves its owner", async () => {
    const url = seed("correct-task", "owner-a");
    expect((await post(url, "correct-task")).status).toBe(200);
    expect(jobs.jobStore.get("correct-task")).toMatchObject({ status: "done", userId: "owner-a", imageUrl: "/cancas/api/media/owned-output" });
    expect(mocks.update).toHaveBeenCalledWith("correct-task", "owner-a", expect.objectContaining({ status: "done" }));
  });

  it("rejects an A callback URL used to settle B, including tasks without a nonce", async () => {
    const urlA = seed("task-a", "owner-a");
    seed("task-b", "owner-b");
    jobs.jobStore.set("legacy-task", { status: "pending", userId: "owner-b" });
    expect((await post(urlA, "task-b")).status).toBe(401);
    expect((await post(urlA, "legacy-task")).status).toBe(401);
    expect(jobs.jobStore.get("task-b")?.status).toBe("pending");
    expect(mocks.mirror).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects absent nonce, tampered nonce and old expiry-only signatures", async () => {
    const url = seed("invalid-signatures", "owner-a");
    const absent = new URL(url); absent.searchParams.delete("nonce");
    const tampered = new URL(url); tampered.searchParams.set("nonce", signatures.createKieCallbackNonce());
    const legacy = new URL(url);
    legacy.searchParams.set("sig", createHmac("sha256", Buffer.from(process.env.HELIOS_SESSION_SECRET!, "base64"))
      .update(`callback.${url.searchParams.get("expires")}`).digest("base64url"));
    for (const invalid of [absent, tampered, legacy]) expect((await post(invalid, "invalid-signatures")).status).toBe(401);
    expect(jobs.jobStore.get("invalid-signatures")?.status).toBe("pending");
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("rechecks the task nonce after asynchronous media storage", async () => {
    const url = seed("replaced-task", "owner-a");
    mocks.mirror.mockImplementationOnce(async () => {
      seed("replaced-task", "owner-b");
      return "/cancas/api/media/old-output";
    });
    expect((await post(url, "replaced-task")).status).toBe(200);
    expect(jobs.jobStore.get("replaced-task")).toMatchObject({ status: "pending", userId: "owner-b" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
