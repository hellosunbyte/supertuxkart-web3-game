# Browser port verification

The initial browser-port milestone was tested on 2026-11-15 using Emscripten
**4.0.10**, CMake/Ninja, and
headless Chrome **157.0.8103.51** on macOS. Chrome used SwiftShader for the
automated rendering checks; this does not establish hardware-GPU performance.

## Checks completed

- Compiled and linked the actual C++ game and bundled engine libraries to Wasm.
- Served the generated build at `http://localhost:8080` with the isolation headers.
- Launched through the page's Play button and rendered the Create User screen.
- Created an offline `web_user` profile and reached the player Login screen.
- Reloaded the page and confirmed restoration of the seven generated profile,
  configuration, input, highscore, avatar, and log files from IndexedDB.
- Started Oliver's Math Class with Tux through the game's quick-race options.
- Rendered an active race, held Arrow Up for six seconds, and observed the kart
  move along the track.
- Pressed Escape and rendered the pause menu.
- Passed the HTTP integration test for `.wasm` MIME type and COOP/COEP headers.
- Confirmed that native diagnostic messages reach the page's expandable game log.

## Quit and replay regression

`node web/test_replay.mjs` passed three consecutive native game startups and
quits in one launcher page. The second session entered fullscreen before quitting.
Each quit exited fullscreen, hid the terminated game, and enabled **Play again**
after preparing a fresh runtime. The launcher did not navigate or reload, and
there were no uncaught browser errors. A filesystem write made immediately before
each quit was restored in the following session, checking the final save flush.

The test clicks the actual Exit Game button on the Create User screen in a fresh
browser context; it does not simulate the runtime's quit callback. This check
complements the earlier race-driving/pause checks and does not cover every route
to quit, browser crashes, or forcibly closing the tab.

The local test media was the official **1.5-rc1 low-quality mobile pack**, merged
with this repository's data. Its checksum is recorded in [README.md](README.md).

## Quit during active play

The visible in-game controls were additionally tested with
`node web/test_quit_during_play.mjs` on an unfinished Oliver's Math Class race
and an unfinished Battle Island battle, both in fullscreen. The test opens the
native pause menu, cancels quit from that paused state, resumes play, opens quit
during live gameplay, cancels with Escape, then confirms quit. Race clock checks
verify pause/resume behavior; both modes save a last-minute filesystem write,
exit fullscreen, and return to Play again without reloading. No uncaught browser
errors were observed. Other activity types were not individually exercised.

## Limits of the initial milestone checks

This verifies startup, rendering, basic driving, pausing, and persistent browser
storage. It does not certify every track/game mode, finishing a full race,
gamepad input, audible sound, mobile browsers, or other browsers. The original
native targets were not rebuilt or run during this work.

The initial browser target intentionally excludes online gameplay, add-on
downloads, native recording, and Web3 integration. Chrome emitted WebGL
performance warnings under software rendering; no frame-rate guarantee is made.
The game also logs legacy-renderer/version warnings and skips the color emoji
font with this FreeType port. The tested menu text renders, but color emoji
support remains a limitation of this build.

## Phase 1 hardening: 2026-11-16

The Phase 1 implementation milestone was completed on `feat/browser-phase-1`
from `dev` and accepted on 2026-11-16. The following additional checks
use Chrome **157.0.8103.51** on macOS with the same Emscripten **4.0.10** toolchain
and LQ test assets. These extend the initial milestone's coverage above.

### Native race completion and hardware baseline

`RACE_TRACKS=olivermath,lighthouse RACE_LAPS=3 node web/test_full_race.mjs`
completed three real laps with two native AI karts on both tracks under SwiftShader.
Both karts emitted positive finish times. Each race exited through normal native
shutdown, restored a last-minute save in a fresh runtime, and returned to Play again
without reloading the launcher. No uncaught browser errors or failed requests
were observed.

A separate visible-Chrome run with `BROWSER_GPU=hardware BROWSER_HEADLESS=0`
completed one lap on both tracks. The reported renderer was **ANGLE Metal Renderer:
Apple M4 Pro**, confirming that this run used the machine's GPU.

The pre-cache hardware baseline measured:

| Measurement | Oliver's Math Class | Lighthouse |
| --- | --- | --- |
| Play click to active simulation | 1.30 s | 0.87 s |
| Sampled Wasm linear-memory allocation | 512 MiB | 512 MiB |
| Median browser animation-frame interval | 16.67 ms | 24.99 ms |
| 95th-percentile interval | 25.00 ms | 33.34 ms |

Intervals were sampled during the opening seconds, not the complete race, and
are not guaranteed game FPS. Wasm linear memory excludes other browser, asset,
and GPU allocations. Localhost timings do not measure public-internet loading.
Native profiling's "Average FPS" counts simulation updates rather than rendered
frames and must not be used as a render-rate benchmark.

The existing uncompressed bundle contains **209,560,259 bytes** of assets
(199.85 MiB), **12,413,581 bytes** of Wasm (11.84 MiB), and **809,904 bytes** of
JavaScript before adding the asset-cache loader. Baseline resource timings showed
the asset pack being transferred again for fresh game sessions.

Profiling mode drives the karts using native AI and skips the human results UI.
It does not verify a human-driven race, results-screen actions, highscore/progression
updates, audible sound, or a physical gamepad. The two previously documented
color-emoji font errors are retained in measurement reports as known limitations;
the full-race check rejects other native error/fatal messages.

### Compatibility and session regressions

- Missing isolation headers, WebAssembly, shared memory, or WebGL 2 now produce
  actionable launcher messages before the game iframe/assets are requested.
- Missing JavaScript, Wasm, and data responses now produce a terminal startup
  error and dispose of the failed iframe. No repeated runtime initialization was
  observed, and later download progress cannot overwrite the startup error.
- The existing three-cycle quit/replay check and active race/battle pause,
  cancel/confirm quit, fullscreen exit, and save checks passed again.

### Versioned asset cache

After enabling Emscripten's `--use-preload-cache`, `python3 web/build.py` completed
a fresh Wasm build in this worktree. All four browser regression scripts and the
HTTP integration test passed against that rebuilt output.

The final full-race check completed one AI-driven lap on Oliver's Math Class,
then verified replay readiness, a launcher page reload, and saved-file restoration.
The **209,560,259-byte asset pack was requested exactly once** across that cold
load, replay preparation, and page reload. Emscripten's `preloadResults` confirmed
that the subsequent runtimes loaded the pack from IndexedDB. The cache uses the
pack's version/hash; it is separate from the player-save filesystem.

The startup regression additionally disabled only the asset-cache database and
confirmed that the normal download fallback reached Play. This does not establish
that all player-save storage failures are recoverable. Cached assets can be evicted
or removed by the browser, and the initial download remains large.

Current local artifacts are in ignored `build-web-tools/browser-test/`: the
`full-race/report.json` records the final cache check; `software-report.json` and
`hardware-baseline-report.json` in that same directory record the earlier three-lap
software and one-lap hardware baselines. Screenshots/logs use track filenames and
are overwritten by later runs. Summary evidence is retained here because generated
artifacts are not committed.

### Browser acceptance status

| Environment | Current evidence | Remaining acceptance work |
| --- | --- | --- |
| Desktop Chrome on macOS | Automated startup, AI race completion, saves, pause/quit/replay; software and Apple M4 Pro GPU rendering | Human results/progression, audible sound, physical gamepad, longer performance runs |
| Desktop Chrome/Edge on Windows or Linux | Not verified in this work | Functional and hardware measurements |
| Desktop Firefox and Safari | Not verified in this work | Functional, threading/storage, and hardware measurements |
| Mobile browsers | Not verified; touch controls are outside the initial desktop target | Separate device/input scope and performance work |

Phase 1 is closed for its accepted implementation scope: startup hardening,
versioned asset caching, native AI race checks, and a documented hardware baseline.
The remaining acceptance work above, public HTTPS deployment, and external-network
loading tests are release-validation follow-ups. They have not been marked as
tested, and this milestone does not establish full desktop parity.

## Reproduce the local run

```sh
python3 web/build.py
python3 web/serve.py
```

Open `http://localhost:8080`, click Play, create an offline player if needed,
confirm the player, and choose Single Player. Build output and test screenshots
are generated locally and remain ignored by Git.
