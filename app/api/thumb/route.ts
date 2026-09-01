import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { resolveUserId } from "@/lib/guestMode";
import { getMediaAsset } from "@/lib/guest/db";
import { fetchSafeBuffer } from "@/lib/ssrf";
import { readManagedMediaAsset } from "@/lib/managedMedia";

export const runtime = "nodejs";
const ALLOWED_WIDTHS = new Set([16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]);

export async function GET(req: NextRequest) {
  const urlParam = req.nextUrl.searchParams.get("url");
  if (!urlParam) return new NextResponse("Missing url", { status: 400 });
  const userId = await resolveUserId(req);
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  const url = urlParam;
  let contentType = "";
  let localBuffer: Buffer | null = null;
  if (urlParam.startsWith("/api/media/")) {
    const id = urlParam.slice("/api/media/".length).split(/[?#/]/, 1)[0];
    const asset = id ? getMediaAsset(id, userId) : null;
    if (!asset) return new NextResponse("Not found", { status: 404 });
    localBuffer = await readManagedMediaAsset(asset, 30 * 1024 * 1024);
    contentType = asset.mime_type;
  }
  const widthParam = Number(req.nextUrl.searchParams.get("w") ?? "384");
  const width = ALLOWED_WIDTHS.has(widthParam) ? widthParam : 384;
  try {
    const fetched = localBuffer
      ? { buffer: localBuffer, contentType }
      : await fetchSafeBuffer(url, { maxBytes: 30 * 1024 * 1024, timeoutMs: 15_000 });
    contentType ||= fetched.contentType.split(";", 1)[0];
    if (!contentType.startsWith("image/")) return new NextResponse("Not an image", { status: 415 });
    const buffer = fetched.buffer;
    try {
      const optimized = await sharp(buffer).rotate().resize(width, undefined, { withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      return new NextResponse(Uint8Array.from(optimized), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=3600", Vary: "Accept" } });
    } catch {
      return new NextResponse(Uint8Array.from(buffer), { headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=3600" } });
    }
  } catch {
    return new NextResponse("Upstream fetch failed", { status: 502 });
  }
}
