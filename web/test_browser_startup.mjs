// Unsupported browsers should get an actionable error before the large download.
// Real missing build files must stop initialization without a retry loop.
import assert from 'node:assert/strict';
import { launchBrowser } from './browser_test_utils.mjs';

const browser = await launchBrowser();
const url = process.env.GAME_URL || 'http://localhost:8080';
try {
  for (const scenario of ['isolation', 'wasm', 'shared-memory', 'webgl2']) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const gameRequests = [];
      page.on('request', request => {
        if (/\/(game\.html|supertuxkart\.)/.test(request.url())) gameRequests.push(request.url());
      });
      if (scenario === 'isolation') {
        await page.route('**/*', async route => {
          const response = await route.fetch();
          const headers = { ...response.headers() };
          delete headers['cross-origin-opener-policy'];
          delete headers['cross-origin-embedder-policy'];
          await route.fulfill({ response, headers });
        });
      } else {
        await page.addInitScript(scenario => {
          if (scenario === 'wasm') window.WebAssembly = undefined;
          if (scenario === 'shared-memory') window.SharedArrayBuffer = undefined;
          if (scenario === 'webgl2') {
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
              return type === 'webgl2' ? null : getContext.call(this, type, ...args);
            };
          }
        }, scenario);
      }
      await page.goto(url, { waitUntil: 'load' });
      const message = await page.locator('#status').textContent();
      const expected = {
        isolation: /browser isolation settings are missing/,
        wasm: /cannot run WebAssembly games/,
        'shared-memory': /cannot run the game’s shared-memory features/,
        webgl2: /WebGL 2 is unavailable/,
      };
      assert.match(message, expected[scenario]);
      assert.equal(await page.locator('#play').isDisabled(), true);
      assert.deepEqual(gameRequests, [], 'An unsupported browser must not download the game');
      console.log(`${scenario}: actionable error shown; no game assets requested`);
    } finally {
      await context.close();
    }
  }

  for (const extension of ['js', 'wasm', 'data']) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      const diagnostics = [];
      page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
      page.on('pageerror', error => diagnostics.push(error.message));
      let sessions = 0;
      page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/game.html')) sessions++; });
      await page.route(`**/supertuxkart.${extension}`, route => route.fulfill({ status: 404, body: 'Missing build artifact' }));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Could not load the game.'))
        .catch(async error => {
          throw new Error(`${error.message}\nStatus: ${await page.locator('#status').textContent()}\n${diagnostics.join('\n')}`);
        });
      await page.waitForTimeout(2000);
      assert.equal(sessions, 1, 'Initialization failure must not repeatedly recreate the runtime');
      assert.equal(await page.locator('#game').count(), 0, 'The failed runtime is disposed');
      assert.equal(await page.locator('#play').isDisabled(), true);
      assert.equal(await page.locator('#fullscreen').isDisabled(), true);
      console.log(`Missing ${extension}: error shown, failed runtime disposed, no automatic retry loop`);
    } finally {
      await context.close();
    }
  }

  const context = await browser.newContext();
  try {
    // Disable only the asset cache; player-save IndexedDB must still work.
    await context.addInitScript(() => {
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, ...args) {
        if (name === 'EM_PRELOAD_CACHE') throw new DOMException('Asset caching disabled for this check', 'SecurityError');
        return open.call(this, name, ...args);
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    let assetRequests = 0;
    page.on('request', request => { if (/supertuxkart\.data(\?|$)/.test(request.url())) assetRequests++; });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('play').disabled);
    assert.equal(assetRequests, 1, 'Unavailable asset storage falls back to one download');
    const frame = page.frames().find(frame => new URL(frame.url()).pathname.endsWith('/game.html'));
    assert.deepEqual(await frame.evaluate(() => Object.values(Module.preloadResults || {}).map(result => result.fromCache)), []);
    console.log('Asset cache unavailable: download fallback reaches Play');
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
