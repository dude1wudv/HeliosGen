import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBuffer, lookupAssetHash, storeAssetHash } from "./assetCache";
import { GUEST_MODE } from "./guestMode";
import { MANAGED_MODE } from "./managedMode";
import { stripMetadata } from "./mediaMetadata";
import { fetchSafeBuffer } from "./ssrf";
import * as localStore from "./guest/localStorage";
import { findMediaAssetByHash, getMediaAsset, insertMediaAsset } from "./guest/db";
import { MEDIA_DIR } from "./guest/paths";
let _s3: S3Client | null = null;

function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return _s3;
}

function cdnUrl(key: string): string {
  return `${process.env.R2_PUBLIC_URL!.replace(/\/$/, "")}/${key}`;
}

function ext(contentType: string): string {
  if (contentType.includes("mp4"))  return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("png"))  return "png";
  if (contentType.includes("gif"))  return "gif";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

/**
 * Store media and, in hosted mode, return an owner-checked media URL rather
 * than a publicly readable generated path. `userId` is intentionally explicit
 * at the upload boundary.
 */
export async function uploadBuffer(
  input: Buffer,
  contentType: string,
  folder: string,
  userId?: string,
): Promise<string> {
  if (GUEST_MODE) return localStore.uploadBuffer(input, contentType, folder);
  const buffer = await stripMetadata(input, contentType);
  const hash = hashBuffer(buffer);
  if (MANAGED_MODE && userId) {
    const existing = findMediaAssetByHash(userId, hash);
    if (existing) return `/api/media/${existing.id}`;
  } else {
    const cached = await lookupAssetHash(hash);
    if (cached) return cached;
  }
  if (MANAGED_MODE) {
    if (!userId) throw new Error("Managed media requires an owner");
    const ownerDirectory = createHash("sha256").update(userId).digest("hex").slice(0, 32);
    const safeFolder = folder.replace(/[^a-z0-9_-]/gi, "_") || "media";
    const directory = join(MEDIA_DIR, "managed", ownerDirectory, safeFolder);
    await mkdir(directory, { recursive: true });
    const id = randomUUID();
    const path = join(directory, `${id}.${ext(contentType)}`);
    await writeFile(path, buffer, { flag: "wx" });
    const asset = insertMediaAsset({
      id,
      user_id: userId,
      path,
      mime_type: contentType,
      sha256: hash,
      size_bytes: buffer.byteLength,
    });
    return `/api/media/${asset.id}`;
  }

  const key = `${folder}/${randomUUID()}.${ext(contentType)}`;
  const url = cdnUrl(key);
  await getS3().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  try {
    await storeAssetHash(hash, url, contentType, buffer.byteLength);
  } catch (error) {
    console.error("[r2] Failed to store asset hash:", error instanceof Error ? error.message : "unknown error");
  }
  return url;
}


/** Fetch a remote URL, upload to R2 (or local disk in guest mode), return URL. */
export async function mirrorToR2(sourceUrl: string, folder: string, userId?: string): Promise<string> {
  if (GUEST_MODE) return localStore.mirrorToStorage(sourceUrl, folder);
  const fetched = await fetchSafeBuffer(sourceUrl, { maxBytes: 30 * 1024 * 1024 });
  return uploadBuffer(fetched.buffer, fetched.contentType, folder, userId);
}

/** Upload a base64 data URL to R2 (or local disk in guest mode), return URL. */
export async function uploadDataUrl(dataUrl: string, folder: string, userId?: string): Promise<string> {
  if (GUEST_MODE) return localStore.uploadDataUrl(dataUrl, folder);
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) throw new Error("uploadDataUrl: not a valid data URL");
  const contentType = m[1];
  const buf = Buffer.from(m[2], "base64");
  return uploadBuffer(buf, contentType, folder, userId);
}

/** Resolve any URL to a stored URL (R2 or local disk in guest mode). */
export async function ensureR2(url: string, folder: string, userId?: string): Promise<string> {
  if (GUEST_MODE) return localStore.ensureStorage(url, folder);
  if (MANAGED_MODE && url.startsWith("/api/media/")) {
    const id = url.slice("/api/media/".length).split(/[?#/]/, 1)[0];
    const asset = id && userId ? getMediaAsset(id, userId) : null;
    if (!asset) throw new Error("Media asset is not available");
    return `/api/media/${asset.id}`;
  }
  const cdnBase = process.env.R2_PUBLIC_URL ?? "";
  if (url.startsWith("data:")) return uploadDataUrl(url, folder, userId);
  if (cdnBase && url.startsWith(cdnBase)) return url;
  return mirrorToR2(url, folder, userId);
}
