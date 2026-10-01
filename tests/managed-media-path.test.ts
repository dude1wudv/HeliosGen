import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.HELIOS_DATA_DIR;
const originalMediaDir = process.env.HELIOS_MEDIA_DIR;
const originalManagedMode = process.env.SUB2API_MANAGED_MODE;
const originalPublicManagedMode = process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE;

afterEach(() => {
  for (const [key, value] of Object.entries({
    HELIOS_DATA_DIR: originalDataDir,
    HELIOS_MEDIA_DIR: originalMediaDir,
    SUB2API_MANAGED_MODE: originalManagedMode,
    NEXT_PUBLIC_SUB2API_MANAGED_MODE: originalPublicManagedMode,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("managed default media path", () => {
  it("persists media under DATA_DIR/media unless explicitly overridden", async () => {
    process.env.SUB2API_MANAGED_MODE = "true";
    delete process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE;
    process.env.HELIOS_DATA_DIR = "/persistent/app-data";
    delete process.env.HELIOS_MEDIA_DIR;
    vi.resetModules();

    const { DATA_DIR, MEDIA_DIR } = await import("@/lib/guest/paths");

    expect(DATA_DIR).toBe("/persistent/app-data");
    expect(MEDIA_DIR).toBe(join(DATA_DIR, "media"));
  });
});
