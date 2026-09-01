import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";

const dataDir = mkdtempSync(join(tmpdir(), "helios-owner-isolation-"));
const mediaDir = join(dataDir, "media");
mkdirSync(mediaDir, { recursive: true });
process.env.HELIOS_DATA_DIR = dataDir;
process.env.HELIOS_MEDIA_DIR = mediaDir;
process.env.SUB2API_MANAGED_MODE = "true";
process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE = "true";
process.env.HELIOS_PUBLIC_ORIGIN = "https://canvas.test";
process.env.HELIOS_SESSION_SECRET = Buffer.alloc(32, 9).toString("base64");
process.env.KIE_API_KEY = "";
process.env.AZURE_API_KEY = "";

let session: typeof import("@/lib/sub2api/session");
let db: typeof import("@/lib/guest/db");
let sqlite: typeof import("@/lib/guest/sqlite");
let spacesRoute: typeof import("@/app/api/guest-spaces/route");
let kieSettings: typeof import("@/app/api/settings/kie-key/route");
let azureSettings: typeof import("@/app/api/settings/azure-key/route");
let gallery: typeof import("@/app/api/gallery/route");
let mediaRoute: typeof import("@/app/api/media/[id]/route");
let jobStore: typeof import("@/lib/jobStore");
let jobStatus: typeof import("@/app/api/job-status/route");
let jobStream: typeof import("@/app/api/job-stream/route");
let mediaSignature: typeof import("@/lib/mediaSignature");

beforeAll(async () => {
  vi.resetModules();
  session = await import("@/lib/sub2api/session");
  db = await import("@/lib/guest/db");
  sqlite = await import("@/lib/guest/sqlite");
  kieSettings = await import("@/app/api/settings/kie-key/route");
  azureSettings = await import("@/app/api/settings/azure-key/route");
  spacesRoute = await import("@/app/api/guest-spaces/route");
  gallery = await import("@/app/api/gallery/route");
  mediaRoute = await import("@/app/api/media/[id]/route");
  jobStore = await import("@/lib/jobStore");
  jobStatus = await import("@/app/api/job-status/route");
  jobStream = await import("@/app/api/job-stream/route");
  mediaSignature = await import("@/lib/mediaSignature");
});

afterAll(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* SQLite may still hold the temp file on Windows. */ }
});

function cookieFor(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const value = session.sealSession({
    userId,
    apiBaseUrl: "https://sub2api.test/v1",
    apiKey: `synthetic-key-${userId}`,
    iat: now,
    exp: now + 900,
  });
  return `${session.SESSION_COOKIE}=${encodeURIComponent(value)}`;
}

function request(path: string, userId?: string, init: RequestInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (userId) headers.set("cookie", cookieFor(userId));
  return new NextRequest(`https://canvas.test${path}`, { ...init, headers });
}

const space = (id: string, name: string) => ({
  id,
  name,
  nodes: [],
  edges: [],
  nodeCounters: {},
  createdAt: 1,
  updatedAt: 1,
});

describe("owner-scoped settings and spaces", () => {
  it("keeps Kie and Azure settings isolated across users", async () => {
    const userA = "settings-user-a";
    const userB = "settings-user-b";

    expect((await (await kieSettings.POST(request("/api/settings/kie-key", userA, {
      method: "POST", body: JSON.stringify({ kieApiToken: "synthetic-kie-a" }),
    }))).json())).toEqual({ ok: true });
    expect((await (await azureSettings.POST(request("/api/settings/azure-key", userA, {
      method: "POST", body: JSON.stringify({ azureApiKey: "synthetic-azure-a" }),
    }))).json())).toEqual({ ok: true });

    expect(await (await kieSettings.GET(request("/api/settings/kie-key", userB))).json()).toEqual({ hasToken: false });
    expect(await (await azureSettings.GET(request("/api/settings/azure-key", userB))).json()).toEqual({ hasToken: false });

    await kieSettings.POST(request("/api/settings/kie-key", userB, {
      method: "POST", body: JSON.stringify({ kieApiToken: "synthetic-kie-b" }),
    }));
    await azureSettings.POST(request("/api/settings/azure-key", userB, {
      method: "POST", body: JSON.stringify({ azureApiKey: "synthetic-azure-b" }),
    }));
    await kieSettings.DELETE(request("/api/settings/kie-key", userB, { method: "DELETE" }));
    await azureSettings.DELETE(request("/api/settings/azure-key", userB, { method: "DELETE" }));

    expect(db.getKieApiToken(userA)).toBe("synthetic-kie-a");
    expect(db.getAzureApiKey(userA)).toBe("synthetic-azure-a");
    expect(db.getKieApiToken(userB)).toBeNull();
    expect(db.getAzureApiKey(userB)).toBeNull();
  });

  it("does not let one user read, overwrite, or delete another user's spaces", async () => {
    const userA = "spaces-user-a";
    const userB = "spaces-user-b";
    const sharedId = "shared-space-id";

    expect((await (await spacesRoute.PUT(request("/api/guest-spaces", userA, {
      method: "PUT", body: JSON.stringify({ spaces: [space(sharedId, "owned-by-a")] }),
    }))).json())).toEqual({ ok: true });
    expect(await (await spacesRoute.GET(request("/api/guest-spaces", userB))).json()).toEqual({ spaces: [] });

    await spacesRoute.PUT(request("/api/guest-spaces", userB, {
      method: "PUT", body: JSON.stringify({ spaces: [] }),
    }));
    expect(await (await spacesRoute.GET(request("/api/guest-spaces", userA))).json()).toEqual({ spaces: [space(sharedId, "owned-by-a")] });

    await spacesRoute.PUT(request("/api/guest-spaces", userB, {
      method: "PUT", body: JSON.stringify({ spaces: [space(sharedId, "owned-by-b")] }),
    }));
    expect(await (await spacesRoute.GET(request("/api/guest-spaces", userA))).json()).toEqual({ spaces: [space(sharedId, "owned-by-a")] });
  });
});

describe("owner-scoped gallery media", () => {
  it("hides another user's upload and generation and leaves them unchanged on delete", async () => {
    const userA = "gallery-user-a";
    const userB = "gallery-user-b";
    db.insertUpload({ user_id: userA, r2_url: "/api/media/upload-a", mime_type: "image/png", source: "user_upload" });
    db.insertGeneration({ user_id: userA, task_id: "generation-owner-a", generation_type: "image", status: "done", image_url: "/api/media/generation-a", prompt: "synthetic" });
    const generationId = (sqlite.db().prepare("SELECT id FROM generations WHERE task_id = ?").get("generation-owner-a") as { id: string }).id;
    const uploadId = (sqlite.db().prepare("SELECT id FROM uploads WHERE user_id = ?").get(userA) as { id: string }).id;

    const otherGallery = await gallery.GET(request("/api/gallery?type=image", userB));
    expect(otherGallery.status).toBe(200);
    expect(await otherGallery.json()).toMatchObject({ items: [] });
    await gallery.DELETE(request("/api/gallery", userB, {
      method: "DELETE", body: JSON.stringify({ id: generationId, source: "generation" }),
    }));
    await gallery.DELETE(request("/api/gallery", userB, {
      method: "DELETE", body: JSON.stringify({ id: uploadId, source: "upload" }),
    }));

    expect(db.recoverJob("generation-owner-a", userA)).toMatchObject({ status: "done", image_url: "/api/media/generation-a" });
    expect(db.getUploads(userA, "image")).toHaveLength(1);
  });

  it("serves media only to its owner or a valid, owner-bound signature", async () => {
    const userA = "media-user-a";
    const userB = "media-user-b";
    const assetId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const assetPath = join(mediaDir, "managed", "owner-a", "asset.png");
    mkdirSync(join(mediaDir, "managed", "owner-a"), { recursive: true });
    const bytes = Buffer.from("synthetic-media");
    writeFileSync(assetPath, bytes);
    db.insertMediaAsset({ id: assetId, user_id: userA, path: assetPath, mime_type: "image/png", sha256: "synthetic-hash-a", size_bytes: bytes.byteLength });

    const ownerResponse = await mediaRoute.GET(request(`/api/media/${assetId}`, userA), { params: Promise.resolve({ id: assetId }) });
    const otherResponse = await mediaRoute.GET(request(`/api/media/${assetId}`, userB), { params: Promise.resolve({ id: assetId }) });
    expect(ownerResponse.status).toBe(200);
    expect(Buffer.from(await ownerResponse.arrayBuffer())).toEqual(bytes);
    expect(otherResponse.status).toBe(404);

    const signedUrl = mediaSignature.createMediaSignature(assetId, userA, "https://canvas.test");
    const signedResponse = await mediaRoute.GET(new NextRequest(signedUrl), { params: Promise.resolve({ id: assetId }) });
    expect(signedResponse.status).toBe(200);
    expect(Buffer.from(await signedResponse.arrayBuffer())).toEqual(bytes);

    const tamperedUser = new URL(signedUrl);
    tamperedUser.searchParams.set("user", userB);
    const tamperedResponse = await mediaRoute.GET(new NextRequest(tamperedUser), { params: Promise.resolve({ id: assetId }) });
    expect(tamperedResponse.status).toBe(401);
  });

  it("rejects a media signature after its 15-minute expiry", () => {
    const signedUrl = mediaSignature.createMediaSignature("asset-expiry", "user-a", "https://canvas.test");
    const parsed = new URL(signedUrl);
    expect(mediaSignature.verifyMediaSignature("asset-expiry", "user-a", parsed.searchParams.get("expires"), parsed.searchParams.get("sig"))).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(Number(parsed.searchParams.get("expires")) * 1000 + 1000);
    expect(mediaSignature.verifyMediaSignature("asset-expiry", "user-a", parsed.searchParams.get("expires"), parsed.searchParams.get("sig"))).toBe(false);
    vi.useRealTimers();
  });
});

describe("owner-scoped jobs", () => {
  it("returns a job to its owner but not to another user's status or stream request", async () => {
    const taskId = "task-owner-a";
    const userA = "job-user-a";
    const userB = "job-user-b";
    jobStore.jobStore.set(taskId, { status: "done", imageUrl: "/api/media/job-a", userId: userA });

    const owner = await jobStatus.GET(request(`/api/job-status?taskId=${taskId}`, userA));
    const other = await jobStatus.GET(request(`/api/job-status?taskId=${taskId}`, userB));
    const otherStream = await jobStream.GET(request(`/api/job-stream?taskId=${taskId}`, userB));

    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ status: "done", imageUrl: "/api/media/job-a", userId: userA });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ status: "not_found" });
    expect(otherStream.status).toBe(404);
  });
});

describe("owner-scoped folder deletion", () => {
  it("does not delete another user's folder items", () => {
    const userA = "folder-user-a";
    const userB = "folder-user-b";
    const folderId = "folder-owner-a";
    db.insertFolder({ id: folderId, user_id: userA, name: "A folder", parent_id: null, order_index: 0 });
    db.insertFolderItems(folderId, ["item-a"], userA);

    db.deleteFolder(folderId, userB);

    expect(db.getFolders(userA).some((folder) => folder.id === folderId)).toBe(true);
    expect(db.getFolderItems(userA)).toEqual(expect.arrayContaining([
      expect.objectContaining({ folder_id: folderId, item_id: "item-a", user_id: userA }),
    ]));
  });
});
