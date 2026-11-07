import { describe, expect, it, vi } from "vitest";
import { promoteActiveDraft, reconcileWorkflowOwner, WorkflowSyncSession } from "@/lib/workflowSyncSession";
import type { Space } from "@/lib/store";

const space = (id: string): Space => ({ id, name: id, nodes: [{ id: "n", position: { x: 0, y: 0 }, data: { label: "Test" } }], edges: [], nodeCounters: {}, createdAt: 1 });

describe("complete-list workflow sync safety", () => {
  it("preserves unclaimed legacy work and the newer active draft before switching accounts", () => {
    const saved = space("legacy");
    const draft = { ...saved.nodes[0], data: { label: "Unsaved draft" } };
    const current = { workflowOwnerId: null, spaces: [saved], activeSpaceId: saved.id, nodes: [draft], edges: [], nodeCounters: {} };
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const reset = vi.fn();
    const backup = JSON.parse(reconcileWorkflowOwner("new-owner", current, storage, reset));
    expect(backup.workflows[0].nodes[0].data.label).toBe("Unsaved draft");
    expect(storage.setItem).toHaveBeenCalledBefore(reset);
    expect(reset).toHaveBeenCalledOnce();
    expect(current.spaces[0].nodes[0].data.label).toBe("Test");
    reconcileWorkflowOwner("same-owner", { ...current, workflowOwnerId: "same-owner" }, storage, reset);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("promotes unsaved active-store edits before server reconciliation", () => {
    const saved = space("active");
    const draft = { ...saved.nodes[0], data: { label: "newer unsaved edit" } };
    const spaces = promoteActiveDraft({ workflowOwnerId: "owner", spaces: [saved], activeSpaceId: saved.id, nodes: [draft], edges: [], nodeCounters: {} }, 50);
    expect(spaces[0].nodes[0].data.label).toBe("newer unsaved edit");
    expect(spaces[0].updatedAt).toBe(50);
    expect(saved.nodes[0].data.label).toBe("Test");
  });

  it("leaves the source untouched when the recovery backup cannot be persisted", () => {
    const saved = space("legacy");
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } };
    const reset = vi.fn();
    expect(() => reconcileWorkflowOwner("new-owner", { workflowOwnerId: "old-owner", spaces: [saved], activeSpaceId: saved.id, nodes: saved.nodes, edges: [], nodeCounters: {} }, storage, reset)).toThrow("quota exceeded");
    expect(reset).not.toHaveBeenCalled();
  });
  it("never saves a new-domain empty cache while initial GET is delayed, then saves the merged list", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValue(new Response('{"ok":true,"revision":1}'));
    const sync = new WorkflowSyncSession(fetcher);
    let local: Space[] = [];
    const load = sync.load((_owner, server) => { local = [...local, ...server]; });
    // Represents debounce, immediate sync and pagehide attempts during a slow GET.
    for (let i = 0; i < 3; i++) expect(await sync.save(local, i === 2)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ userId: "owner-a", revision: 0, spaces: [space("server-workflow")] })));
    expect(await load).toBe(true);
    await sync.save(local);
    const payload = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(payload.expectedUserId).toBe("owner-a");
    expect(payload.expectedRevision).toBe(0);
    expect(payload.spaces.map((value: Space) => value.id)).toEqual(["server-workflow"]);
  });

  it.each([new Response("unavailable", { status: 503 }), new Response("bad json")])("does not treat a failed GET as an empty server list", async (response) => {
    const fetcher = vi.fn().mockResolvedValue(response);
    const sync = new WorkflowSyncSession(fetcher);
    const merge = vi.fn();
    await expect(sync.load(merge)).rejects.toThrow();
    expect(merge).not.toHaveBeenCalled();
    expect(await sync.save([])).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not save if local owner reconciliation/backup failed", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"userId":"new-owner","revision":0,"spaces":[]}'));
    const sync = new WorkflowSyncSession(fetcher);
    await expect(sync.load(() => { throw new Error("storage full"); })).rejects.toThrow("storage full");
    expect(await sync.save([])).toBe(false);
  });

  it("ignores late GET results from a previous mount/session", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const sync = new WorkflowSyncSession(fetcher);
    const merge = vi.fn();
    const load = sync.load(merge);
    sync.cancel();
    finish(new Response('{"userId":"old-owner","revision":0,"spaces":[]}'));
    expect(await load).toBe(false);
    expect(merge).not.toHaveBeenCalled();
    expect(await sync.save([])).toBe(false);
  });

  it("stops stale-account writes on server owner mismatch and requires a new successful load", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"userId":"owner-a","revision":0,"spaces":[]}'))
      .mockResolvedValueOnce(new Response('{"error":"session_changed"}', { status: 409 }))
      .mockResolvedValueOnce(new Response('{"userId":"owner-b","revision":0,"spaces":[]}'))
      .mockResolvedValueOnce(new Response('{"ok":true,"revision":1}'));
    const sync = new WorkflowSyncSession(fetcher);
    await sync.load(() => undefined);
    await expect(sync.save([space("a-only")])).rejects.toThrow("账户已变化");
    expect(await sync.save([])).toBe(false);
    await sync.load(() => undefined);
    await sync.save([space("b-only")]);
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({ expectedUserId: "owner-b", spaces: [{ id: "b-only" }] });
  });

  it("serializes same-tab saves using the revision from the previous successful save", async () => {
    const revisions: number[] = [];
    let revision = 0;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "PUT") return Response.json({ userId: "owner", revision, spaces: [] });
      const body = JSON.parse(String(init.body));
      revisions.push(body.expectedRevision);
      expect(body.expectedRevision).toBe(revision);
      return Response.json({ ok: true, revision: ++revision });
    });
    const sync = new WorkflowSyncSession(fetcher);
    await sync.load(() => undefined);
    await Promise.all([sync.save([space("first")]), sync.save([space("second")])]);
    expect(revisions).toEqual([0, 1]);
    expect(sync.ready).toBe(true);
  });

  it("stops a stale tab before it can delete a workflow saved by another tab", async () => {
    let revision = 0;
    let stored: Space[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "PUT") return Response.json({ userId: "owner", revision, spaces: stored });
      const body = JSON.parse(String(init.body));
      if (body.expectedRevision !== revision) return Response.json({ error: "revision_conflict" }, { status: 409 });
      stored = body.spaces;
      return Response.json({ ok: true, revision: ++revision });
    });
    const first = new WorkflowSyncSession(fetcher);
    const stale = new WorkflowSyncSession(fetcher);
    await first.load(() => undefined);
    await stale.load(() => undefined);
    await first.save([space("only-on-server")]);
    await expect(stale.save([])).rejects.toThrow("其他窗口已更新");
    expect(stale.ready).toBe(false);
    expect(await stale.save([])).toBe(false);
    expect(stored.map((value) => value.id)).toEqual(["only-on-server"]);
  });
});
