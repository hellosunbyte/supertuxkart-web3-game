// DOM-level checks; these complement, and do not replace, real-browser acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { buildApp } from '../src/app.js';
import { writeSave } from '../src/saves.js';
import { testDatabase } from './database.js';
const { Wallet } = createRequire(import.meta.url)('ethers/wallet') as typeof import('ethers/wallet');
const origin = 'http://localhost:8080';
const web = new URL('../../web/', import.meta.url);
const source = (name: string) => readFile(new URL(name, web), 'utf8');
const xml = (name: string) => `<players><player name="${name}" saved-token="upstream-secret" saved-user="123" saved-session="true"/></players>`;

test('progress sanitizer removes upstream credentials and refuses malformed XML', async () => {
  const win = new Window({ url: origin });
  try {
    win.eval(await source('progress.js'));
    const sanitized = (win as any).STKProgress.payload(xml('Racer'));
    assert.doesNotMatch(sanitized.playersXml, /upstream-secret|saved-user="123"/);
    assert.match(sanitized.playersXml, /name="Racer"/);
    const selected = (win as any).STKProgress.payload('<players><current player="Anne &amp; Jo"/><player name="Other"/><player name="Anne &amp; Jo"/></players>');
    assert.equal((win as any).STKProgress.playerName(selected), 'Anne & Jo');
    assert.equal((win as any).STKProgress.playerName((win as any).STKProgress.payload('<players><player name="One"/><player name="Two"/></players>')), null);
    assert.throws(() => (win as any).STKProgress.payload('<players><broken></players>'));
    assert.throws(() => (win as any).STKProgress.payload('<!DOCTYPE players><players/>'));
  } finally { await win.happyDOM.close(); }
});

test('launcher signs in without naming, syncs game profiles, and handles conflicts', async () => {
  const db = await testDatabase();
  const app = buildApp(db, { origin, rateMax: 10000 });
  const win = new Window({ url: origin, settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableIframePageLoading: true } });
  const bridgeWindow = new Window({ url: origin });
  const wallet = Wallet.createRandom();
  let cookie = '';
  const handlers: Record<string, Function[]> = {};
  try {
    win.document.write(await source('index.html'));
    (win as any).fetch = async (path: string, options: any = {}) => {
      const response = await app.fetch(new Request(new URL(path, origin), { ...options, signal: undefined,
        headers: { ...options.headers, origin, cookie } }));
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
      return response;
    };
    (win as any).AbortSignal = AbortSignal;
    (win as any).TextEncoder = TextEncoder;
    (win as any).ethereum = {
      on(event: string, fn: Function) { (handlers[event] ??= []).push(fn); },
      removeListener(event: string, fn: Function) { handlers[event] = (handlers[event] ?? []).filter(f => f !== fn); },
      async request({ method, params }: any) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
        if (method === 'eth_chainId') return '0xaa37dc';
        if (method === 'personal_sign') return wallet.signMessage(Buffer.from(params[0].slice(2), 'hex'));
        return null;
      },
    };
    win.eval(await source('progress.js'));
    win.eval(await source('account.js'));
    await (win as any).STKAccount.ready;
    assert.equal(win.document.querySelector('#profile-form'), null);
    assert.equal(win.document.querySelector('#display-name'), null);
    const connect = win.document.querySelector('#connect-wallet') as any;
    // Event dispatch does not await an async handler. Observe its final DOM state.
    async function settled(action: () => void) {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Controller did not settle')); }, 3000);
        const observer = new win.MutationObserver(() => {
          if (!connect.disabled && win.document.querySelector('#account')?.getAttribute('data-player') !== 'guest') {
            clearTimeout(timeout); observer.disconnect(); resolve();
          }
        });
        observer.observe(win.document.querySelector('#account')!, { attributes: true, childList: true, subtree: true, characterData: true });
        action();
      });
    }
    await settled(() => connect.click());
    const id = win.document.querySelector('#account')!.getAttribute('data-player')!;
    assert.match(id, /^[a-f0-9-]{36}$/);
    const frame = win.document.createElement('iframe'); frame.id = 'game'; win.document.querySelector('#session')!.appendChild(frame);
    Object.defineProperty(frame, 'contentWindow', { value: bridgeWindow });
    let sequence = 0;
    async function rpc(action: string, data: any = {}) {
      const id = ++sequence;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No bridge response')), 3000);
        const receiver = (event: any) => {
          if (event.data?.id !== id) return;
          frame.contentWindow!.removeEventListener('message', receiver);
          clearTimeout(timer);
          if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
        };
        frame.contentWindow!.addEventListener('message', receiver);
        win.dispatchEvent(new win.MessageEvent('message', { origin, source: frame.contentWindow as any, data: { source: 'stk-cloud', id, action, ...data } }));
      });
    }
    assert.equal((await rpc('bootstrap')).player.id, id);
    assert.equal((await rpc('restore', { playerId: id, local: null })).sync, true);
    const payload = (win as any).STKProgress.payload(xml('First save'));
    assert.equal((await rpc('save', { playerId: id, payload })).synced, true);
    assert.equal((await db.query('SELECT revision FROM cloud_saves WHERE player_id = $1', [id])).rows[0].revision, 1);
    assert.equal((await db.query('SELECT display_name FROM players WHERE id = $1', [id])).rows[0].display_name, 'First save');
    const newer = (win as any).STKProgress.payload(xml('Other device'));
    await writeSave(db, id, { baseRevision: 1, payload: newer });
    assert.equal((await rpc('save', { playerId: id, payload: (win as any).STKProgress.payload(xml('Local edits')) })).synced, false);
    assert.match(win.document.querySelector('#account-status')!.textContent, /another device/);
    const dialog = win.document.querySelector('#save-conflict') as any;
    dialog.showModal = () => queueMicrotask(() => { dialog.returnValue = 'cloud'; dialog.dispatchEvent(new win.Event('close')); });
    const restored = await rpc('restore', { playerId: id, local: payload });
    assert.equal(restored.payload.playersXml, newer.playersXml);
    dialog.showModal = () => queueMicrotask(() => { dialog.returnValue = 'local'; dialog.dispatchEvent(new win.Event('close')); });
    const selectedLocal = await rpc('restore', { playerId: id, local: payload });
    assert.equal(selectedLocal.payload.playersXml, payload.playersXml);
    assert.equal((await rpc('save', { playerId: id, payload: selectedLocal.payload })).synced, true);
    assert.equal((await db.query('SELECT revision FROM cloud_saves WHERE player_id = $1', [id])).rows[0].revision, 3);
    dialog.showModal = () => queueMicrotask(() => { dialog.returnValue = 'offline'; dialog.dispatchEvent(new win.Event('close')); });
    const localOnly = (win as any).STKProgress.payload(xml('Local only'));
    assert.equal((await rpc('restore', { playerId: id, local: localOnly })).sync, false);
    assert.equal((await rpc('save', { playerId: id, payload: localOnly })).synced, false);
    assert.equal((await db.query('SELECT revision FROM cloud_saves WHERE player_id = $1', [id])).rows[0].revision, 3);
    dialog.showModal = () => queueMicrotask(() => { dialog.returnValue = 'local'; dialog.dispatchEvent(new win.Event('close')); });
    const gameProfile = (win as any).STKProgress.payload('<players><current player="Selected Racer"/><player name="Other Racer"/><player name="Selected Racer"/></players>');
    await rpc('restore', { playerId: id, local: gameProfile });
    const savedName = await rpc('save', { playerId: id, payload: gameProfile });
    assert.equal(savedName.displayName, 'Selected Racer');
    assert.equal((await db.query('SELECT display_name FROM players WHERE id = $1', [id])).rows[0].display_name, 'Selected Racer');
    // Wallet events are also subscribed after a restored session, not only after connection.
    for (const fn of handlers.accountsChanged) await fn([]);
    assert.equal(win.document.querySelector('#account')!.getAttribute('data-player'), 'guest');
  } finally { await bridgeWindow.happyDOM.close(); await win.happyDOM.close(); await db.close(); }
});

test('game bridge restores only the player file into an isolated namespace before startup', async () => {
  const win = new Window({ url: origin });
  const id = 'abcd1234-1234-4234-8234-123456789abc';
  const files: Record<string, string> = { '/persist/config/supertuxkart/config-0.10/players.xml': xml('Guest') };
  const env: Record<string, string> = {};
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const parent = { postMessage(data: any) {
    let result: any;
    if (data.action === 'bootstrap') result = { player: { id, displayName: 'Account' }, importGuest: true, items: [{ item_id: 'kart.cosmetic' }] };
    if (data.action === 'restore') result = { payload: data.local, sync: true };
    if (data.action === 'save') result = { synced: true, displayName: 'Guest' };
    queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { origin, source: parent as any, data: { source: 'stk-cloud-response', id: data.id, result } })));
  } };
  try {
    Object.defineProperty(win, 'parent', { value: parent });
    (win as any).Module = {};
    (win as any).ENV = env;
    (win as any).IDBFS = {};
    (win as any).FS = { mkdirTree() {}, mount() {}, syncfs(_populate: boolean, cb: Function) { cb(null); },
      readFile(path: string) { if (!(path in files)) throw Object.assign(new Error('Missing'), { errno: 44 }); return files[path]; },
      writeFile(path: string, text: string) { files[path] = text; },
    };
    (win as any).addRunDependency = () => {};
    (win as any).removeRunDependency = started;
    win.eval(await source('progress.js')); win.eval(await source('cloud-bridge.js')); win.eval(await source('pre.js'));
    (win as any).Module.preRun[0]();
    await ready;
    assert.equal(env.XDG_CONFIG_HOME, `/persist/accounts/${id}/config`);
    assert.match(files[`${env.XDG_CONFIG_HOME}/supertuxkart/config-0.10/players.xml`], /Guest/);
    assert.doesNotMatch(files[`${env.XDG_CONFIG_HOME}/supertuxkart/config-0.10/players.xml`], /upstream-secret/);
    assert.equal((win as any).Module.platformIdentity.id, id);
    assert.equal(Object.keys(files).some(p => p.endsWith('config.xml')), false);
    await (win as any).Module.syncSaves();
    assert.equal((win as any).Module.platformIdentity.displayName, 'Guest');
    (win as any).Module.disposeBrowserHooks();
  } finally { await win.happyDOM.close(); }
});
