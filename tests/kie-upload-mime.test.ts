import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: vi.fn(async () => Buffer.from("synthetic media bytes")),
  };
});

import { ensureKieReachableImages } from "@/lib/kieUpload";

describe("Kie upload audio MIME types", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { downloadUrl: "https://files.example.test/upload" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["mp3", "audio/mpeg"],
    ["wav", "audio/wav"],
    ["m4a", "audio/mp4"],
    ["ogg", "audio/ogg"],
  ])("uploads .%s media with its audio MIME type", async (extension, expectedMime) => {
    const uploadUrl = `/generated/mime-regression-${extension}-${crypto.randomUUID()}.${extension}`;
    await expect(ensureKieReachableImages([uploadUrl], "synthetic-api-key")).resolves.toEqual([
      "https://files.example.test/upload",
    ]);

    const fetchMock = vi.mocked(fetch);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse(String(request?.body)) as { base64Data: string };
    expect(body.base64Data).toMatch(new RegExp(`^data:${expectedMime};base64,`));
  });
});
