import { NextRequest, NextResponse } from "next/server";
import { jobStore, type SettledJobResult, type SettledJobResultWithoutOwner } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";
import { verifyKieCallbackSignature } from "@/lib/mediaSignature";

function extractUrls(resultJson?: string): string[] {
  if (!resultJson) return [];
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: unknown; resultUrl?: unknown };
    const urls = parsed.resultUrls ?? parsed.resultUrl;
    if (Array.isArray(urls)) return urls.filter((url): url is string => typeof url === "string" && url.length > 0);
    return typeof urls === "string" && urls ? [urls] : [];
  } catch {
    return [];
  }
}

type ResultWithoutOwner = SettledJobResultWithoutOwner;

function settle(taskId: string, result: ResultWithoutOwner): string | null {
  const pending = jobStore.get(taskId);
  if (!pending?.userId || pending.status !== "pending") return null;
  const owned = { ...result, userId: pending.userId } as SettledJobResult;
  jobStore.set(taskId, owned);
  jobEvents.emit(`job:${taskId}`, owned);
  return pending.userId;
}

async function persistError(taskId: string, userId: string, message: string): Promise<void> {
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.updateGeneration(taskId, userId, { status: "error", error_msg: message });
    return;
  }
  const { error } = await supabaseAdmin.from("generations")
    .update({ status: "error", error_msg: message })
    .eq("task_id", taskId)
    .eq("user_id", userId);
  if (error) console.error("[callback] generation update failed", error.message);
}

async function persistSuccess(taskId: string, userId: string, isVideo: boolean, urls: string[]): Promise<void> {
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.updateGeneration(taskId, userId, isVideo
      ? { status: "done", video_url: urls[0] }
      : { status: "done", image_url: urls[0], image_urls: urls });
    return;
  }
  const values = isVideo
    ? { status: "done", video_url: urls[0] }
    : { status: "done", image_url: urls[0], image_urls: urls };
  const { error } = await supabaseAdmin.from("generations").update(values).eq("task_id", taskId).eq("user_id", userId);
  if (error) console.error("[callback] generation update failed", error.message);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  if (MANAGED_MODE && !verifyKieCallbackSignature(
    req.nextUrl.searchParams.get("expires"),
    req.nextUrl.searchParams.get("sig"),
  )) {
    return NextResponse.json({ received: false }, { status: 401 });
  }
  try { body = await req.json(); } catch { return NextResponse.json({ received: true }); }
  const data = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
  const candidate = data.taskId ?? data.id ?? body.taskId ?? body.id;
  const taskId = typeof candidate === "string" && candidate.length <= 200 ? candidate : null;
  if (!taskId) return NextResponse.json({ received: true });
  const pending = jobStore.get(taskId);
  if (!pending?.userId || pending.status !== "pending") return NextResponse.json({ received: true });
  const state = String(data.state ?? data.status ?? "").toLowerCase();

  if ((body.code !== undefined && body.code !== 200) || state === "fail" || state === "failed" || state === "error") {
    const message = String(data.failMsg ?? data.error ?? body.msg ?? "Generation failed").slice(0, 240).replace(/[\r\n]/g, " ");
    const userId = settle(taskId, { status: "error", error: message });
    if (userId) await persistError(taskId, userId, message);
    return NextResponse.json({ received: true });
  }

  if (state === "success") {
    let urls = extractUrls(typeof data.resultJson === "string" ? data.resultJson : undefined);
    if (urls.length === 0 && typeof data.videoUrl === "string") urls = [data.videoUrl];
    const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
    if (urls.length === 0 && typeof outputUrl === "string") urls = [outputUrl];
    if (urls.length === 0) return NextResponse.json({ received: true });
    const isVideo = pending.type === "video";
    try {
      const stored = await Promise.all(urls.map((url) => mirrorToR2(url, isVideo ? "videos" : "images", pending.userId)));
      const userId = settle(taskId, isVideo
        ? { status: "done", videoUrl: stored[0] }
        : { status: "done", imageUrl: stored[0], imageUrls: stored });
      if (userId) await persistSuccess(taskId, userId, isVideo, stored);
    } catch (error) {
      console.error("[callback] storage upload failed", error instanceof Error ? error.message : "unknown error");
      if (!MANAGED_MODE) {
        const userId = settle(taskId, isVideo
          ? { status: "done", videoUrl: urls[0] }
          : { status: "done", imageUrl: urls[0], imageUrls: urls });
        if (userId) await persistSuccess(taskId, userId, isVideo, urls);
      } else {
        const userId = settle(taskId, { status: "error", error: "Generated media could not be stored" });
        if (userId) await persistError(taskId, userId, "Generated media could not be stored");
      }
    }
  }
  return NextResponse.json({ received: true });
}
