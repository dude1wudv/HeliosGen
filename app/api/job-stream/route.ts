import { NextRequest } from "next/server";
import { jobStore, type JobResult } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { resumeKieJob } from "@/lib/kieJobPoller";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};
const TIMEOUT_MS = 12 * 60 * 1000;

function immediate(payload: JobResult): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: SSE_HEADERS });
}

async function recoverJob(taskId: string, userId: string): Promise<JobResult | null> {
  if (GUEST_MODE || MANAGED_MODE) {
    const gen = guestDb.recoverJob(taskId, userId);
    if (gen?.status === "done") {
      return gen.video_url
        ? { status: "done", videoUrl: gen.video_url, userId }
        : { status: "done", imageUrl: gen.image_url ?? undefined, imageUrls: gen.image_urls ?? undefined, userId };
    }
    if (gen?.status === "error") return { status: "error", error: gen.error_msg ?? "Generation failed", userId };
    return null;
  }

  const { data: gen } = await supabaseAdmin
    .from("generations")
    .select("status, video_url, image_url, image_urls, error_msg")
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .single();
  if (gen?.status === "done") {
    return gen.video_url
      ? { status: "done", videoUrl: gen.video_url, userId }
      : { status: "done", imageUrl: gen.image_url, imageUrls: gen.image_urls, userId };
  }
  if (gen?.status === "error") return { status: "error", error: gen.error_msg ?? "Generation failed", userId };
  return null;
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  const userId = await resolveUserId(req);
  if (!userId) return new Response("Unauthorized", { status: 401 });
  if (!taskId) return new Response("taskId required", { status: 400 });

  const existing = jobStore.getOwned(taskId, userId);
  if (existing && existing.status !== "pending") return immediate(existing);
  if (!existing) {
    const recovered = await recoverJob(taskId, userId);
    if (recovered) {
      jobStore.set(taskId, recovered);
      return immediate(recovered);
    }
    return new Response("Not found", { status: 404 });
  }

  if (GUEST_MODE && !taskId.startsWith("azure-")) {
    resumeKieJob(taskId, existing.type === "video" ? "video" : "image");
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        jobEvents.off(`job:${taskId}`, send);
        controller.close();
      };
      const send = (payload: JobResult) => {
        if (payload.userId !== userId) return;
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        close();
      };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": ping\n\n"));
      }, 25_000);
      const timeout = setTimeout(() => send({ status: "error", error: "Generation timed out", userId }), TIMEOUT_MS);
      jobEvents.once(`job:${taskId}`, send);
      req.signal.addEventListener("abort", () => close(), { once: true });
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
