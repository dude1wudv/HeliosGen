import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: { name?: string; parentId?: string | null; orderIndex?: number; color?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const updates: { name?: string; parent_id?: string | null; order_index?: number; color?: string | null } = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.parentId !== undefined) updates.parent_id = body.parentId;
  if (body.orderIndex !== undefined) updates.order_index = body.orderIndex;
  if (body.color !== undefined) updates.color = body.color;
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.updateFolder(id, userId, updates);
    return NextResponse.json({ ok: true });
  }
  const { error } = await supabaseAdmin.from("folders").update({ ...updates, updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.deleteFolder(id, userId);
    return NextResponse.json({ ok: true });
  }
  const { error } = await supabaseAdmin.from("folders").delete().eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
