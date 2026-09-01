import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/guestMode";
import { getMediaAsset } from "@/lib/guest/db";
import { verifyMediaSignature } from "@/lib/mediaSignature";
import { readManagedMediaAsset } from "@/lib/managedMedia";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!/^[0-9a-f-]{20,80}$/i.test(id)) return new NextResponse("Not found", { status: 404 });

  let userId = await resolveUserId(request);
  if (!userId) {
    const signedUser = request.nextUrl.searchParams.get("user");
    if (signedUser && verifyMediaSignature(
      id,
      signedUser,
      request.nextUrl.searchParams.get("expires"),
      request.nextUrl.searchParams.get("sig"),
    )) {
      userId = signedUser;
    }
  }
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const asset = getMediaAsset(id, userId);
  if (!asset) return new NextResponse("Not found", { status: 404 });
  try {
    const buffer = await readManagedMediaAsset(asset, 100 * 1024 * 1024);
    return new NextResponse(Uint8Array.from(buffer), {
      headers: {
        "Content-Type": asset.mime_type,
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "private, max-age=900",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Media unavailable", { status: 404 });
  }
}
