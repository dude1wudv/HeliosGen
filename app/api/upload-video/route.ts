import { NextRequest, NextResponse } from "next/server";
import { uploadBuffer } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const mimeType = req.headers.get("content-type")?.split(";", 1)[0] ?? "video/mp4";
    const maxBytes = 100 * 1024 * 1024;
    if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return NextResponse.json({ error: "File exceeds 100 MB limit" }, { status: 413 });
    const buffer = Buffer.from(await req.arrayBuffer());
    if (buffer.byteLength > maxBytes) return NextResponse.json({ error: "File exceeds 100 MB limit" }, { status: 413 });
    const cdnUrl = await uploadBuffer(buffer, mimeType, "references", userId);
    if (GUEST_MODE || MANAGED_MODE) {
      guestDb.insertUpload({ user_id: userId, r2_url: cdnUrl, mime_type: mimeType, source: "user_upload" });
    } else {
      supabaseAdmin.from("user_uploads").insert({ user_id: userId, r2_url: cdnUrl, mime_type: mimeType, source: "user_upload" })
        .then(({ error }) => { if (error) console.error("[upload-video] db insert error", error.message); });
    }
    return NextResponse.json({ cdnUrl });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 200) : "Upload failed" }, { status: 400 });
  }
}
