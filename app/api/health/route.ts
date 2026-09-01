import { NextResponse } from "next/server";
import { access, constants, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "@/lib/guest/paths";
import { db } from "@/lib/guest/sqlite";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  let sqlite = false;
  try {
    db().prepare("SELECT 1").get();
    sqlite = true;
  } catch { /* report unhealthy without configuration details */ }
  let writable = false;
  const probe = join(DATA_DIR, ".health-check");
  try {
    await access(DATA_DIR, constants.W_OK);
    await writeFile(probe, "ok", { flag: "w" });
    await unlink(probe);
    writable = true;
  } catch { /* report only the boolean health state */ }
  const healthy = sqlite && writable;
  return NextResponse.json({ ok: healthy, sqlite: { readable: sqlite, writable } }, { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
