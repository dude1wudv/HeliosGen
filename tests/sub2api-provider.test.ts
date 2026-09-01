import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "helios-sub2api-provider-"));
process.env.HELIOS_DATA_DIR = dataDir;
process.env.HELIOS_MEDIA_DIR = join(dataDir, "media");
process.env.SUB2API_MANAGED_MODE = "true";
process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE = "true";
process.env.HELIOS_SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

let imageAdapter: typeof import("@/lib/sub2api/images");
let providers: typeof import("@/lib/providers");

beforeAll(async () => {
  vi.resetModules();
  imageAdapter = await import("@/lib/sub2api/images");
  providers = await import("@/lib/providers");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseRequest = (overrides: Partial<imageAdapter.Sub2ApiImageRequest> = {}): imageAdapter.Sub2ApiImageRequest => ({
  apiBaseUrl: "https://sub2api",
  apiKey: "synthetic-api-key",
  userId: "user-a",
  prompt: "a synthetic test image",
  aspectRatio: "16:9",
  quality: "low",
  resolution: "2k",
  ...overrides,
});

describe("Sub2API image adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("synthetic-png").toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("sends the generations contract and decodes b64_json responses", async () => {
    const result = await imageAdapter.generateSub2ApiImage(baseRequest());
    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));

    expect(url).toBe("https://sub2api/images/generations");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-api-key");
    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: "a synthetic test image",
      n: 1,
      size: "2048x1152",
      quality: "low",
      output_format: "png",
      response_format: "b64_json",
    });
    expect(result).toEqual({ buffer: Buffer.from("synthetic-png"), mimeType: "image/png" });
  });

  it("uses repeated image fields for edits and never sends resolution labels as quality", async () => {
    const image = `data:image/png;base64,${Buffer.from("reference").toString("base64")}`;
    await imageAdapter.generateSub2ApiImage(baseRequest({
      aspectRatio: "1:1",
      quality: "medium",
      imageUrls: [image, image],
    }));
    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0];
    const form = init?.body as FormData;

    expect(url).toBe("https://sub2api/images/edits");
    expect(init?.method).toBe("POST");
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("a synthetic test image");
    expect(form.get("size")).toBe("2048x2048");
    expect(form.get("quality")).toBe("medium");
    expect(form.get("output_format")).toBe("png");
    expect(form.getAll("image")).toHaveLength(2);
    expect(form.get("quality")).not.toBe("1k");
    expect(form.get("quality")).not.toBe("2k");
    expect(form.get("quality")).not.toBe("4k");
  });

  it("rejects unsupported quality values before an upstream request", async () => {
    await expect(imageAdapter.generateSub2ApiImage(baseRequest({ quality: "4k" })))
      .rejects.toThrow("quality must be low, medium, high, or auto");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns only a bounded, normalized upstream error instead of the raw body", async () => {
    const upstreamBody = {
      error: {
        code: "rate_limited",
        message: "upstream is temporarily unavailable\nwith diagnostic details",
        param: "synthetic-api-key",
      },
      secret: "synthetic-api-key",
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(upstreamBody), {
      status: 429,
      headers: { "content-type": "application/json" },
    }));

    const failure = await imageAdapter.generateSub2ApiImage(baseRequest()).catch((error: unknown) => error as Error & { status?: number; code?: string });
    expect(failure).toMatchObject({ status: 429, code: "rate_limited" });
    expect(failure.message).toBe("upstream is temporarily unavailable with diagnostic details");
    expect(failure.message).not.toContain(JSON.stringify(upstreamBody));
  });
});

describe("managed provider selection", () => {
  it("exposes only Sub2API and overrides stale client provider selections", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    storage.set("aiui-model-providers", JSON.stringify({ "gpt-image-2": "azure", other: "codex" }));

    expect(providers.PROVIDERS.map(({ id }) => id)).toEqual(["sub2api"]);
    expect(providers.getModelProvider("gpt-image-2")).toBe("sub2api");
    providers.setModelProvider("gpt-image-2", "codex");
    expect(providers.getModelProvider("gpt-image-2")).toBe("sub2api");
  });
});
