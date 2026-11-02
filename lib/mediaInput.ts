import { logicalAppPath } from "./appPaths";
import { getMediaAsset } from "./guest/db";
import { readManagedMediaAsset } from "./managedMedia";
import { fetchSafeBuffer } from "./ssrf";

/** Resolve local references with the caller's owner, never by a public path fetch. */
export async function readMediaInput(value: string, userId: string, options: { maxBytes: number; timeoutMs?: number }): Promise<{ buffer: Buffer; contentType: string }> {
  const path = logicalAppPath(value);
  if (path.startsWith("/api/media/")) {
    const id = path.slice("/api/media/".length).split(/[?#/]/, 1)[0];
    const asset = id ? getMediaAsset(id, userId) : null;
    if (!asset) throw new Error("Media asset is not available");
    return { buffer: await readManagedMediaAsset(asset, options.maxBytes), contentType: asset.mime_type };
  }
  return fetchSafeBuffer(value, options);
}
