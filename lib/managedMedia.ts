import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { MEDIA_DIR } from "@/lib/guest/paths";
import type { MediaAsset } from "@/lib/guest/db";

const MANAGED_MEDIA_ROOT = resolve(MEDIA_DIR, "managed");

export async function readManagedMediaAsset(asset: MediaAsset, maxBytes: number): Promise<Buffer> {
  const path = resolve(asset.path);
  if (path !== MANAGED_MEDIA_ROOT && !path.startsWith(`${MANAGED_MEDIA_ROOT}${sep}`)) {
    throw new Error("Managed media path is outside the data directory");
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maxBytes || metadata.size !== asset.size_bytes) {
    throw new Error("Managed media metadata mismatch");
  }
  return readFile(path);
}
