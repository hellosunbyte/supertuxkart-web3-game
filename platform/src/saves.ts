import type { Database, Sql } from './db.js';
import { ApiError } from './auth.js';
import { profileInput, saveInput } from './config.js';
import { XMLParser } from 'fast-xml-parser';

export type CloudSave = { revision: number; payload: { schemaVersion: 1; playersXml: string } | null; updatedAt: string | null; displayName: string };
export async function readSave(db: Sql, playerId: string): Promise<CloudSave> {
  const row = (await db.query(`SELECT p.display_name, s.revision, s.payload, s.updated_at FROM players p
    LEFT JOIN cloud_saves s ON s.player_id = p.id WHERE p.id = $1`, [playerId])).rows[0];
  return row?.revision ? { revision: row.revision, payload: row.payload, updatedAt: new Date(row.updated_at).toISOString(), displayName: row.display_name }
    : { revision: 0, payload: null, updatedAt: null, displayName: row?.display_name ?? 'Racer' };
}
function selectedPlayerName(playersXml: string): string | null {
  // The save has already passed XML/DTD validation. Decode built-in XML entities
  // so names such as Anne &amp; Jo match the native <current player="..."/> entry.
  const root = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: false }).parse(playersXml).players;
  if (!root || typeof root !== 'object') return null;
  const profiles = (Array.isArray(root.player) ? root.player : root.player ? [root.player] : [])
    .filter((p: any) => p && typeof p === 'object' && !['true', '1'].includes(p['@_guest']));
  const current = root.current?.['@_player'];
  const selected = current ? profiles.find((p: any) => p['@_name'] === current) : profiles.length === 1 ? profiles[0] : null;
  const name = profileInput.safeParse({ displayName: selected?.['@_name'] });
  return name.success ? name.data.displayName : null;
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
    const displayName = selectedPlayerName(input.payload.playersXml);
    if (displayName) await sql.query('UPDATE players SET display_name = $1 WHERE id = $2', [displayName, playerId]);
    return readSave(sql, playerId);
  });
}
