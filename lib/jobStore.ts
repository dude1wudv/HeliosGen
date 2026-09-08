import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./guest/paths";

export type PendingJobResult = { status: "pending"; type?: "image" | "video"; userId: string };
export type SettledJobResult =
  | { status: "done"; imageUrl?: string; imageUrls?: string[]; videoUrl?: string; userId: string }
  | { status: "error"; error: string; userId: string };
export type SettledJobResultWithoutOwner =
  | { status: "done"; imageUrl?: string; imageUrls?: string[]; videoUrl?: string }
  | { status: "error"; error: string };
export type JobResult = PendingJobResult | SettledJobResult;
type StoredJob = { result: JobResult; updatedAt: number };
type StoreFile = { version: 2; jobs: Record<string, StoredJob> };

const FILE = join(DATA_DIR, ".job-store.json");
const SETTLED_TTL_MS = Number(process.env.HELIOS_JOB_TTL_MS || 7 * 24 * 60 * 60 * 1000);

function read(): Record<string, StoredJob> {
  if (!existsSync(FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as unknown;
    if (
      parsed && typeof parsed === "object" &&
      "version" in parsed && parsed.version === 2 &&
      "jobs" in parsed && parsed.jobs && typeof parsed.jobs === "object"
    ) return parsed.jobs as Record<string, StoredJob>;
    const migrated: Record<string, StoredJob> = {};
    const now = Date.now();
    if (!parsed || typeof parsed !== "object") return migrated;
    for (const [taskId, result] of Object.entries(parsed as Record<string, JobResult>)) {
      migrated[taskId] = { result, updatedAt: now };
    }
    return migrated;
  }
  catch { return {}; }
}

const data = read();

function prune(now = Date.now()): boolean {
  let changed = false;
  for (const [taskId, stored] of Object.entries(data)) {
    if (stored.result.status !== "pending" && now - stored.updatedAt > SETTLED_TTL_MS) {
      delete data[taskId];
      changed = true;
    }
  }
  return changed;
}

function write(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${FILE}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 2, jobs: data } satisfies StoreFile), "utf8");
  renameSync(temporary, FILE);
}

export const jobStore = {
  get(taskId: string): JobResult | undefined {
    if (prune()) write();
    return data[taskId]?.result;
  },
  getOwned(taskId: string, userId: string): JobResult | undefined {
    if (prune()) write();
    const result = data[taskId]?.result;
    return result?.userId === userId ? result : undefined;
  },
  set(taskId: string, result: JobResult): void {
    prune();
    data[taskId] = { result, updatedAt: Date.now() };
    write();
  },
};
