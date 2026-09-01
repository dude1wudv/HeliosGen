import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (GUEST_MODE || MANAGED_MODE) return NextResponse.json({ hasToken: !!guestDb.getAzureApiKey(userId) });

  const { data } = await supabaseAdmin.from("user_settings").select("azure_api_key").eq("user_id", userId).single();
  return NextResponse.json({ hasToken: !!data?.azure_api_key });
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { azureApiKey?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof body.azureApiKey !== "string" || !body.azureApiKey.trim()) {
    return NextResponse.json({ error: "azureApiKey is required" }, { status: 400 });
  }
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.setAzureApiKey(body.azureApiKey.trim(), userId);
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabaseAdmin.from("user_settings")
    .upsert({ user_id: userId, azure_api_key: body.azureApiKey.trim() }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.deleteAzureApiKey(userId);
    return NextResponse.json({ ok: true });
  }
  await supabaseAdmin.from("user_settings").update({ azure_api_key: null }).eq("user_id", userId);
  return NextResponse.json({ ok: true });
}
