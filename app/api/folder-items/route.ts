import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { folderId?: string; itemIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.folderId || !Array.isArray(body.itemIds)) return NextResponse.json({ error: "Missing folderId or itemIds" }, { status: 400 });
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.insertFolderItems(body.folderId, body.itemIds, userId);
    return NextResponse.json({ ok: true });
  }
  const rows = body.itemIds.map((itemId) => ({ folder_id: body.folderId, item_id: itemId, user_id: userId }));
  const { error } = await supabaseAdmin.from("folder_items").upsert(rows, { onConflict: "folder_id,item_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { folderId?: string; itemIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.folderId || !Array.isArray(body.itemIds)) return NextResponse.json({ error: "Missing folderId or itemIds" }, { status: 400 });
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.deleteFolderItems(body.folderId, body.itemIds, userId);
    return NextResponse.json({ ok: true });
  }
  const { error } = await supabaseAdmin.from("folder_items").delete().eq("folder_id", body.folderId).eq("user_id", userId).in("item_id", body.itemIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
