import { NextRequest, NextResponse } from "next/server";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import { getSpaces, saveSpaces, type GuestSpace } from "@/lib/guest/spaces";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!GUEST_MODE && !MANAGED_MODE) return NextResponse.json({ error: "not found" }, { status: 404 });
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ spaces: getSpaces(userId) });
}

export async function PUT(req: NextRequest) {
  if (!GUEST_MODE && !MANAGED_MODE) return NextResponse.json({ error: "not found" }, { status: 404 });
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { spaces?: GuestSpace[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!Array.isArray(body.spaces)) return NextResponse.json({ error: "spaces[] required" }, { status: 400 });
  saveSpaces(userId, body.spaces);
  return NextResponse.json({ ok: true });
}
