import { db } from "./sqlite";

export interface GuestSpace {
  id: string;
  name: string;
  nodes: unknown[];
  edges: unknown[];
  nodeCounters: Record<string, number>;
  createdAt: number;
  updatedAt?: number;
  viewport?: { x: number; y: number; zoom: number };
  isPublic?: boolean;
}

export function getSpaces(userId: string): GuestSpace[] {
  const rows = db().prepare("SELECT data FROM spaces WHERE user_id = ? ORDER BY updated_at ASC").all(userId) as {
    data: string;
  }[];
  return rows.map((row) => {
    try { return JSON.parse(row.data) as GuestSpace; }
    catch { return null; }
  }).filter((space): space is GuestSpace => space !== null);
}

function getRevision(userId: string): number {
  const row = db().prepare("SELECT revision FROM workflow_revisions WHERE user_id = ?").get(userId) as { revision: number } | undefined;
  return row?.revision ?? 0;
}

export function getSpacesSnapshot(userId: string): { spaces: GuestSpace[]; revision: number } {
  const database = db();
  database.exec("BEGIN");
  try {
    const snapshot = { revision: getRevision(userId), spaces: getSpaces(userId) };
    database.exec("COMMIT");
    return snapshot;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export class WorkflowRevisionConflict extends Error {}

export function saveSpaces(userId: string, spaces: GuestSpace[], expectedRevision?: number): number {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const revision = getRevision(userId);
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new WorkflowRevisionConflict("Workflows have changed");
    const keep = new Set(spaces.map((space) => space.id));
    const upsert = database.prepare(`
      INSERT INTO spaces (id, user_id, name, data, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at
    `);
    for (const space of spaces) {
      upsert.run(space.id, userId, space.name ?? "Untitled", JSON.stringify(space), Number(space.updatedAt ?? space.createdAt ?? Date.now()));
    }
    const existing = database.prepare("SELECT id FROM spaces WHERE user_id = ?").all(userId) as { id: string }[];
    const remove = database.prepare("DELETE FROM spaces WHERE user_id = ? AND id = ?");
    for (const { id } of existing) if (!keep.has(id)) remove.run(userId, id);
    const nextRevision = revision + 1;
    database.prepare("INSERT INTO workflow_revisions (user_id, revision) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision")
      .run(userId, nextRevision);
    database.exec("COMMIT");
    return nextRevision;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
