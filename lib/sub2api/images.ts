import { randomUUID } from "node:crypto";
import { fetchSafeBuffer } from "@/lib/ssrf";
import { getMediaAsset } from "@/lib/guest/db";
import { readManagedMediaAsset } from "@/lib/managedMedia";

const ALLOWED_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export interface Sub2ApiImageRequest {
  apiBaseUrl: string;
  apiKey: string;
  userId: string;
  prompt: string;
  aspectRatio: string;
  quality: string;
  resolution?: string;
  customWidth?: number;
  customHeight?: number;
  imageUrls?: string[];
}

export interface Sub2ApiImageResult {
  buffer: Buffer;
  mimeType: string;
}

function imageSize(request: Sub2ApiImageRequest): string {
  if (request.aspectRatio === "custom") {
    if (!Number.isSafeInteger(request.customWidth) || !Number.isSafeInteger(request.customHeight)) throw new Error("Invalid image dimensions");
    return `${request.customWidth}x${request.customHeight}`;
  }
  const tier = request.resolution === "1k" || request.resolution === "2k" || request.resolution === "4k" ? request.resolution : "2k";
  const maps: Record<string, Record<string, string>> = {
    "1k": { auto: "auto", "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1008x1792", "4:3": "1280x960", "3:4": "960x1280" },
    "2k": { auto: "auto", "1:1": "2048x2048", "16:9": "2048x1152", "9:16": "1440x2560", "4:3": "2048x1536", "3:4": "1536x2048" },
    "4k": { auto: "auto", "1:1": "2880x2880", "16:9": "3840x2160", "9:16": "2160x3840", "4:3": "3072x2304", "3:4": "2304x3072" },
  };
  return maps[tier][request.aspectRatio] ?? "1024x1024";
}

function normalizedQuality(value: string): "low" | "medium" | "high" | "auto" {
  if (ALLOWED_QUALITIES.has(value)) return value as "low" | "medium" | "high" | "auto";
  throw new Error("quality must be low, medium, high, or auto");
}

function safeError(status: number, body: string): Error & { status?: number; code?: string } {
  let code: string | undefined;
  let message = "Sub2API image request failed";
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } | string; code?: unknown; message?: unknown };
    const error = parsed.error;
    code = typeof error === "object" && error && typeof error.code === "string" ? error.code : typeof parsed.code === "string" ? parsed.code : undefined;
    const candidate = typeof error === "object" && error && typeof error.message === "string" ? error.message : typeof error === "string" ? error : parsed.message;
    if (typeof candidate === "string" && candidate.length > 0) message = candidate.slice(0, 240).replace(/[\r\n]/g, " ");
  } catch { /* upstream may return HTML/plain text */ }
  const error = Object.assign(new Error(message), { status, code });
  return error;
}

async function readImage(value: string, userId: string): Promise<{ buffer: Buffer; mimeType: string; name: string }> {
  if (value.startsWith("data:")) {
    const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("Invalid image data");
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("Image is too large");
    return { buffer, mimeType: match[1], name: `${randomUUID()}.bin` };
  }
  if (value.startsWith("/api/media/")) {
    const id = value.slice("/api/media/".length).split(/[?#/]/, 1)[0];
    const asset = id ? getMediaAsset(id, userId) : null;
    if (!asset) throw new Error("Image is not available");
    const buffer = await readManagedMediaAsset(asset, MAX_IMAGE_BYTES);
    return { buffer, mimeType: asset.mime_type, name: `${asset.id}.bin` };
  }
  const fetched = await fetchSafeBuffer(value, { maxBytes: MAX_IMAGE_BYTES });
  return { buffer: fetched.buffer, mimeType: fetched.contentType.split(";", 1)[0] || "image/png", name: `${randomUUID()}.bin` };
}

function endpoint(base: string, path: string): string {
  const value = base.replace(/\/$/, "");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "sub2api") throw new Error("Invalid Sub2API API base URL");
  return `${value}${path}`;
}

async function parseUpstreamResponse(response: Response): Promise<Sub2ApiImageResult> {
  const body = await response.text();
  if (!response.ok) throw safeError(response.status, body);
  let parsed: { data?: Array<{ b64_json?: unknown; url?: unknown }> };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { throw new Error("Sub2API returned invalid image data"); }
  const image = parsed.data?.[0];
  if (typeof image?.b64_json === "string") {
    const buffer = Buffer.from(image.b64_json, "base64");
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("Sub2API image is invalid");
    return { buffer, mimeType: "image/png" };
  }
  if (typeof image?.url === "string") {
    const fetched = await fetchSafeBuffer(image.url, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 15_000 });
    return { buffer: fetched.buffer, mimeType: fetched.contentType.split(";", 1)[0] || "image/png" };
  }
  throw new Error("Sub2API returned no image");
}

export async function generateSub2ApiImage(request: Sub2ApiImageRequest): Promise<Sub2ApiImageResult> {
  const quality = normalizedQuality(request.quality);
  const size = imageSize(request);
  const images = (request.imageUrls ?? []).slice(0, 16);
  const authorization = `Bearer ${request.apiKey}`;
  if (images.length === 0) {
    const response = await fetch(endpoint(request.apiBaseUrl, "/images/generations"), {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: request.prompt, n: 1, size, quality, output_format: "png", response_format: "b64_json" }),
      cache: "no-store",
    });
    return parseUpstreamResponse(response);
  }

  const form = new FormData();
  form.set("model", "gpt-image-2");
  form.set("prompt", request.prompt);
  form.set("size", size);
  form.set("quality", quality);
  form.set("output_format", "png");
  for (const value of images) {
    const image = await readImage(value, request.userId);
    form.append("image", new Blob([Uint8Array.from(image.buffer)], { type: image.mimeType }), image.name);
  }
  const response = await fetch(endpoint(request.apiBaseUrl, "/images/edits"), {
    method: "POST",
    headers: { Authorization: authorization, Accept: "application/json" },
    body: form,
    cache: "no-store",
  });
  return parseUpstreamResponse(response);
}
