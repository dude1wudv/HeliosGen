import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import { createMediaSignature } from "@/lib/mediaSignature";

const readFileMock = vi.hoisted(() => vi.fn(async () => Buffer.from("synthetic media bytes")));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, readFile: readFileMock };
});

const previousSessionSecret = process.env.HELIOS_SESSION_SECRET;
const asset = {
  id: "synthetic-asset",
  user_id: "owner-a",
  path: "/synthetic/media.bin",
  mime_type: "image/png",
  sha256: "synthetic-hash",
  size_bytes: 22,
};

async function loadUploader(managed: boolean) {
  vi.resetModules();
  vi.doMock("@/lib/managedMode", () => ({
    MANAGED_MODE: managed,
    HELIOS_PUBLIC_ORIGIN: "https://canvas.example.test",
  }));
  vi.doMock("@/lib/guest/paths", () => ({ MEDIA_DIR: "/synthetic/media" }));
  vi.doMock("@/lib/guest/db", () => ({
    getMediaAsset: vi.fn((id: string, userId: string) => id === asset.id && userId === asset.user_id ? asset : null),
  }));
  vi.doMock("@/lib/managedMedia", () => ({
    readManagedMediaAsset: vi.fn(async () => Buffer.from("synthetic managed media")),
  }));
  return import("@/lib/kieUpload");
}

describe("Kie upload media security", () => {
  beforeEach(() => {
    readFileMock.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: { downloadUrl: "https://files.example.test/upload" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    process.env.HELIOS_SESSION_SECRET = Buffer.alloc(32, 9).toString("base64");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/managedMode");
    vi.doUnmock("@/lib/guest/paths");
    vi.doUnmock("@/lib/guest/db");
    vi.doUnmock("@/lib/managedMedia");
    if (previousSessionSecret === undefined) delete process.env.HELIOS_SESSION_SECRET;
    else process.env.HELIOS_SESSION_SECRET = previousSessionSecret;
    vi.resetModules();
  });

  it.each([
    "/generated/synthetic.png",
    "/generated/../../outside.png",
  ])("rejects managed legacy generated media without reading or fetching (%s)", async (url) => {
    const { ensureKieReachableImages } = await loadUploader(true);

    const outcome = await ensureKieReachableImages([url], "synthetic-api-key", "owner-a").then(
      () => "resolved",
      () => "rejected",
    );
    expect.soft(outcome).toBe("rejected");
    expect.soft(readFileMock).not.toHaveBeenCalled();
    expect.soft(fetch).not.toHaveBeenCalled();
  });

  it("rejects generated traversal in non-managed mode but still uploads a valid generated asset", async () => {
    const { ensureKieReachableImages } = await loadUploader(false);

    const traversalOutcome = await ensureKieReachableImages(["/generated/../../outside.png"], "synthetic-api-key").then(
      () => "resolved",
      () => "rejected",
    );
    expect.soft(traversalOutcome).toBe("rejected");
    expect.soft(readFileMock).not.toHaveBeenCalled();
    expect.soft(fetch).not.toHaveBeenCalled();
  });

  it("uploads a valid generated asset in non-managed mode", async () => {
    const { ensureKieReachableImages } = await loadUploader(false);

    await expect(ensureKieReachableImages(["/generated/synthetic.png"], "synthetic-api-key")).resolves.toEqual([
      "https://files.example.test/upload",
    ]);
    expect(readFileMock).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns signed managed media only for its owner", async () => {
    const { ensureKieReachableImages } = await loadUploader(true);
    const signedUrl = createMediaSignature(asset.id, asset.user_id, "https://canvas.example.test");

    await expect(ensureKieReachableImages([`/api/media/${asset.id}`], "synthetic-api-key", "owner-a"))
      .resolves.toEqual([signedUrl]);
    await expect(ensureKieReachableImages([`/api/media/${asset.id}`], "synthetic-api-key", "owner-b"))
      .rejects.toThrow("Media asset is not available");
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("continues rejecting SSRF-prone remote media URLs", async () => {
    const { ensureKieReachableImages } = await loadUploader(false);

    await expect(ensureKieReachableImages(["http://127.0.0.1/private"], "synthetic-api-key")).rejects.toThrow();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
