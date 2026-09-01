import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { resumeKieJob } from "@/lib/kieJobPoller";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";

async function recoverJob(taskId: string, userId: string): Promise<"done" | "error" | "pending" | "not_found"> {
  if (GUEST_MODE || MANAGED_MODE) {
    const gen = guestDb.recoverJob(taskId, userId);
    if (!gen) return "not_found";
    if (gen.status === "done") {
      const result = gen.video_url
        ? { status: "done" as const, videoUrl: gen.video_url, userId }
        : { status: "done" as const, imageUrl: gen.image_url ?? undefined, imageUrls: gen.image_urls ?? undefined, userId };
      jobStore.set(taskId, result);
      return "done";
    }
    if (gen.status === "error") {
      jobStore.set(taskId, { status: "error", error: gen.error_msg ?? "Generation failed", userId });
      return "error";
    }
    return "pending";
  }

  const { data: gen } = await supabaseAdmin
    .from("generations")
    .select("status, video_url, image_url, image_urls, error_msg")
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .single();
  if (!gen) return "not_found";

  if (gen.status === "done") {
    const result = gen.video_url
      ? { status: "done" as const, videoUrl: gen.video_url, userId }
      : { status: "done" as const, imageUrl: gen.image_url, imageUrls: gen.image_urls, userId };
    jobStore.set(taskId, result);
    return "done";
  }
  if (gen.status === "error") {
    jobStore.set(taskId, { status: "error", error: gen.error_msg ?? "Generation failed", userId });
    return "error";
  }
  return "pending";
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });

  const result = jobStore.getOwned(taskId, userId);
  if (result) {
    if (GUEST_MODE && result.status === "pending" && !taskId.startsWith("azure-")) {
      resumeKieJob(taskId, result.type === "video" ? "video" : "image");
    }
    return NextResponse.json(result);
  }

  const recovered = await recoverJob(taskId, userId);
  if (recovered === "done" || recovered === "error") {
    return NextResponse.json(jobStore.getOwned(taskId, userId));
  }
  if (recovered === "pending") return NextResponse.json({ status: "pending" });
  return NextResponse.json({ status: "not_found" }, { status: 404 });
}
