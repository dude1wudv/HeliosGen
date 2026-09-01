import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";
import { randomUUID } from "crypto";

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (GUEST_MODE || MANAGED_MODE) return NextResponse.json({ folders: guestDb.getFolders(userId), folderItems: guestDb.getFolderItems(userId) });
  const { data: folders, error: folderError } = await supabaseAdmin.from("folders")
    .select("id, name, parent_id, order_index, created_at, updated_at, color").eq("user_id", userId).order("order_index", { ascending: true });
  if (folderError) return NextResponse.json({ error: folderError.message }, { status: 500 });
  const { data: folderItems, error: itemError } = await supabaseAdmin.from("folder_items")
    .select("folder_id, item_id, created_at").eq("user_id", userId);
  if (itemError) return NextResponse.json({ error: itemError.message }, { status: 500 });
  return NextResponse.json({ folders: folders ?? [], folderItems: folderItems ?? [] });
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { name?: unknown; parentId?: string | null; orderIndex?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof body.name !== "string" || !body.name.trim()) return NextResponse.json({ error: "Missing name" }, { status: 400 });
  if (GUEST_MODE || MANAGED_MODE) {
    const folder = guestDb.insertFolder({ id: randomUUID(), user_id: userId, name: body.name.trim(), parent_id: body.parentId ?? null, order_index: body.orderIndex ?? 0 });
    return NextResponse.json({ folder });
  }
  const { data: folder, error } = await supabaseAdmin.from("folders")
    .insert({ user_id: userId, name: body.name.trim(), parent_id: body.parentId ?? null, order_index: body.orderIndex ?? 0 })
    .select("id, name, parent_id, order_index, created_at, updated_at, color").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ folder });
}
