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

export function saveSpaces(userId: string, spaces: GuestSpace[]): void {
  const database = db();
  database.exec("BEGIN");
  try {
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
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
