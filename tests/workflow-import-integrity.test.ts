import { afterEach, describe, expect, it, vi } from "vitest";
import { makeZip, type ZipEntry } from "@/lib/makeZip";
import { importWorkflowZip } from "@/lib/importWorkflow";

const manifest = (media = "assets/image.png"): ZipEntry => ({ name: "workflow.json", data: new TextEncoder().encode(JSON.stringify({
  format: "heliosgen-workflow", version: 1, workflow: { name: "Original", nodes: [{ id: "one", position: { x: 0, y: 0 }, data: { imageUrl: media } }], edges: [] },
})) });
const file = (blob: Blob): File => Object.assign(blob, { name: "workflow.zip" }) as File;
afterEach(() => vi.unstubAllGlobals());

describe("workflow ZIP integrity", () => {
  it("rejects missing media before uploading any other assets", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const blob = makeZip([manifest(), { name: "assets/other.png", data: new Uint8Array([1]) }]);
    await expect(importWorkflowZip(file(blob))).rejects.toThrow("缺少");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("imports and rewrites complete bundled media", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ cdnUrl: "/api/media/new" })));
    const result = await importWorkflowZip(file(makeZip([manifest(), { name: "assets/image.png", data: new Uint8Array([1, 2]) }])));
    expect(result.skipped).toBe(0);
    expect(result.assetCount).toBe(1);
    expect(result.nodes[0].data.imageUrl).toBe("/api/media/new");
  });
  it("rejects duplicate paths and truncated payloads", async () => {
    await expect(importWorkflowZip(file(makeZip([manifest(), manifest()])))).rejects.toThrow("重复");
    const truncated = makeZip([manifest()]).slice(0, 40);
    await expect(importWorkflowZip(file(truncated))).rejects.toThrow("不完整");
    await expect(importWorkflowZip(file(new Blob([new Uint8Array([0x50])])))).rejects.toThrow("不完整");
  });
  it("rejects CRC mismatch and oversized expansion claims", async () => {
    const bytes = new Uint8Array(await makeZip([manifest()]).arrayBuffer());
    const corrupt = bytes.slice(); corrupt[14] ^= 1;
    await expect(importWorkflowZip(file(new Blob([corrupt])))).rejects.toThrow("校验失败");
    new DataView(bytes.buffer).setUint32(22, 101 * 1024 * 1024, true);
    const centralOffset = new DataView(bytes.buffer).getUint32(bytes.length - 22 + 16, true);
    new DataView(bytes.buffer).setUint32(centralOffset + 24, 101 * 1024 * 1024, true);
    await expect(importWorkflowZip(file(new Blob([bytes])))).rejects.toThrow("过大");
  });
  it("rejects archives truncated at a complete local entry or missing the end record before any upload", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const bytes = new Uint8Array(await makeZip([manifest(), { name: "assets/image.png", data: new Uint8Array([1]) }]).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const centralOffset = view.getUint32(bytes.length - 22 + 16, true);
    for (const truncated of [bytes.slice(0, centralOffset), bytes.slice(0, bytes.length - 1)]) {
      await expect(importWorkflowZip(file(new Blob([truncated])))).rejects.toThrow("不完整");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects mismatched central-directory counts and local file metadata before uploading", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const bytes = new Uint8Array(await makeZip([manifest(), { name: "assets/image.png", data: new Uint8Array([1]) }]).arrayBuffer());
    const alteredCount = bytes.slice();
    new DataView(alteredCount.buffer).setUint16(alteredCount.length - 22 + 10, 1, true);
    await expect(importWorkflowZip(file(new Blob([alteredCount])))).rejects.toThrow("目录");
    const alteredLocal = bytes.slice(); alteredLocal[30] ^= 1;
    await expect(importWorkflowZip(file(new Blob([alteredLocal])))).rejects.toThrow("校验失败");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports upload responses without a URL as missing media", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "missing URL" })));
    const result = await importWorkflowZip(file(makeZip([manifest(), { name: "assets/image.png", data: new Uint8Array([1]) }])));
    expect(result.skipped).toBe(1);
  });
});
