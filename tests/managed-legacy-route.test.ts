import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  createReadStream: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("fs", () => fsMocks);

const originalManagedMode = process.env.SUB2API_MANAGED_MODE;
const originalPublicManagedMode = process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE;

afterEach(() => {
  vi.doUnmock("@/lib/guest/paths");
  vi.doUnmock("@/lib/managedMode");
  if (originalManagedMode === undefined) delete process.env.SUB2API_MANAGED_MODE;
  else process.env.SUB2API_MANAGED_MODE = originalManagedMode;
  if (originalPublicManagedMode === undefined) delete process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE;
  else process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE = originalPublicManagedMode;
  vi.resetModules();
  vi.clearAllMocks();
});

describe("managed legacy generated-media route", () => {
  it("returns 404 without consulting the filesystem", async () => {
    vi.doMock("@/lib/managedMode", () => ({ MANAGED_MODE: true }));
    vi.doMock("@/lib/guest/paths", () => ({ MEDIA_DIR: "/synthetic/media" }));
    vi.resetModules();
    // Import dynamically because this test needs the route to observe the managed-mode mock.
    const { GET } = await import("@/app/generated/[...path]/route");

    const response = await GET({} as never, { params: Promise.resolve({ path: ["old.png"] }) });

    expect(response.status).toBe(404);
    expect(fsMocks.createReadStream).not.toHaveBeenCalled();
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(fsMocks.statSync).not.toHaveBeenCalled();
  });
});
