import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { Wallet } = createRequire(import.meta.url)('ethers/wallet') as typeof import('ethers/wallet');
import { buildApp } from '../src/app.js';
import { hash } from '../src/auth.js';
import type { Database } from '../src/db.js';
import { migrate } from '../src/db.js';
import { testDatabase } from './database.js';

let db: Database;
let app: ReturnType<typeof buildApp>;
const origin = 'http://localhost:8080';
before(async () => { db = await testDatabase(); app = buildApp(db, { origin, rateMax: 10000 }); });
after(async () => { await db?.close(); });
function browser() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
      const response = await app.fetch(new Request(origin + path, { method,
        headers: { origin, cookie, 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
      return { status: response.status, data: await response.json(), headers: response.headers };
    },
  };
}
async function signIn(client = browser(), wallet = Wallet.createRandom()) {
  await client.request('/api/guest', 'POST');
  const challenge = await client.request('/api/auth/challenge', 'POST', { address: wallet.address, chainId: 11155420 });
  assert.equal(challenge.status, 200);
  const signature = await wallet.signMessage(challenge.data.message);
  const response = await client.request('/api/auth/verify', 'POST', { id: challenge.data.id, signature });
  assert.equal(response.status, 200);
  return { client, wallet, playerId: response.data.playerId };
}
const payload = (name = 'Test racer') => ({ schemaVersion: 1, playersXml: `<players version="1"><player name="${name}" saved-token="" saved-user="0" saved-session="false" remember-password="false"/></players>` });

test('migrations can run twice without losing records', async () => {
  await migrate(db);
  assert.equal((await db.query('SELECT name FROM schema_migrations')).rows.length, 2);
});
test('guest upgrades in place, rotates cookie, and sessions are hashed', async () => {
  const client = browser();
  await client.request('/api/guest', 'POST');
  const oldCookie = client.cookie;
  const guest = (await client.request('/api/session')).data.player;
  const signed = await signIn(client);
  assert.equal(signed.playerId, guest.id);
  assert.notEqual(client.cookie, oldCookie);
  const token = client.cookie.split('=')[1];
  const rows = (await db.query('SELECT token_hash FROM sessions WHERE player_id = $1', [guest.id])).rows;
  assert.deepEqual(rows.map(r => r.token_hash), [hash(token)]);
  const profile = await client.request('/api/session');
  assert.equal(profile.data.player.kind, 'registered');
  assert.deepEqual(profile.data.player.wallets, [signed.wallet.address.toLowerCase()]);
  assert.match(profile.headers.get('cross-origin-opener-policy')!, /same-origin/);
});
test('signature challenge is bound to session, exact message, and chain', async () => {
  const alice = browser(), bob = browser(), wallet = Wallet.createRandom();
  await alice.request('/api/guest', 'POST'); await bob.request('/api/guest', 'POST');
  assert.equal((await alice.request('/api/auth/challenge', 'POST', { address: wallet.address, chainId: 10 })).status, 400);
  const c = (await alice.request('/api/auth/challenge', 'POST', { address: wallet.address, chainId: 11155420 })).data;
  assert.match(c.message, /Chain ID: 11155420/);
  assert.match(c.message, /URI: http:\/\/localhost:8080/);
  const signature = await wallet.signMessage(c.message);
  assert.equal((await bob.request('/api/auth/verify', 'POST', { id: c.id, signature })).status, 401);
  const wrongSignature = await wallet.signMessage(c.message.replace('11155420', '10'));
  assert.equal((await alice.request('/api/auth/verify', 'POST', { id: c.id, signature: wrongSignature })).status, 401);
  assert.equal((await alice.request('/api/auth/verify', 'POST', { id: c.id, signature })).status, 200);
  assert.equal((await alice.request('/api/auth/verify', 'POST', { id: c.id, signature })).status, 401);
});
test('expired challenges and sessions cannot authenticate', async () => {
  const client = browser(), wallet = Wallet.createRandom();
  await client.request('/api/guest', 'POST');
  const c = (await client.request('/api/auth/challenge', 'POST', { address: wallet.address, chainId: 11155420 })).data;
  await db.query("UPDATE challenges SET expires_at = now() - interval '1 second' WHERE id = $1", [c.id]);
  assert.equal((await client.request('/api/auth/verify', 'POST', { id: c.id, signature: await wallet.signMessage(c.message) })).status, 401);
  await db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hash(client.cookie.split('=')[1])]);
  assert.equal((await client.request('/api/session')).data.player, null);
});
test('second device resumes same player; linking cannot steal another wallet', async () => {
  const alice = await signIn(), bob = await signIn();
  const device2 = await signIn(browser(), alice.wallet);
  assert.equal(device2.playerId, alice.playerId);
  const c = (await alice.client.request('/api/auth/challenge', 'POST', { address: bob.wallet.address, chainId: 11155420, purpose: 'link' })).data;
  assert.equal((await alice.client.request('/api/auth/verify', 'POST', { id: c.id, signature: await bob.wallet.signMessage(c.message) })).status, 409);
  assert.equal((await alice.client.request('/api/session')).data.player.id, alice.playerId);
});
test('switching accounts restores an existing player and creates a separate player for a new wallet', async () => {
  const alice = await signIn(), bob = await signIn();
  await alice.client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload('Alice progress') });
  await bob.client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload('Bob progress') });
  const oldCookie = alice.client.cookie;
  const c = (await alice.client.request('/api/auth/challenge', 'POST', { address: bob.wallet.address, chainId: 11155420, purpose: 'switch' })).data;
  assert.match(c.message, /Switch to the SuperTuxKart player/);
  const switched = await alice.client.request('/api/auth/verify', 'POST', { id: c.id, signature: await bob.wallet.signMessage(c.message) });
  assert.equal(switched.data.playerId, bob.playerId);
  assert.deepEqual((await alice.client.request('/api/progress')).data.payload, payload('Bob progress'));
  assert.equal((await alice.client.request('/api/session', 'GET', undefined, { cookie: oldCookie })).data.player, null);
  const freshWallet = Wallet.createRandom();
  const next = (await alice.client.request('/api/auth/challenge', 'POST', { address: freshWallet.address, chainId: 11155420, purpose: 'switch' })).data;
  const fresh = await alice.client.request('/api/auth/verify', 'POST', { id: next.id, signature: await freshWallet.signMessage(next.message) });
  assert.notEqual(fresh.data.playerId, alice.playerId); assert.notEqual(fresh.data.playerId, bob.playerId);
  assert.equal((await alice.client.request('/api/progress')).data.payload, null);
  const resumedAlice = await signIn(browser(), alice.wallet);
  assert.equal(resumedAlice.playerId, alice.playerId);
  assert.deepEqual((await resumedAlice.client.request('/api/progress')).data.payload, payload('Alice progress'));
});
test('failed account-switch proof preserves the current session and does not link the new wallet', async () => {
  const alice = await signIn(), next = Wallet.createRandom(), wrong = Wallet.createRandom();
  const cookie = alice.client.cookie;
  const c = (await alice.client.request('/api/auth/challenge', 'POST', { address: next.address, chainId: 11155420, purpose: 'switch' })).data;
  assert.equal((await alice.client.request('/api/auth/verify', 'POST', { id: c.id, signature: await wrong.signMessage(c.message) })).status, 401);
  assert.equal(alice.client.cookie, cookie);
  assert.equal((await alice.client.request('/api/session')).data.player.id, alice.playerId);
  assert.equal((await db.query('SELECT address FROM wallets WHERE address = $1', [next.address.toLowerCase()])).rows.length, 0);
  assert.equal((await alice.client.request('/api/auth/challenge', 'POST', { address: next.address, chainId: 11155420, purpose: 'login' })).data.error, 'account_changed');
  const guest = browser(); await guest.request('/api/guest', 'POST');
  assert.equal((await guest.request('/api/auth/challenge', 'POST', { address: next.address, chainId: 11155420, purpose: 'switch' })).status, 403);
});
test('profiles are isolated; logout revokes the server session', async () => {
  const alice = await signIn(), bob = await signIn();
  assert.equal((await alice.client.request('/api/profile', 'PATCH', { displayName: 'Alice' })).status, 200);
  assert.equal((await bob.client.request('/api/session')).data.player.displayName, 'Racer');
  const oldCookie = alice.client.cookie;
  await alice.client.request('/api/logout', 'POST');
  assert.equal((await alice.client.request('/api/profile', 'PATCH', { displayName: 'Changed' }, { cookie: oldCookie })).status, 401);
});
test('a new wallet links to the same stable player without moving cloud progress', async () => {
  const alice = await signIn(), next = Wallet.createRandom();
  await alice.client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload('Original progress') });
  const c = (await alice.client.request('/api/auth/challenge', 'POST', { address: next.address, chainId: 11155420, purpose: 'link' })).data;
  const response = await alice.client.request('/api/auth/verify', 'POST', { id: c.id, signature: await next.signMessage(c.message) });
  assert.equal(response.data.playerId, alice.playerId);
  const resumed = await signIn(browser(), next);
  assert.equal(resumed.playerId, alice.playerId);
  assert.deepEqual((await resumed.client.request('/api/progress')).data.payload, payload('Original progress'));
  assert.equal((await resumed.client.request('/api/session')).data.player.wallets.length, 2);
  assert.equal((await resumed.client.request('/api/config')).data.recovery, 'disabled');
  assert.equal((await resumed.client.request('/api/auth/challenge', 'POST', { address: next.address, chainId: 11155420, purpose: 'recover' })).data.error, 'recovery_not_supported');
});
test('progress persists across sessions, rejects stale updates and arbitrary inventory', async () => {
  const alice = await signIn(), bob = await signIn();
  const first = await alice.client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload() });
  assert.equal(first.status, 200); assert.equal(first.data.revision, 1);
  const device2 = await signIn(browser(), alice.wallet);
  assert.deepEqual((await device2.client.request('/api/progress')).data.payload, payload());
  const conflict = await device2.client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload('Other device') });
  assert.equal(conflict.status, 409); assert.deepEqual(conflict.data.current.payload, payload());
  assert.equal((await bob.client.request('/api/progress')).data.payload, null);
  assert.equal((await alice.client.request('/api/progress', 'PUT', { baseRevision: 1, payload: { ...payload(), inventory: ['paid-kart'] } })).status, 400);
  assert.deepEqual((await alice.client.request('/api/inventory')).data.items, []);
});
test('concurrent first writes cannot both succeed', async () => {
  const { client } = await signIn();
  const result = await Promise.all([client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload('One') }), client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload('Two') })]);
  assert.deepEqual(result.map(r => r.status).sort(), [200, 409]);
});
test('in-game selected names sync with progress; conflicts cannot rename the account', async () => {
  const { client } = await signIn();
  const cases = [
    { playersXml: '<players><current player="Selected"/><player name="First"/><player name="Selected"/></players>', expected: 'Selected' },
    { playersXml: '<players><current player="Anne &amp; Jo"/><player name="Other"/><player name="Anne &amp; Jo"/></players>', expected: 'Anne & Jo' },
    { playersXml: '<players><player name="First"/><player name="Second"/></players>', expected: 'Anne & Jo' },
    { playersXml: '<players><current player="Missing"/><player name="Unselected"/></players>', expected: 'Anne & Jo' },
    { playersXml: '<players><current player="Guest"/><player guest="true" name="Guest"/></players>', expected: 'Anne & Jo' },
    { playersXml: '<players/>', expected: 'Anne & Jo' },
    { playersXml: '<players><player name="Solo Racer"/></players>', expected: 'Solo Racer' },
  ];
  for (const [revision, entry] of cases.entries()) {
    const saved = await client.request('/api/progress', 'PUT', { baseRevision: revision, payload: { schemaVersion: 1, playersXml: entry.playersXml } });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.displayName, entry.expected);
    assert.equal((await client.request('/api/session')).data.player.displayName, entry.expected);
  }
  const stale = await client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload('Stale name') });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.current.displayName, 'Solo Racer');
  assert.equal((await client.request('/api/session')).data.player.displayName, 'Solo Racer');
});
test('a stale tab cannot read or write progress after the browser switches accounts', async () => {
  const alice = await signIn(), bob = await signIn();
  const stale = { 'x-stk-player': alice.playerId };
  assert.equal((await bob.client.request('/api/progress', 'PUT', { baseRevision: 0, payload: payload('Wrong account') }, stale)).status, 409);
  assert.equal((await bob.client.request('/api/progress', 'GET', undefined, stale)).status, 409);
  assert.equal((await bob.client.request('/api/logout', 'POST', undefined, stale)).status, 409);
  assert.equal((await bob.client.request('/api/progress')).data.payload, null);
  assert.equal((await bob.client.request('/api/session')).data.player.id, bob.playerId);
});
test('malformed saves, upstream credentials, and unauthenticated uploads are rejected', async () => {
  const { client } = await signIn();
  for (const playersXml of ['<not-players/>', '<players/><other/>', '<players/><players/>', '<players><broken></players>', '<!DOCTYPE players><players></players>', '<players><player saved-token="secret"/></players>', '<players><player saved-user="123"/></players>']) {
    assert.equal((await client.request('/api/progress', 'PUT', { baseRevision: 0, payload: { schemaVersion: 1, playersXml } })).status, 400);
  }
  assert.equal((await browser().request('/api/progress', 'PUT', { baseRevision: 0, payload: payload() })).status, 401);
  assert.equal((await client.request('/api/progress', 'PUT', { baseRevision: 0, payload: { schemaVersion: 1, playersXml: '<players/>' } })).status, 200);
});
test('foreign origins/hosts, oversized bodies, and private files are rejected', async () => {
  assert.equal((await browser().request('/api/guest', 'POST', {}, { origin: 'https://attacker.example' })).status, 403);
  const foreign = await app.fetch(new Request('https://attacker.example/api/session'));
  assert.equal(foreign.status, 403);
  assert.equal((await browser().request('/api/auth/challenge', 'POST', { pad: 'x'.repeat(1_100_001) })).status, 413);
  assert.equal((await app.fetch(new Request(origin + '/platform/.env'))).status, 404);
});
test('HTTPS sessions use Secure host-only cookies and API throttles writes', async () => {
  const secure = buildApp(db, { origin: 'https://game.example', rateMax: 1 });
  const req = () => new Request('https://game.example/api/guest', { method: 'POST', headers: { origin: 'https://game.example' } });
  const first = await secure.fetch(req());
  assert.match(first.headers.get('set-cookie')!, /^__Host-stk_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800; Secure$/);
  assert.equal((await secure.fetch(req())).status, 429);
});
