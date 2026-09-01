import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import { MANAGED_MODE } from "@/lib/managedMode";
import { readSession } from "@/lib/sub2api/session";

export async function getKieTokenForUser(userId: string): Promise<string | null> {
  if (GUEST_MODE || MANAGED_MODE) {
    const { getKieApiToken } = await import("./guest/db");
    return getKieApiToken(userId);
  }
  const { data } = await supabaseAdmin
    .from("user_settings")
    .select("kie_api_token")
    .eq("user_id", userId)
    .single();
  return data?.kie_api_token ?? null;
}

export async function getKieToken(req: Request): Promise<string | null> {
  if (GUEST_MODE || MANAGED_MODE) {
    const userId = MANAGED_MODE ? readSession(req)?.userId : "guest";
    return userId ? getKieTokenForUser(userId) : null;
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  const userId = data.user?.id;
  if (!userId) return null;
  return getKieTokenForUser(userId);
}
