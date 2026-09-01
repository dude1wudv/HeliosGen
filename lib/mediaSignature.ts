import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_TTL_SECONDS = 15 * 60;

function signingKey(): Buffer {
  const value = process.env.HELIOS_SESSION_SECRET ?? "";
  const key = Buffer.from(value, "base64");
  if (key.byteLength !== 32) throw new Error("Media signing key is not configured");
  return key;
}

function digest(assetId: string, userId: string, expires: number): Buffer {
  return createHmac("sha256", signingKey()).update(`media.${assetId}.${userId}.${expires}`).digest();
}

export function createMediaSignature(assetId: string, userId: string, origin: string): string {
  const expires = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS;
  const signature = digest(assetId, userId, expires).toString("base64url");
  const url = new URL(`/api/media/${encodeURIComponent(assetId)}`, origin);
  url.searchParams.set("user", userId);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("sig", signature);
  return url.toString();
}

export function verifyMediaSignature(assetId: string, userId: string, expiresValue: string | null, signatureValue: string | null): boolean {
  const expires = Number(expiresValue);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  if (!signatureValue) return false;
  try {
    const expected = digest(assetId, userId, expires);
    const supplied = Buffer.from(signatureValue, "base64url");
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

function callbackDigest(expires: number): Buffer {
  return createHmac("sha256", signingKey()).update(`callback.${expires}`).digest();
}

export function createKieCallbackUrl(origin: string): string {
  const expires = Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS;
  const url = new URL("/api/callback", origin);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("sig", callbackDigest(expires).toString("base64url"));
  return url.toString();
}

export function verifyKieCallbackSignature(expiresValue: string | null, signatureValue: string | null): boolean {
  const expires = Number(expiresValue);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000) || !signatureValue) return false;
  try {
    const expected = callbackDigest(expires);
    const supplied = Buffer.from(signatureValue, "base64url");
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}
