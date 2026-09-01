import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import * as guestDb from "@/lib/guest/db";

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (GUEST_MODE || MANAGED_MODE) return NextResponse.json({ hasToken: !!guestDb.getKieApiToken(userId) });

  const { data } = await supabaseAdmin.from("user_settings").select("kie_api_token").eq("user_id", userId).single();
  return NextResponse.json({ hasToken: !!data?.kie_api_token });
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { kieApiToken?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (typeof body.kieApiToken !== "string" || !body.kieApiToken.trim()) {
    return NextResponse.json({ error: "kieApiToken is required" }, { status: 400 });
  }
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.setKieApiToken(body.kieApiToken.trim(), userId);
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabaseAdmin.from("user_settings")
    .upsert({ user_id: userId, kie_api_token: body.kieApiToken.trim() }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (GUEST_MODE || MANAGED_MODE) {
    guestDb.deleteKieApiToken(userId);
    return NextResponse.json({ ok: true });
  }
  await supabaseAdmin.from("user_settings").update({ kie_api_token: null }).eq("user_id", userId);
  return NextResponse.json({ ok: true });
}
