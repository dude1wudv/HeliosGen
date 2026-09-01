import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
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

const FILE = join(DATA_DIR, ".job-store.json");

function read(): Record<string, JobResult> {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, JobResult>; }
  catch { return {}; }
}

function write(data: Record<string, JobResult>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data), "utf8");
}

export const jobStore = {
  get(taskId: string): JobResult | undefined {
    return read()[taskId];
  },
  getOwned(taskId: string, userId: string): JobResult | undefined {
    const result = read()[taskId];
    return result?.userId === userId ? result : undefined;
  },
  set(taskId: string, result: JobResult): void {
    const data = read();
    data[taskId] = result;
    write(data);
  },
};
