import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { MANAGED_MODE } from "@/lib/managedMode";
/**
 * The desktop-only Codex provider is never exposed by managed deployments.
 */
function binaryOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("codex-imagegen", ["--help"]);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

export async function GET() {
  if (MANAGED_MODE) return NextResponse.json({ error: "provider_unavailable", code: "provider_unavailable" }, { status: 403 });
  const authPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  const [installed, authFound] = await Promise.all([
    binaryOnPath(),
    Promise.resolve(existsSync(authPath)),
  ]);
  return NextResponse.json({ installed, authFound, ready: installed && authFound });
}
