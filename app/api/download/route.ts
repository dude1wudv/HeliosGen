import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { resolveUserId, GUEST_MODE } from "@/lib/guestMode";
import { getMediaAsset } from "@/lib/guest/db";
import { MEDIA_DIR } from "@/lib/guest/paths";
import { fetchSafeBuffer } from "@/lib/ssrf";
import { readManagedMediaAsset } from "@/lib/managedMedia";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get("url");
  const filename = (req.nextUrl.searchParams.get("filename") ?? "download").replace(/[\r\n"\\]/g, "_").slice(0, 120);
  if (!requested) return new NextResponse("Missing url", { status: 400 });
  const userId = await resolveUserId(req);
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  try {
    let buffer: Buffer;
    let contentType = "application/octet-stream";
    if (GUEST_MODE && requested.startsWith("/generated/")) {
      const relative = normalize(requested.slice("/generated/".length));
      if (relative.startsWith("..") || relative.includes("\0")) return new NextResponse("Forbidden", { status: 403 });
      buffer = await readFile(join(MEDIA_DIR, relative));
    } else if (requested.startsWith("/api/media/")) {
      const id = requested.slice("/api/media/".length).split(/[?#/]/, 1)[0];
      const asset = id ? getMediaAsset(id, userId) : null;
      if (!asset) return new NextResponse("Not found", { status: 404 });
      buffer = await readManagedMediaAsset(asset, 100 * 1024 * 1024);
      contentType = asset.mime_type;
    } else {
      const fetched = await fetchSafeBuffer(requested, { maxBytes: 100 * 1024 * 1024, timeoutMs: 20_000 });
      buffer = fetched.buffer;
      contentType = fetched.contentType;
    }
    return new NextResponse(Uint8Array.from(buffer), { headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
  } catch {
    return new NextResponse("Fetch failed", { status: 502 });
  }
}
