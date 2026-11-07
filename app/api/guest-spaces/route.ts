import { NextRequest, NextResponse } from "next/server";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import { getSpacesSnapshot, saveSpaces, WorkflowRevisionConflict, type GuestSpace } from "@/lib/guest/spaces";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!GUEST_MODE && !MANAGED_MODE) return NextResponse.json({ error: "not found" }, { status: 404 });
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ userId, ...getSpacesSnapshot(userId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  if (!GUEST_MODE && !MANAGED_MODE) return NextResponse.json({ error: "not found" }, { status: 404 });
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { spaces?: GuestSpace[]; expectedUserId?: string; expectedRevision?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!Array.isArray(body.spaces)) return NextResponse.json({ error: "spaces[] required" }, { status: 400 });
  if (MANAGED_MODE && body.expectedUserId !== userId) {
    return NextResponse.json({ error: "session_changed", message: "Reload workflows before saving." }, { status: 409 });
  }
  if ((MANAGED_MODE || body.expectedRevision !== undefined) &&
    (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)) {
    return NextResponse.json({ error: "revision_conflict", message: "Reload workflows before saving." }, { status: 409 });
  }
  try {
    const revision = saveSpaces(userId, body.spaces, body.expectedRevision);
    return NextResponse.json({ ok: true, revision });
  } catch (error) {
    if (error instanceof WorkflowRevisionConflict) {
      return NextResponse.json({ error: "revision_conflict", message: "Workflows changed in another window. Reload before saving." }, { status: 409 });
    }
    throw error;
  }
}
