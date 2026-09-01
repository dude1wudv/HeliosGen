import { NextRequest, NextResponse } from "next/server";
import { uploadBuffer } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import { fetchSafeBuffer } from "@/lib/ssrf";
import * as guestDb from "@/lib/guest/db";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json() as { url?: string };
    if (!url || typeof url !== "string") return NextResponse.json({ error: "Missing url" }, { status: 400 });
    const upstream = await fetchSafeBuffer(url, {
      maxBytes: 30 * 1024 * 1024,
      timeoutMs: 15_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HeliosGen/1.0)" },
    });
    const mimeType = upstream.contentType.split(";", 1)[0].trim() || "application/octet-stream";
    const isImage = mimeType.startsWith("image/");
    const isVideo = mimeType.startsWith("video/");
    if (!isImage && !isVideo) return NextResponse.json({ error: "URL does not point to an image or video" }, { status: 400 });
    const userId = await resolveUserId(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const cdnUrl = await uploadBuffer(upstream.buffer, mimeType, isVideo ? "references" : "uploads", userId);
    if (GUEST_MODE || MANAGED_MODE) {
      guestDb.insertUpload({ user_id: userId, r2_url: cdnUrl, mime_type: mimeType, source: "user_upload" });
    } else {
      supabaseAdmin.from("user_uploads").insert({ user_id: userId, r2_url: cdnUrl, mime_type: mimeType, source: "user_upload" })
        .then(({ error }) => { if (error) console.error("[fetch-url] db insert error", error.message); });
    }
    return NextResponse.json({ cdnUrl, mediaType: isImage ? "image" : "video" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "Fetch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
