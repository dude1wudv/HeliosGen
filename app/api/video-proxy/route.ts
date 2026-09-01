import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/guestMode";
import { getMediaAsset } from "@/lib/guest/db";
import { fetchSafeBuffer } from "@/lib/ssrf";
import { readManagedMediaAsset } from "@/lib/managedMedia";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("url");
  if (!requested) return new NextResponse("Missing url param", { status: 400 });
  const userId = await resolveUserId(req);
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  const url = requested;
  let contentType = "video/mp4";
  let localBuffer: Buffer | null = null;
  if (requested.startsWith("/api/media/")) {
    const id = requested.slice("/api/media/".length).split(/[?#/]/, 1)[0];
    const asset = id ? getMediaAsset(id, userId) : null;
    if (!asset) return new NextResponse("Not found", { status: 404 });
    localBuffer = await readManagedMediaAsset(asset, 100 * 1024 * 1024);
    contentType = asset.mime_type;
  }
  try {
    const fetched = localBuffer
      ? { buffer: localBuffer, contentType }
      : await fetchSafeBuffer(url, { maxBytes: 100 * 1024 * 1024, timeoutMs: 30_000 });
    const headers = new Headers({
      "Access-Control-Allow-Origin": req.nextUrl.origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": fetched.contentType || contentType,
      "Content-Length": String(fetched.buffer.byteLength),
      "Cache-Control": "private, max-age=3600",
    });
    return new NextResponse(Uint8Array.from(fetched.buffer), { headers });
  } catch {
    return new NextResponse("Failed to fetch video", { status: 502 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: { "Access-Control-Allow-Methods": "GET, OPTIONS" } });
}
