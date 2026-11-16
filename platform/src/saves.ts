import type { Database, Sql } from './db.js';
import { ApiError } from './auth.js';
import { saveInput } from './config.js';

export type CloudSave = { revision: number; payload: { schemaVersion: 1; playersXml: string } | null; updatedAt: string | null };
export async function readSave(db: Sql, playerId: string): Promise<CloudSave> {
  const row = (await db.query('SELECT revision, payload, updated_at FROM cloud_saves WHERE player_id = $1', [playerId])).rows[0];
  return row ? { revision: row.revision, payload: row.payload, updatedAt: new Date(row.updated_at).toISOString() } : { revision: 0, payload: null, updatedAt: null };
}
export class SaveConflict extends ApiError {
  constructor(public current: CloudSave) { super(409, 'save_conflict'); }
}
export async function writeSave(db: Database, playerId: string, body: unknown) {
  const input = saveInput.parse(body);
  return db.transaction(async sql => {
    // Lock the parent even before the first cloud-save row exists.
    await sql.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    const current = await readSave(sql, playerId);
    if (current.revision !== input.baseRevision) throw new SaveConflict(current);
    await sql.query(`INSERT INTO cloud_saves(player_id, revision, payload) VALUES ($1, 1, $2)
      ON CONFLICT(player_id) DO UPDATE SET revision = cloud_saves.revision + 1, payload = $2, updated_at = now()`, [playerId, JSON.stringify(input.payload)]);
    return readSave(sql, playerId);
  });
}
