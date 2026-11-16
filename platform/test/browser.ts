// Real Chromium + real API/SQL/signatures, with a small simulated Wasm filesystem.
// This suite does not claim native racing or extension-wallet acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
const { Wallet } = createRequire(import.meta.url)('ethers/wallet') as typeof import('ethers/wallet');
import { buildApp } from '../src/app.js';
import { testDatabase } from './database.js';

const origin = 'http://localhost:8080';
await mkdir('test-results', { recursive: true });
const db = await testDatabase();
const app = buildApp(db, { origin, rateMax: 10000 });
const wallet = Wallet.createRandom();
const pre = await readFile(new URL('../../web/pre.js', import.meta.url), 'utf8');
const fixture = `
var ENV = {}, IDBFS = {};
var files = {};
var FS = {
  mkdirTree() {}, mount() {},
  readFile(path) { if (!(path in files)) { const e = new Error('Not found'); e.errno = 44; throw e; } return files[path]; },
  writeFile(path, text) { files[path] = text; },
  syncfs(populate, cb) { if (populate) files = JSON.parse(localStorage.getItem('test-files') || '{}'); else localStorage.setItem('test-files', JSON.stringify(files)); queueMicrotask(() => cb(null)); }
};
Module.FS = FS;
Module.callMain = () => {};
Module._browser_can_pause = () => 1;
Module._browser_pause_menu = () => {};
Module._browser_prepare_quit = () => {};
Module._browser_cancel_quit = () => {};
Module._browser_quit_game = () => Module.onExit();
function addRunDependency() {}
function removeRunDependency() { queueMicrotask(() => Module.onRuntimeInitialized()); }
${pre}
Module.preRun.forEach(fn => fn());
`;
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const contexts: BrowserContext[] = [];
const errors: string[] = [];
async function device(offline = false) {
  const context = await browser.newContext(); contexts.push(context);
  await context.exposeFunction('testSign', (message: string) => wallet.signMessage(Buffer.from(message.slice(2), 'hex')));
  await context.addInitScript(({ address }) => {
    const callbacks: Record<string, Function[]> = {};
    (window as any).ethereum = {
      on(event: string, fn: Function) { (callbacks[event] ??= []).push(fn); },
      removeListener(event: string, fn: Function) { callbacks[event] = (callbacks[event] ?? []).filter(f => f !== fn); },
      emit(event: string) { for (const fn of callbacks[event] ?? []) fn([]); },
      async request({ method, params }: any) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
        if (method === 'eth_chainId') return '0xaa37dc';
        if (method === 'personal_sign') {
          if ((window as any).rejectSignature) throw Object.assign(new Error('Rejected'), { code: 4001 });
          return (window as any).testSign(params[0]);
        }
        return null;
      },
    };
  }, { address: wallet.address });
  await context.route(origin + '/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/supertuxkart.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: fixture });
    if (offline && url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    const response = await app.fetch(new Request(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined }));
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => !(document.getElementById('play') as HTMLButtonElement).disabled);
  return page;
}
async function connected(page: Page) {
  await page.click('#connect-wallet');
  await page.waitForFunction(() => document.getElementById('account')?.dataset.player !== 'guest');
  await page.waitForFunction(() => !(document.getElementById('play') as HTMLButtonElement).disabled);
  return page.frames().find(f => f.url().endsWith('/game.html'))!;
}
async function writeProgress(page: Page, name: string) {
  const frame = page.frames().find(f => f.url().endsWith('/game.html'))!;
  await frame.evaluate(async name => {
    const win = window as any;
    const root = win.ENV.XDG_CONFIG_HOME;
    win.Module.FS.writeFile(root + '/supertuxkart/config-0.10/players.xml', `<players><player name="${name}" saved-token="upstream-secret" saved-user="123" saved-session="true"/></players>`);
    await win.Module.syncSaves();
  }, name);
}
try {
  const page = await device();
  assert.match(await page.textContent('#account-status') ?? '', /guest/);
  const frame = await connected(page);
  const id = await page.getAttribute('#account', 'data-player');
  assert.match(id!, /^[a-f0-9-]{36}$/);
  assert.equal(await frame.evaluate(() => (window as any).ENV.XDG_CONFIG_HOME), `/persist/accounts/${id}/config`);
  await page.fill('#display-name', 'Cloud Racer'); await page.click('#profile-form button');
  await page.waitForFunction(() => document.getElementById('account-status')?.textContent === 'Profile saved.');
  assert.equal((await db.query('SELECT display_name FROM players WHERE id = $1', [id])).rows[0].display_name, 'Cloud Racer');
  await writeProgress(page, 'First device');
  const cloud = (await db.query('SELECT payload FROM cloud_saves WHERE player_id = $1', [id])).rows[0].payload;
  assert.match(cloud.playersXml, /First device/); assert.doesNotMatch(cloud.playersXml, /upstream-secret/);
  const second = await device();
  const restored = await connected(second);
  assert.equal(await second.getAttribute('#account', 'data-player'), id);
  assert.match(await restored.evaluate(() => (window as any).Module.FS.readFile((window as any).ENV.XDG_CONFIG_HOME + '/supertuxkart/config-0.10/players.xml')), /First device/);
  await writeProgress(second, 'Second device');
  await writeProgress(page, 'Unsynced first device');
  assert.match(await page.textContent('#account-status') ?? '', /another device/);
  await page.reload();
  await page.waitForSelector('#save-conflict[open]');
  await page.click('#save-conflict button[value=cloud]');
  await page.waitForFunction(() => !(document.getElementById('play') as HTMLButtonElement).disabled);
  const current = page.frames().find(f => f.url().endsWith('/game.html'))!;
  assert.match(await current.evaluate(() => (window as any).Module.FS.readFile((window as any).ENV.XDG_CONFIG_HOME + '/supertuxkart/config-0.10/players.xml')), /Second device/);
  await page.evaluate(() => (window as any).ethereum.emit('accountsChanged'));
  await page.waitForFunction(() => document.getElementById('account')?.dataset.player === 'guest');
  const offline = await device(true);
  assert.match(await offline.textContent('#account-status') ?? '', /Guest play is available/);
  await offline.screenshot({ path: 'test-results/guest-offline.png' });
  await page.evaluate(() => { (window as any).rejectSignature = true; });
  await page.click('#connect-wallet');
  await page.waitForFunction(() => document.getElementById('account-status')?.textContent?.includes('cancelled'));
  assert.equal(await page.getAttribute('#account', 'data-player'), 'guest');
  assert.deepEqual(errors, []);
  console.log('Browser integration passed: sign-in, namespace isolation, profile edit, cloud restore, conflict selection, wallet change, rejection, offline guest.');
} finally {
  for (const context of contexts) await context.close();
  await browser.close(); await db.close();
}
