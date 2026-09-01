/**
 * Make image inputs reachable by kie.ai from a machine with no public URL.
 *
 * Hosted mode hands kie.ai a public R2 URL and (with a tunnel) can even expose
 * local files. The desktop app has neither, so local / data-URL images are
 * pushed to kie.ai's temporary file store (`POST /api/file-base64-upload`,
 * retained 3 days — long enough for a generation) and the returned `downloadUrl`
 * is used instead.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_DIR } from "./guest/paths";
import { getMediaAsset } from "./guest/db";
import { assertSafeUrl } from "./ssrf";
import { HELIOS_PUBLIC_ORIGIN, MANAGED_MODE } from "./managedMode";
import { createMediaSignature } from "./mediaSignature";
import { readManagedMediaAsset } from "./managedMedia";
// kie.ai's temp file store lives on this host, not api.kie.ai (their docs are
// stale). Files land on tempfile.redpandaai.co and are purged after 3 days.
const UPLOAD_URL = "https://kieai.redpandaai.co/api/file-base64-upload";

function isRemotelyReachable(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "0.0.0.0";
  } catch {
    return false;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** A local reference that kie.ai can't fetch and we must re-host. */
function isLocalMedia(url: string): boolean {
  return url.startsWith("data:") || url.startsWith("/generated/") || url.startsWith("/api/media/");
}

async function toDataUrl(input: string, userId?: string): Promise<string> {
  if (input.startsWith("data:")) return input;
  if (input.startsWith("/api/media/")) {
    const id = input.slice("/api/media/".length).split(/[?#/]/, 1)[0];
    const asset = id && userId ? getMediaAsset(id, userId) : null;
    if (!asset) throw new Error("Media asset is not available");
    const buffer = await readManagedMediaAsset(asset, 30 * 1024 * 1024);
    return `data:${asset.mime_type};base64,${buffer.toString("base64")}`;
  }
  const rel = input.replace(/^\/generated\//, "").replace(/^\/+/, "");
  const buf = await readFile(join(MEDIA_DIR, rel));
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// Cache only within the same owner; a managed user's asset must never cause a
// different user's temporary upload URL to be reused.
const uploadCache = new Map<string, Promise<string>>();

async function doUpload(input: string, apiKey: string, userId?: string): Promise<string> {
  const base64Data = await toDataUrl(input, userId);
  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ base64Data, uploadPath: "heliosgen" }),
  });
  const json = await res.json().catch(() => null);
  const url = json?.data?.downloadUrl;
  if (!res.ok || !url) throw new Error(`kie.ai file upload failed (${res.status})`);
  return url as string;
}

function uploadOne(input: string, apiKey: string, userId?: string): Promise<string> {
  const key = `${userId ?? "desktop"}:${input}`;
  let promise = uploadCache.get(key);
  if (!promise) {
    promise = doUpload(input, apiKey, userId);
    uploadCache.set(key, promise);
  }
  return promise;
}

/**
 * Return the input list with unsafe/local media rejected or swapped for a
 * short-lived kie.ai temporary URL.
 */
async function makeReachable(input: string, apiKey: string, userId?: string): Promise<string> {
  if (MANAGED_MODE && input.startsWith("/api/media/")) {
    const id = input.slice("/api/media/".length).split(/[?#/]/, 1)[0];
    const asset = id && userId ? getMediaAsset(id, userId) : null;
    if (!asset || !userId) throw new Error("Media asset is not available");
    return createMediaSignature(asset.id, userId, HELIOS_PUBLIC_ORIGIN);
  }
  if (isLocalMedia(input)) return uploadOne(input, apiKey, userId);
  await assertSafeUrl(input);
  return input;
}

export async function ensureKieReachableImages(urls: string[], apiKey: string, userId?: string): Promise<string[]> {
  return Promise.all(urls.map((url) => makeReachable(url, apiKey, userId)));
}
/**
 * Deep-walk a Kie payload, owner-checking local media and validating every
 * user-controlled remote URL before Kie receives it.
 */
export async function rewriteLocalMediaForKie(node: unknown, apiKey: string, userId?: string): Promise<void> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === "string" && (/^https?:\/\//i.test(node[i]) || isLocalMedia(node[i]))) {
        node[i] = await makeReachable(node[i], apiKey, userId);
      } else {
        await rewriteLocalMediaForKie(node[i], apiKey, userId);
      }
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string" && (/^https?:\/\//i.test(value) || isLocalMedia(value))) {
        (node as Record<string, unknown>)[key] = await makeReachable(value, apiKey, userId);
      } else {
        await rewriteLocalMediaForKie(value, apiKey, userId);
      }
    }
  }
}
