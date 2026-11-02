import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAsset = vi.fn();
const readAsset = vi.fn();
const remoteFetch = vi.fn();
vi.mock("@/lib/guest/db", () => ({ getMediaAsset: (...args: unknown[]) => getAsset(...args) }));
vi.mock("@/lib/managedMedia", () => ({ readManagedMediaAsset: (...args: unknown[]) => readAsset(...args) }));
vi.mock("@/lib/ssrf", () => ({ fetchSafeBuffer: (...args: unknown[]) => remoteFetch(...args) }));

beforeEach(() => { vi.resetModules(); vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/cancas"); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());

describe("local media frame/trim input", () => {
  it("uses owner-checked storage for both old and prefixed references", async () => {
    const { readMediaInput } = await import("@/lib/mediaInput");
    const asset = { id: "asset", user_id: "owner", mime_type: "video/mp4" };
    getAsset.mockImplementation((id, owner) => id === "asset" && owner === "owner" ? asset : null);
    readAsset.mockResolvedValue(Buffer.from("video"));
    for (const input of ["/api/media/asset", "/cancas/api/media/asset"]) {
      expect(await readMediaInput(input, "owner", { maxBytes: 1024 })).toEqual({ buffer: Buffer.from("video"), contentType: "video/mp4" });
    }
    await expect(readMediaInput("/cancas/api/media/asset", "other-owner", { maxBytes: 1024 })).rejects.toThrow("not available");
    expect(remoteFetch).not.toHaveBeenCalled();
    expect(readAsset).toHaveBeenCalledTimes(2);
    expect(readAsset).toHaveBeenCalledWith(asset, 1024);
  });

  it("keeps remote media behind the existing SSRF and size policy", async () => {
    const { readMediaInput } = await import("@/lib/mediaInput");
    remoteFetch.mockRejectedValue(new Error("URL is not allowed"));
    await expect(readMediaInput("http://127.0.0.1/private", "owner", { maxBytes: 1024, timeoutMs: 100 })).rejects.toThrow("not allowed");
    expect(remoteFetch).toHaveBeenCalledWith("http://127.0.0.1/private", { maxBytes: 1024, timeoutMs: 100 });
    expect(getAsset).not.toHaveBeenCalled();
  });
});
