import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const originalDataDir = process.env.HELIOS_DATA_DIR;
const originalTtl = process.env.HELIOS_JOB_TTL_MS;

afterEach(() => {
  vi.resetModules();
  if (originalDataDir === undefined) delete process.env.HELIOS_DATA_DIR;
  else process.env.HELIOS_DATA_DIR = originalDataDir;
  if (originalTtl === undefined) delete process.env.HELIOS_JOB_TTL_MS;
  else process.env.HELIOS_JOB_TTL_MS = originalTtl;
});

describe("jobStore persistence", () => {
  it("loads the legacy flat format and writes the versioned format", async () => {
    const root = mkdtempSync(join(tmpdir(), "helios-job-store-"));
    writeFileSync(join(root, ".job-store.json"), JSON.stringify({
      legacy: { status: "pending", type: "image", userId: "user-a" },
    }));
    process.env.HELIOS_DATA_DIR = root;
    const { jobStore } = await import("../lib/jobStore");

    expect(jobStore.getOwned("legacy", "user-a")?.status).toBe("pending");
    jobStore.set("new", { status: "done", imageUrl: "/generated/a.png", userId: "user-a" });

    const stored = JSON.parse(readFileSync(join(root, ".job-store.json"), "utf8"));
    expect(stored.version).toBe(2);
    expect(stored.jobs.new.result.imageUrl).toBe("/generated/a.png");
  });

  it("expires settled jobs while retaining pending jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "helios-job-store-"));
    const old = Date.now() - 10_000;
    writeFileSync(join(root, ".job-store.json"), JSON.stringify({ version: 2, jobs: {
      settled: { result: { status: "done", userId: "u" }, updatedAt: old },
      pending: { result: { status: "pending", userId: "u" }, updatedAt: old },
    } }));
    process.env.HELIOS_DATA_DIR = root;
    process.env.HELIOS_JOB_TTL_MS = "1";
    const { jobStore } = await import("../lib/jobStore");

    expect(jobStore.get("settled")).toBeUndefined();
    expect(jobStore.get("pending")?.status).toBe("pending");
  });
});
