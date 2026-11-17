import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { buildApp } from '../src/app.js';
import { testDatabase } from './database.js';
import { installDialogHooks, waitForUI, confirmAccount } from './wallet-ui.js';
import { CHAIN } from '../src/config.js';
const { Wallet } = createRequire(import.meta.url)('ethers/wallet') as typeof import('ethers/wallet');
const origin = 'http://localhost:8080';
const web = new URL('../../web/', import.meta.url);
const source = (name: string) => readFile(new URL(name, web), 'utf8');
const metaInfo = { uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'MetaMask', rdns: 'io.metamask' };
const phantomInfo = { uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Phantom', rdns: 'app.phantom' };
const addresses = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];

function provider(flags: Record<string, boolean> = {}) {
  const calls: string[] = [];
  const state = { unsupported: false, rejected: false };
  return { ...flags, calls, state,
    async request({ method }: any) {
      calls.push(method);
      if (method === 'wallet_requestPermissions') {
        if (state.rejected) throw Object.assign(new Error('Rejected'), { code: 4001 });
        if (state.unsupported) throw Object.assign(new Error('Unsupported'), { code: 4200 });
        return [{ parentCapability: 'eth_accounts' }];
      }
      if (method === 'eth_requestAccounts') return addresses;
      throw new Error('Unexpected RPC method ' + method);
    },
  };
}
async function page() {
  const win = new Window({ url: origin, settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableIframePageLoading: true } });
  win.document.write(await source('index.html')); installDialogHooks(win);
  return win;
}
function announce(win: Window, info: any, provider: any) {
  win.dispatchEvent(new win.CustomEvent('eip6963:announceProvider', { detail: { info, provider } }));
}
function walletButton(win: Window, name: string) {
  const button = Array.from(win.document.querySelectorAll('#wallet-list button')).find(button => button.querySelector('strong')?.textContent === name) as any;
  assert.ok(button, `Expected ${name} in the wallet picker`); return button;
}

test('EIP-6963 discovers both extensions even when Phantom owns the global; only the chosen provider receives account requests', async () => {
  const win = await page(), meta = provider({ isMetaMask: true }), phantom = provider({ isMetaMask: true, isPhantom: true });
  const phantomProxy = provider({ isMetaMask: true, isPhantom: true });
  try {
    (win as any).ethereum = phantomProxy; (win as any).phantom = { ethereum: phantomProxy };
    win.addEventListener('eip6963:requestProvider', () => { announce(win, phantomInfo, phantom); announce(win, metaInfo, meta); });
    win.eval(await source('wallets.js'));
    const wallets = (win as any).STKWallets;
    const selecting = wallets.select();
    assert.equal(win.document.querySelectorAll('#wallet-list button').length, 2);
    assert.equal(walletButton(win, 'Phantom').disabled, false);
    assert.equal(walletButton(win, 'Phantom').querySelector('span').textContent, walletButton(win, 'MetaMask').querySelector('span').textContent);
    assert.deepEqual(meta.calls, []); assert.deepEqual(phantom.calls, []);
    walletButton(win, 'MetaMask').click();
    const selected = await selecting; assert.equal(selected.provider, meta);
    const account = wallets.chooseAccount(selected);
    await confirmAccount(win, addresses[1]);
    assert.equal(await account, addresses[1]);
    assert.deepEqual(meta.calls, ['wallet_requestPermissions', 'eth_requestAccounts']);
    assert.deepEqual(phantom.calls, []);
    assert.deepEqual(phantomProxy.calls, []);
  } finally { await win.happyDOM.close(); }
});

test('legacy provider arrays and the Phantom namespace are deduplicated with Phantom checked before isMetaMask', async () => {
  const win = await page(), meta = provider({ isMetaMask: true }), phantom = provider({ isPhantom: true, isMetaMask: true });
  try {
    (win as any).phantom = { ethereum: phantom };
    (win as any).ethereum = { providers: [phantom, meta, phantom] };
    win.eval(await source('wallets.js'));
    const selecting = (win as any).STKWallets.select();
    assert.equal(win.document.querySelectorAll('#wallet-list button').length, 2);
    assert.equal(walletButton(win, 'MetaMask').disabled, false);
    assert.equal(walletButton(win, 'Phantom').disabled, false);
    (win.document.getElementById('wallet-cancel') as any).click();
    assert.equal(await selecting, null);
    assert.deepEqual(meta.calls, []); assert.deepEqual(phantom.calls, []);
  } finally { await win.happyDOM.close(); }
});

test('late announcements update an open empty picker without prompts or duplicate rows', async () => {
  const win = await page(), meta = provider({ isMetaMask: true });
  try {
    win.eval(await source('wallets.js'));
    const selecting = (win as any).STKWallets.select();
    assert.equal(win.document.getElementById('wallet-empty')!.hasAttribute('hidden'), false);
    announce(win, metaInfo, meta); announce(win, metaInfo, meta);
    assert.equal(win.document.querySelectorAll('#wallet-list button').length, 1);
    assert.equal(win.document.getElementById('wallet-empty')!.hasAttribute('hidden'), true);
    walletButton(win, 'MetaMask').click();
    assert.equal((await selecting).provider, meta);
    assert.deepEqual(meta.calls, []);
  } finally { await win.happyDOM.close(); }
});

test('invalid announcements and duplicate IDs cannot replace a selected provider; names render as text', async () => {
  const win = await page(), meta = provider({ isMetaMask: true }), impostor = provider();
  try {
    win.eval(await source('wallets.js'));
    announce(win, { ...metaInfo, uuid: 'invalid' }, impostor);
    announce(win, metaInfo, meta);
    announce(win, { ...metaInfo, name: 'Impostor' }, impostor);
    const rawName = '<img src=x onerror=alert(1)>';
    announce(win, { ...phantomInfo, name: rawName, rdns: 'org.example' }, impostor);
    const selecting = (win as any).STKWallets.select();
    assert.equal(win.document.querySelectorAll('#wallet-list button').length, 2);
    assert.equal(win.document.querySelector('#wallet-list img'), null);
    assert.ok(walletButton(win, rawName));
    walletButton(win, 'MetaMask').click();
    assert.equal((await selecting).provider, meta);
  } finally { await win.happyDOM.close(); }
});

test('cancelling either step does not sign; rejecting permissions never silently falls back', async () => {
  const win = await page(), meta = provider({ isMetaMask: true });
  try {
    (win as any).ethereum = meta;
    win.eval(await source('wallets.js'));
    const wallets = (win as any).STKWallets;
    const cancelled = wallets.select(); (win.document.getElementById('wallet-cancel') as any).click();
    assert.equal(await cancelled, null); assert.deepEqual(meta.calls, []);
    const picking = wallets.select(); walletButton(win, 'MetaMask').click(); const selected = await picking;
    const account = wallets.chooseAccount(selected);
    await waitForUI(win, () => (win.document.getElementById('wallet-account-picker') as any).open);
    (win.document.getElementById('wallet-account-cancel') as any).click();
    assert.equal(await account, null);
    meta.calls.length = 0; meta.state.rejected = true;
    await assert.rejects(wallets.chooseAccount(selected), (error: any) => error.code === 4001);
    assert.deepEqual(meta.calls, ['wallet_requestPermissions']);
  } finally { await win.happyDOM.close(); }
});

test('unsupported permission methods fall back to accounts shared by that provider', async () => {
  const win = await page(), meta = provider({ isMetaMask: true });
  try {
    (win as any).ethereum = meta; meta.state.unsupported = true;
    win.eval(await source('wallets.js'));
    const selecting = (win as any).STKWallets.select(); walletButton(win, 'MetaMask').click(); const wallet = await selecting;
    const account = (win as any).STKWallets.chooseAccount(wallet);
    await confirmAccount(win, addresses[0]);
    assert.equal(await account, addresses[0]);
    assert.match(win.document.getElementById('wallet-account-help')!.textContent, /connected-site settings/);
    assert.deepEqual(meta.calls, ['wallet_requestPermissions', 'eth_requestAccounts']);
  } finally { await win.happyDOM.close(); }
});

const walletVariants = [
  { name: 'MetaMask', info: metaInfo, flags: { isMetaMask: true } },
  { name: 'Phantom', info: phantomInfo, flags: { isMetaMask: true, isPhantom: true } },
  { name: 'Example EVM Wallet', info: { uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Example EVM Wallet', rdns: 'org.example.wallet' }, flags: {} },
];
for (const variant of walletVariants) {
  test(`the same capability checks accept a compatible ${variant.name}-labelled provider`, async () => {
    const win = await page();
    const calls: string[] = [];
    let chain = '0x1', added = false;
    const selectedProvider = { ...variant.flags, async request({ method, params }: any) {
      calls.push(method);
      if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
      if (method === 'eth_requestAccounts') return addresses;
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_addEthereumChain') { added = true; return null; }
      if (method === 'wallet_switchEthereumChain') {
        if (!added) throw Object.assign(new Error('Unknown network'), { code: 4902 });
        chain = params[0].chainId; return null;
      }
      throw new Error('Unexpected method ' + method);
    } };
    try {
      win.addEventListener('eip6963:requestProvider', () => announce(win, variant.info, selectedProvider));
      win.eval(await source('wallets.js'));
      const wallets = (win as any).STKWallets;
      const picking = wallets.select();
      assert.equal(walletButton(win, variant.name).disabled, false);
      assert.deepEqual(calls, []);
      walletButton(win, variant.name).click(); const selected = await picking;
      const account = wallets.chooseAccount(selected); await confirmAccount(win, addresses[1]);
      assert.equal(await account, addresses[1]);
      await wallets.ensureNetwork(selected, CHAIN);
      assert.equal(chain, CHAIN.chainId);
      assert.equal(calls.filter(method => method === 'wallet_addEthereumChain').length, 1);
      assert.equal(calls.filter(method => method === 'wallet_switchEthereumChain').length, 2);
    } finally { await win.happyDOM.close(); }
  });
  test(`the same capability checks reject unavailable networks and preserve cancellation for ${variant.name}`, async () => {
    const win = await page(); let errorCode = 4200;
    const calls: string[] = [];
    const selectedProvider = { ...variant.flags, async request({ method }: any) {
      calls.push(method);
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_switchEthereumChain') throw Object.assign(new Error('Network request failed'), { code: errorCode });
      throw new Error('Unexpected method ' + method);
    } };
    try {
      win.addEventListener('eip6963:requestProvider', () => announce(win, variant.info, selectedProvider));
      win.eval(await source('wallets.js'));
      const wallets = (win as any).STKWallets;
      const picking = wallets.select(); walletButton(win, variant.name).click(); const selected = await picking;
      await assert.rejects(wallets.ensureNetwork(selected, CHAIN), (error: any) =>
        error.code === 'wallet_network_unavailable' && error.message.includes('OP Sepolia') && !error.message.includes(variant.name));
      assert.deepEqual(calls, ['eth_chainId', 'wallet_switchEthereumChain']);
      for (const cancellation of [4001, -32002]) {
        errorCode = cancellation; calls.length = 0;
        await assert.rejects(wallets.ensureNetwork(selected, CHAIN), (error: any) => error.code === cancellation);
        assert.deepEqual(calls, ['eth_chainId', 'wallet_switchEthereumChain']);
      }
    } finally { await win.happyDOM.close(); }
  });
}

test('real sign-in uses the chosen extension and second address, ignores the other extension, and reselects on reconnect', async () => {
  const db = await testDatabase(), app = buildApp(db, { origin, rateMax: 10000 });
  const win = await page(), keys = [Wallet.createRandom(), Wallet.createRandom()];
  const phantom = provider({ isPhantom: true, isMetaMask: true });
  const calls: string[] = [], listeners: Record<string, Function[]> = {};
  let cookie = '', chain = '0x1', rejectSignature = false;
  const meta = { isMetaMask: true,
    on(event: string, fn: Function) { (listeners[event] ??= []).push(fn); },
    removeListener(event: string, fn: Function) { listeners[event] = (listeners[event] ?? []).filter(value => value !== fn); },
    async request({ method, params }: any) {
      calls.push(method);
      if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return keys.map(key => key.address);
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
      if (method === 'personal_sign') {
        if (rejectSignature) throw Object.assign(new Error('Rejected'), { code: 4001 });
        const key = keys.find(key => key.address.toLowerCase() === params[1].toLowerCase())!;
        return key.signMessage(Buffer.from(params[0].slice(2), 'hex'));
      }
      throw new Error('Unexpected method ' + method);
    },
  };
  try {
    (win as any).ethereum = phantom; (win as any).phantom = { ethereum: phantom };
    win.addEventListener('eip6963:requestProvider', () => { announce(win, phantomInfo, phantom); announce(win, metaInfo, meta); });
    (win as any).fetch = async (path: string, options: any = {}) => {
      const response = await app.fetch(new Request(new URL(path, origin), { ...options, signal: undefined, headers: { ...options.headers, origin, cookie } }));
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
      return response;
    };
    (win as any).TextEncoder = TextEncoder; (win as any).AbortSignal = AbortSignal;
    win.eval(await source('progress.js')); win.eval(await source('wallets.js')); win.eval(await source('account.js'));
    await (win as any).STKAccount.ready;
    async function connect(index: number) {
      (win.document.getElementById('connect-wallet') as any).click();
      walletButton(win, 'MetaMask').click(); await confirmAccount(win, keys[index].address);
      await waitForUI(win, () => !(win as any).STKAccount.busy);
    }
    await connect(1);
    const id = win.document.getElementById('account')!.getAttribute('data-player');
    assert.notEqual(id, 'guest');
    assert.equal((await db.query('SELECT player_id FROM wallets WHERE address = $1', [keys[1].address.toLowerCase()])).rows[0].player_id, id);
    assert.ok(calls.includes('wallet_switchEthereumChain')); assert.ok(calls.includes('personal_sign'));
    assert.deepEqual(phantom.calls, []);
    (win.document.getElementById('connect-wallet') as any).click();
    (win.document.getElementById('wallet-cancel') as any).click();
    await waitForUI(win, () => !(win as any).STKAccount.busy);
    assert.equal(win.document.getElementById('account')!.getAttribute('data-player'), id);
    (win.document.getElementById('connect-wallet') as any).click();
    walletButton(win, 'MetaMask').click();
    await waitForUI(win, () => (win.document.getElementById('wallet-account-picker') as any).open);
    (win.document.getElementById('wallet-account-cancel') as any).click();
    await waitForUI(win, () => !(win as any).STKAccount.busy);
    assert.equal(win.document.getElementById('account')!.getAttribute('data-player'), id);
    rejectSignature = true;
    (win.document.getElementById('connect-wallet') as any).click();
    walletButton(win, 'MetaMask').click(); await confirmAccount(win, keys[0].address);
    await waitForUI(win, () => !(win as any).STKAccount.busy);
    assert.equal(win.document.getElementById('account')!.getAttribute('data-player'), id);
    assert.match(win.document.getElementById('account-status')!.textContent, /current player is unchanged/);
    rejectSignature = false;
    (win.document.getElementById('sign-out') as any).click();
    await waitForUI(win, () => !(win as any).STKAccount.busy);
    calls.length = 0;
    await connect(0);
    assert.notEqual(win.document.getElementById('account')!.getAttribute('data-player'), id);
    assert.equal(calls[0], 'wallet_requestPermissions');
    assert.deepEqual(phantom.calls, []);
  } finally { await win.happyDOM.close(); await db.close(); }
});
