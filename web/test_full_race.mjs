// Let the native AI finish real laps, then verify normal shutdown and save/replay.
// Profile mode deliberately skips the human results UI; this is not a manual
// keyboard/gamepad or audible-sound acceptance test.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { launchBrowser, softwareRendering } from './browser_test_utils.mjs';

const tracks = (process.env.RACE_TRACKS || 'olivermath').split(',');
const laps = Number(process.env.RACE_LAPS || 1);
const timeout = Number(process.env.RACE_TIMEOUT_MS || 600000);
assert.ok(Number.isInteger(laps) && laps > 0, 'RACE_LAPS must be a positive integer');
assert.ok(Number.isFinite(timeout) && timeout > 0, 'RACE_TIMEOUT_MS must be positive');
assert.ok(tracks.every(track => /^[a-zA-Z0-9_-]+$/.test(track)), 'Invalid track identifier');
const artifacts = new URL('../build-web-tools/browser-test/full-race/', import.meta.url);
mkdirSync(artifacts, { recursive: true });
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.setDefaultTimeout(timeout);
const errors = [];
const failures = [];
let assetPackRequests = 0;
const report = {
  date: new Date().toISOString(), browser: browser.version(),
  renderingRequested: softwareRendering ? 'software (functional checks only)' : 'hardware (verify renderer below)',
  viewport: { width: 1200, height: 900 }, laps,
  assetDelivery: [], races: [],
};
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/supertuxkart\.data(\?|$)/.test(request.url())) assetPackRequests++; });
page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
page.on('response', response => {
  if (/supertuxkart\.(data|wasm|js)(\?|$)/.test(response.url())) {
    report.assetDelivery.push({
      url: response.url(), status: response.status(),
      contentLength: response.headers()['content-length'] || null,
      contentEncoding: response.headers()['content-encoding'] || 'identity',
    });
  }
});
let navigations = 0;
page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
try {
  const loadingStarted = performance.now();
  await page.goto(process.env.GAME_URL || 'http://localhost:8080', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('play').disabled);
  report.initialReadyMs = Math.round(performance.now() - loadingStarted);
  const initialNavigations = navigations;
  for (const track of tracks) {
    const frame = page.frames().find(frame => new URL(frame.url()).pathname.endsWith('/game.html'));
    assert.ok(frame, 'A native game session is prepared');
    await frame.evaluate(({ track, laps }) => {
      const start = window.startGame;
      window.startGame = () => start([
        `--track=${track}`, '--kart=tux', '--ai=tux', '--numkarts=2',
        `--profile-laps=${laps}`, '--race-now', '--use-keyboard=0',
      ]);
    }, { track, laps });
    const raceStarted = performance.now();
    await page.click('#play');
    await frame.waitForFunction(() => Module._browser_play_time() > 0);
    const startupMs = Math.round(performance.now() - raceStarted);
    const environment = await frame.evaluate(() => {
      const gl = Module.canvas.getContext('webgl2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const measurements = window.raceMeasurements = { frames: [], previous: null };
      function sample(now) {
        if (measurements.previous !== null) measurements.frames.push(now - measurements.previous);
        measurements.previous = now;
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
      return {
        userAgent: navigator.userAgent,
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        wasmMemoryBytes: typeof HEAPU8 !== 'undefined' ? HEAPU8.buffer.byteLength : null,
        assetCache: Object.values(Module.preloadResults || {}).map(result => result.fromCache),
        resources: performance.getEntriesByType('resource')
          .filter(entry => /supertuxkart\.(data|wasm|js)(\?|$)/.test(entry.name))
          .map(entry => ({ name: entry.name, transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize })),
      };
    });
    await frame.evaluate(value => Module.FS.writeFile('/persist/full-race-check.txt', value), track);
    await page.screenshot({ path: fileURLToPath(new URL(`${track}-racing.png`, artifacts)) });
    // Capture diagnostics while the runtime is alive. Completion is detected
    // separately from native profiling output and the launcher's real exit flow.
    await page.waitForTimeout(5000);
    const sample = await frame.evaluate(() => ({
      simulationSeconds: Module._browser_play_time(),
      frameIntervalsMs: window.raceMeasurements.frames,
      wasmMemoryBytes: typeof HEAPU8 !== 'undefined' ? HEAPU8.buffer.byteLength : null,
    }));
    assert.ok(sample.simulationSeconds > 0, 'The native simulation advances');
    const intervals = sample.frameIntervalsMs.sort((a, b) => a - b);
    const frameTiming = intervals.length ? {
      samples: intervals.length,
      medianMs: Math.round(intervals[Math.floor(intervals.length * 0.5)] * 100) / 100,
      p95Ms: Math.round(intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))] * 100) / 100,
      // These are browser animation-frame intervals, not a hardware FPS guarantee.
    } : null;
    console.log(`${track}: native race running; waiting for ${laps} complete lap(s)`);
    await page.waitForFunction(() => !document.getElementById('play').disabled &&
      document.getElementById('play').textContent === 'Play again');
    const log = await page.locator('#log').textContent();
    assert.ok(log.includes(`You chose to start in track '${track}'.`), 'The requested track was selected');
    assert.ok(log.includes(`Profiling ${laps} laps.`), 'Native profiling uses the requested lap count');
    const nativeErrors = log.split('\n').filter(line => /\[(?:error|fatal)\s*\]/.test(line));
    // The existing FreeType port cannot load the color emoji font. Preserve
    // those exact known diagnostics in the report; fail on any other native error.
    const knownFontErrors = [
      '[error  ] FontManager: Something wrong when loading a glyph! The error code was 7.',
      "[error  ] FontManager: /data/ttf/NotoColorEmoji.ttf doesn't have color, ignored.",
    ];
    assert.deepEqual(nativeErrors.filter(line => !knownFontErrors.includes(line)), [], 'No unexpected native errors');
    // Clear the log between races rather than relying on its bounded buffer's
    // previous length when checking new profiling output.
    assert.match(log, /\[[^\]]+\] profile: Number of frames:/, 'Native lap-based profiling completed');
    const finishes = [...log.matchAll(/\[[^\]]+\] profile: tux \S+ (\d+) (\d+) ([\d.]+)/g)];
    assert.equal(finishes.length, 2, 'Both native AI karts emitted finish statistics');
    assert.ok(finishes.every(finish => Number(finish[3]) > 0), 'Both karts have positive finish times');
    assert.doesNotMatch(log, /Game stopped:|Could not save progress:|Could not save the last session/);
    const next = page.frames().find(frame => new URL(frame.url()).pathname.endsWith('/game.html'));
    assert.notEqual(next, frame, 'A fresh runtime is prepared after native race completion');
    assert.equal(await next.evaluate(() => Module.FS.readFile('/persist/full-race-check.txt', { encoding: 'utf8' })), track);
    assert.equal(await next.evaluate(() => Object.values(Module.preloadResults || {}).some(result => result.fromCache)),
      true, 'Replay loads the asset pack from IndexedDB');
    assert.equal(navigations, initialNavigations, 'The launcher did not reload');
    writeFileSync(new URL(`${track}.log`, artifacts), log);
    report.races.push({ track, startupMs, completionAndReplayMs: Math.round(performance.now() - raceStarted),
      ...environment, sampledWasmMemoryBytes: sample.wasmMemoryBytes, frameTiming, knownNativeErrors: nativeErrors,
      finishes: finishes.map(finish => ({ startPosition: Number(finish[1]),
        endPosition: Number(finish[2]), finishSeconds: Number(finish[3]) })) });
    await page.screenshot({ path: fileURLToPath(new URL(`${track}-completed.png`, artifacts)) });
    await page.locator('#log').evaluate(output => { output.textContent = ''; });
    console.log(`${track}: native laps finished; saves restored and replay ready`);
  }
  const reloadingStarted = performance.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('play').disabled);
  report.cachedReloadReadyMs = Math.round(performance.now() - reloadingStarted);
  const restored = page.frames().find(frame => new URL(frame.url()).pathname.endsWith('/game.html'));
  assert.equal(await restored.evaluate(() => Object.values(Module.preloadResults || {}).some(result => result.fromCache)),
    true, 'Reloading the launcher retains the IndexedDB asset cache');
  assert.equal(await restored.evaluate(() => Module.FS.readFile('/persist/full-race-check.txt', { encoding: 'utf8' })), tracks.at(-1));
  assert.equal(assetPackRequests, 1, 'The asset pack is downloaded once across races, replays, and reload');
  report.assetPackRequests = assetPackRequests;
  console.log('Asset cache: one pack download across all sessions and launcher reload; saves preserved');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  assert.deepEqual(failures, [], 'No failed game requests');
} catch (error) {
  report.error = error.message;
  await page.screenshot({ path: fileURLToPath(new URL('failure.png', artifacts)) }).catch(() => {});
  writeFileSync(new URL('failure.log', artifacts), (await page.locator('#log').textContent().catch(() => '')) || '');
  throw error;
} finally {
  report.errors = errors;
  report.failedRequests = failures;
  writeFileSync(new URL('report.json', artifacts), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
