import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress } from 'ethers/address';
import { verifyMessage } from 'ethers/hash';
import type { Database, Sql } from './db.js';
import { CHAIN_ID } from './config.js';

export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export class ApiError extends Error {
  constructor(public statusCode: number, public code: string) { super(code); }
}
export type Identity = { id: string; kind: 'guest' | 'registered'; display_name: string; tokenHash: string };
export async function session(db: Sql, token?: string): Promise<Identity | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = hash(token);
  const { rows } = await db.query(`SELECT p.id, p.kind, p.display_name FROM players p
    JOIN sessions s ON s.player_id = p.id WHERE s.token_hash = $1 AND s.expires_at > now()`, [tokenHash]);
  return rows[0] ? { ...rows[0], tokenHash } as Identity : null;
}
export async function issueSession(sql: Sql, playerId: string, previous?: string) {
  const token = secret();
  if (previous) await sql.query('DELETE FROM sessions WHERE token_hash = $1', [previous]);
  await sql.query(`INSERT INTO sessions(token_hash, player_id, expires_at) VALUES ($1, $2, now() + interval '7 days')`, [hash(token), playerId]);
  return token;
}
export async function guest(db: Database) {
  return db.transaction(async sql => {
    const id = randomUUID();
    await sql.query('INSERT INTO players(id) VALUES ($1)', [id]);
    return { token: await issueSession(sql, id), id };
  });
}
export async function challenge(db: Database, identity: Identity, origin: string, address: string, purpose: string) {
  if (['link', 'switch'].includes(purpose) && identity.kind !== 'registered') throw new ApiError(403, 'sign_in_first');
  if (purpose === 'login' && identity.kind === 'registered') throw new ApiError(409, 'account_changed');
  if (purpose === 'recover') throw new ApiError(409, 'recovery_not_supported');
  let checksumAddress: string;
  try { checksumAddress = getAddress(address); } catch { throw new ApiError(400, 'invalid_wallet_address'); }
  const id = randomUUID(), expires = new Date(Date.now() + 5 * 60_000);
  const statement = purpose === 'link' ? 'Link this wallet to your SuperTuxKart player account.'
    : purpose === 'switch' ? 'Switch to the SuperTuxKart player for this wallet. Your previous player keeps their progress.'
    : 'Sign in to SuperTuxKart. This does not send a transaction.';
  const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${checksumAddress}\n\n${statement}\n\nURI: ${origin}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${randomBytes(16).toString('hex')}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${expires.toISOString()}`;
  await db.transaction(async sql => {
    await sql.query('DELETE FROM challenges WHERE session_hash = $1 OR expires_at <= now()', [identity.tokenHash]);
    await sql.query(`INSERT INTO challenges(id, session_hash, address, purpose, message, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)`, [id, identity.tokenHash, address.toLowerCase(), purpose, message, expires]);
  });
  return { id, message, expiresAt: expires.toISOString() };
}
export async function verify(db: Database, identity: Identity, id: string, signature: `0x${string}`) {
  return db.transaction(async sql => {
    const { rows } = await sql.query(`SELECT c.* FROM challenges c JOIN sessions s ON s.token_hash = c.session_hash
      WHERE c.id = $1 AND c.session_hash = $2 AND c.expires_at > now() AND s.expires_at > now() FOR UPDATE OF c, s`, [id, identity.tokenHash]);
    const c = rows[0];
    if (!c) throw new ApiError(401, 'challenge_expired_or_used');
    let signer;
    try { signer = verifyMessage(c.message, signature).toLowerCase(); }
    catch { throw new ApiError(401, 'invalid_signature'); }
    if (signer !== c.address) throw new ApiError(401, 'invalid_signature');
    // Serialize association changes, including two sessions linking one address.
    await sql.query('SELECT pg_advisory_xact_lock(20831003)');
    const linked = (await sql.query('SELECT player_id FROM wallets WHERE address = $1', [c.address])).rows[0];
    if (linked && linked.player_id !== identity.id && c.purpose !== 'switch' && (c.purpose === 'link' || identity.kind === 'registered'))
      throw new ApiError(409, 'wallet_belongs_to_another_player');
    let playerId = linked?.player_id ?? identity.id;
    if (c.purpose === 'switch' && !linked) {
      playerId = randomUUID();
      await sql.query("INSERT INTO players(id, kind) VALUES ($1, 'registered')", [playerId]);
    }
    if (!linked) await sql.query('INSERT INTO wallets(address, player_id, chain_id) VALUES ($1, $2, $3)', [c.address, playerId, CHAIN_ID]);
    await sql.query("UPDATE players SET kind = 'registered' WHERE id = $1", [playerId]);
    await sql.query('DELETE FROM challenges WHERE id = $1', [id]);
    const token = await issueSession(sql, playerId, identity.tokenHash);
    return { token, playerId };
  });
}
