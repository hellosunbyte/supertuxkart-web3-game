import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { buildApp } from '../src/app.js';
import { testDatabase } from './database.js';
import type { Database } from '../src/db.js';
const { Wallet } = createRequire(import.meta.url)('ethers/wallet') as typeof import('ethers/wallet');
const origin = 'http://localhost:8080';
let db: Database;
before(async () => { db = await testDatabase(); });
after(async () => { await db?.close(); });

async function harness() {
  const app = buildApp(db, { origin, rateMax: 10000 });
  const win = new Window({ url: origin, settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableIframePageLoading: true } });
  const wallets = [Wallet.createRandom(), Wallet.createRandom()];
  const state = { accounts: [wallets[0].address], unsupported: false, rejectPermissions: false, rejectSignature: false, calls: [] as string[], signedAddress: '' };
  let cookie = '';
  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await app.fetch(new Request(origin + '/api/' + path, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return response;
  }
  win.document.write(await readFile(new URL('../../web/index.html', import.meta.url), 'utf8'));
  (win as any).fetch = async (path: string, options: any = {}) => {
    const response = await app.fetch(new Request(new URL(path, origin), { ...options, signal: undefined, headers: { ...options.headers, origin, cookie } }));
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return response;
  };
  (win as any).AbortSignal = AbortSignal; (win as any).TextEncoder = TextEncoder;
  (win as any).ethereum = { on() {}, removeListener() {}, async request({ method, params }: any) {
    state.calls.push(method);
    if (method === 'wallet_requestPermissions') {
      if (state.rejectPermissions) throw Object.assign(new Error('Rejected'), { code: 4001 });
      if (state.unsupported) throw Object.assign(new Error('Unsupported'), { code: 4200 });
      return [{ parentCapability: 'eth_accounts' }];
    }
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return state.accounts;
    if (method === 'eth_chainId') return '0xaa37dc';
    if (method === 'personal_sign') {
      if (state.rejectSignature) throw Object.assign(new Error('Rejected'), { code: 4001 });
      state.signedAddress = params[1];
      const wallet = wallets.find(w => w.address.toLowerCase() === params[1].toLowerCase())!;
      return wallet.signMessage(Buffer.from(params[0].slice(2), 'hex'));
    }
    throw new Error('Unexpected wallet method ' + method);
  } };
  const dialog = win.document.querySelector('#wallet-account-dialog') as any;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = (value: string) => { dialog.returnValue = value; dialog.open = false; dialog.dispatchEvent(new win.Event('close')); };
  win.eval(await readFile(new URL('../../web/progress.js', import.meta.url), 'utf8'));
  win.eval(await readFile(new URL('../../web/account.js', import.meta.url), 'utf8'));
  await (win as any).STKAccount.ready;
  function until(check: () => boolean) {
    if (check()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Wallet UI did not settle')); }, 3000);
      const observer = new win.MutationObserver(() => { if (check()) { clearTimeout(timer); observer.disconnect(); resolve(); } });
      observer.observe(win.document, { subtree: true, attributes: true, childList: true, characterData: true });
    });
  }
  async function click(selector: string, choose?: string | 'cancel') {
    (win.document.querySelector(selector) as any).click();
    if (choose) {
      await until(() => dialog.open);
      if (choose === 'cancel') (win.document.querySelector('#wallet-account-cancel') as any).click();
      else {
        const radio = Array.from(win.document.querySelectorAll('input[name="wallet-account"]')).find((input: any) => input.value.toLowerCase() === choose.toLowerCase()) as any;
        assert.ok(radio, 'The requested account must be offered');
        radio.checked = true;
        win.document.querySelector('#wallet-account-form')!.dispatchEvent(new win.Event('submit', { cancelable: true }));
      }
    }
    await until(() => !(win as any).STKAccount.busy);
  }
  return { win, state, wallets, api, click, id: () => win.document.querySelector('#account')!.getAttribute('data-player'), status: () => win.document.querySelector('#account-status')!.textContent, close: () => win.happyDOM.close() };
}

test('reconnecting requests account selection; switching keeps progress separate and cancellation preserves the session', async () => {
  const h = await harness();
  try {
    await h.click('#connect-wallet'); const firstId = h.id();
    await h.api('progress', 'PUT', { baseRevision: 0, payload: { schemaVersion: 1, playersXml: '<players><player name="First player"/></players>' } });
    await h.click('#sign-out'); h.state.accounts = [h.wallets[1].address]; h.state.calls = [];
    await h.click('#connect-wallet'); const secondId = h.id();
    assert.notEqual(secondId, firstId);
    assert.equal(h.state.calls[0], 'wallet_requestPermissions');
    assert.equal((await (await h.api('progress')).json()).payload, null);
    h.state.accounts = h.wallets.map(w => w.address);
    await h.click('#switch-wallet', h.wallets[0].address);
    assert.equal(h.id(), firstId);
    assert.match((await (await h.api('progress')).json()).payload.playersXml, /First player/);
    await h.click('#switch-wallet', 'cancel');
    assert.equal(h.id(), firstId); assert.match(h.status(), /current player is unchanged/);
    h.state.rejectSignature = true;
    await h.click('#switch-wallet', h.wallets[1].address);
    assert.equal(h.id(), firstId); assert.match(h.status(), /current player is unchanged/);
    h.state.rejectSignature = false;
    await h.click('#connect-wallet', h.wallets[1].address);
    assert.equal(h.id(), firstId); assert.match(h.status(), /Use Switch account/);
  } finally { await h.close(); }
});

test('linking an explicitly selected non-first account signs that address and preserves the player', async () => {
  const h = await harness();
  try {
    await h.click('#connect-wallet'); const id = h.id();
    h.state.accounts = h.wallets.map(w => w.address);
    await h.click('#connect-wallet', h.wallets[1].address);
    assert.equal(h.state.signedAddress, h.wallets[1].address);
    assert.equal(h.id(), id);
    const player = (await (await h.api('session')).json()).player;
    assert.equal(player.wallets.length, 2);
    assert.match(h.status(), /same player and progress/);
    await h.click('#connect-wallet', h.wallets[1].address);
    assert.match(h.status(), /already linked/);
    assert.equal(h.id(), id);
  } finally { await h.close(); }
});

test('unsupported permission requests show shared accounts and guidance; rejected requests do not fall through', async () => {
  const h = await harness();
  try {
    h.state.unsupported = true;
    await h.click('#connect-wallet', h.wallets[0].address);
    const id = h.id(); assert.notEqual(id, 'guest');
    assert.match(h.win.document.querySelector('#wallet-account-help')!.textContent, /connected-site settings/);
    h.state.rejectPermissions = true; h.state.calls = [];
    await h.click('#switch-wallet');
    assert.deepEqual(h.state.calls, ['wallet_requestPermissions']);
    assert.equal(h.id(), id); assert.match(h.status(), /current player is unchanged/);
  } finally { await h.close(); }
});
