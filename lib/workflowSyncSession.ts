import { appFetch } from "./appPaths";
import type { Space } from "./store";
import type { useWorkflowStore } from "./store";

type WorkflowSnapshot = Pick<ReturnType<typeof useWorkflowStore.getState>,
  "workflowOwnerId" | "spaces" | "activeSpaceId" | "nodes" | "edges" | "nodeCounters">;

/** Legacy shared-origin storage cannot prove its account. Keep an explicit
 * recovery copy before replacing it; never silently relabel it as a new owner. */
export function reconcileWorkflowOwner(owner: string, current: WorkflowSnapshot,
  storage: Pick<Storage, "getItem" | "setItem">, resetForOwner: () => void): string {
  const existing = storage.getItem("heliosgen-unclaimed-workflows") ?? "";
  if (current.workflowOwnerId === owner) return existing;
  const workflows = current.spaces.map((space) => space.id === current.activeSpaceId
    ? { ...space, nodes: current.nodes, edges: current.edges, nodeCounters: current.nodeCounters }
    : space).filter((space) => space.nodes.length || space.edges.length);
  let backup = existing;
  if (workflows.length) {
    const prior = existing ? JSON.parse(existing) as { workflows?: Space[] } : null;
    backup = JSON.stringify({ format: "heliosgen-recovery", version: 1, workflows: [...(prior?.workflows ?? []), ...workflows] });
    // If storage is full, throw before clearing any source data.
    storage.setItem("heliosgen-unclaimed-workflows", backup);
  }
  resetForOwner();
  return backup;
}

export function promoteActiveDraft(snapshot: WorkflowSnapshot, now = Date.now()): Space[] {
  return snapshot.spaces.map((space) => {
    if (space.id !== snapshot.activeSpaceId) return space;
    const nodes = snapshot.nodes;
    const edges = snapshot.edges;
    const nodeCounters = snapshot.nodeCounters;
    if (JSON.stringify([space.nodes, space.edges, space.nodeCounters]) === JSON.stringify([nodes, edges, nodeCounters])) return space;
    return { ...space, nodes, edges, nodeCounters, updatedAt: now };
  });
}

/** A complete-list save may delete records. It is forbidden until the initial
 * read and owner reconciliation have both succeeded for this mounted session. */
export class WorkflowSyncSession {
  private generation = 0;
  private owner: string | null = null;
  private revision: number | null = null;
  private saving: Promise<boolean> = Promise.resolve(false);
  constructor(private readonly fetcher: typeof appFetch = appFetch) {}

  get ready(): boolean { return this.owner !== null; }

  cancel(): void { this.generation++; this.owner = null; this.revision = null; }

  async load(merge: (owner: string, spaces: Space[]) => void): Promise<boolean> {
    this.owner = null;
    this.revision = null;
    const generation = ++this.generation;
    const response = await this.fetcher("/api/guest-spaces", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取服务器工作流，尚未开启自动保存。请重试。");
    const data = await response.json() as { userId?: unknown; spaces?: unknown; revision?: unknown };
    if (typeof data.userId !== "string" || !data.userId || !Array.isArray(data.spaces) ||
      typeof data.revision !== "number" || !Number.isSafeInteger(data.revision) || data.revision < 0) {
      throw new Error("服务器工作流响应无效，尚未开启自动保存。请重试。");
    }
    if (generation !== this.generation) return false;
    merge(data.userId, data.spaces as Space[]);
    this.owner = data.userId;
    this.revision = data.revision;
    return true;
  }

  save(spaces: Space[], keepalive = false): Promise<boolean> {
    const generation = this.generation;
    if (!this.ready) return Promise.resolve(false);
    // A mounted tab may request saves from debounce, manual sync and pagehide.
    // Serialize them so each uses the revision returned by the previous save.
    const result = this.saving.catch(() => false).then(() =>
      generation === this.generation ? this.saveNext(spaces, keepalive) : false);
    this.saving = result;
    return result;
  }

  private async saveNext(spaces: Space[], keepalive: boolean): Promise<boolean> {
    const owner = this.owner;
    if (!owner || this.revision === null) return false;
    const generation = this.generation;
    const response = await this.fetcher("/api/guest-spaces", {
      method: "PUT", headers: { "Content-Type": "application/json" }, keepalive,
      body: JSON.stringify({ expectedUserId: owner, expectedRevision: this.revision, spaces }),
    });
    if (!response.ok) {
      const error = response.status === 409 ? await response.json().catch(() => ({})) as { error?: string } : null;
      if ([401, 403, 409].includes(response.status)) this.cancel();
      throw new Error(response.status === 409
        ? error?.error === "session_changed"
          ? "登录账户已变化，已停止自动保存。请重新加载工作流。"
          : "其他窗口已更新工作流，已暂停自动保存。请重新加载并合并工作流。"
        : "工作流保存失败，请重试。");
    }
    const data = await response.json() as { revision?: unknown };
    if (generation !== this.generation) return false;
    if (typeof data.revision !== "number" || !Number.isSafeInteger(data.revision) || data.revision < 0) {
      this.cancel();
      throw new Error("工作流保存结果无效，已暂停自动保存。请重新加载工作流。");
    }
    this.revision = data.revision;
    return true;
  }
}
