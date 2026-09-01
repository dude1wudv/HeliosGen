import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";

const LIMIT = 20;
const TABLE_CAP = 1000;
type Item = { id: string; url: string; imageUrls?: string[]; mediaType: "image" | "video"; prompt?: string; model?: string; aspect_ratio?: string; quality?: string; azure_resolution?: string; source: "generation" | "upload"; created_at: string; referenceImageUrls?: string[] };

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mediaType = searchParams.get("type") === "video" ? "video" : "image";
  const page = Math.max(0, Number(searchParams.get("page") ?? 0));
  const source = searchParams.get("source") as "generation" | "upload" | null;
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let genItems: Item[] = [];
  let uploadItems: Item[] = [];
  if (GUEST_MODE || MANAGED_MODE) {
    if (!source || source === "generation") genItems = guestDb.getGenerations(userId, mediaType).map((generation) => ({
      id: generation.id, url: (mediaType === "video" ? generation.video_url : generation.image_url) as string,
      imageUrls: generation.image_urls?.length ? generation.image_urls : undefined, mediaType,
      prompt: generation.prompt, model: generation.model, aspect_ratio: generation.aspect_ratio,
      quality: generation.quality, azure_resolution: generation.azure_resolution, source: "generation", created_at: generation.created_at,
      referenceImageUrls: generation.reference_image_urls?.length ? generation.reference_image_urls : undefined,
    }));
    if (!source || source === "upload") uploadItems = guestDb.getUploads(userId, mediaType).map((upload) => ({
      id: upload.id, url: upload.r2_url, mediaType: upload.mime_type?.startsWith("video/") ? "video" : "image", source: "upload", created_at: upload.created_at,
    }));
  } else {
    const genUrlCol = mediaType === "video" ? "video_url" : "image_url";
    if (!source || source === "generation") {
      const { data } = await supabaseAdmin.from("generations").select("id, generation_type, prompt, model, aspect_ratio, image_url, image_urls, video_url, quality, azure_resolution, created_at, reference_image_urls")
        .eq("user_id", userId).eq("generation_type", mediaType).eq("status", "done").not(genUrlCol, "is", null).order("created_at", { ascending: false }).limit(TABLE_CAP);
      genItems = (data ?? []).map((generation) => ({ id: generation.id, url: (mediaType === "video" ? generation.video_url : generation.image_url) as string, imageUrls: generation.image_urls?.length ? generation.image_urls : undefined, mediaType, prompt: generation.prompt, model: generation.model, aspect_ratio: generation.aspect_ratio, quality: generation.quality, azure_resolution: generation.azure_resolution, source: "generation", created_at: generation.created_at, referenceImageUrls: generation.reference_image_urls?.length ? generation.reference_image_urls : undefined }));
    }
    if (!source || source === "upload") {
      const { data } = await supabaseAdmin.from("user_uploads").select("id, r2_url, mime_type, created_at").eq("user_id", userId).like("mime_type", `${mediaType}/%`).order("created_at", { ascending: false }).limit(TABLE_CAP);
      uploadItems = (data ?? []).map((upload) => ({ id: upload.id, url: upload.r2_url, mediaType: upload.mime_type?.startsWith("video/") ? "video" : "image", source: "upload", created_at: upload.created_at }));
    }
  }
  const seen = new Set<string>();
  const items = [...genItems, ...uploadItems].filter((item) => item.url && (source || !seen.has(item.url) && seen.add(item.url))).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const offset = page * LIMIT;
  return NextResponse.json({ items: items.slice(offset, offset + LIMIT), hasMore: items.length > offset + LIMIT, total: items.length });
}

export async function DELETE(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as { id?: string; source?: "generation" | "upload" };
  if (!body.id || !body.source) return NextResponse.json({ error: "Missing id or source" }, { status: 400 });
  if (GUEST_MODE || MANAGED_MODE) {
    if (body.source === "generation") guestDb.deleteGeneration(body.id, userId); else guestDb.deleteUpload(body.id, userId);
    return NextResponse.json({ ok: true });
  }
  const table = body.source === "generation" ? "generations" : "user_uploads";
  const { error } = await supabaseAdmin.from(table).delete().eq("id", body.id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
