# SuperTuxKart browser Web3 implementation plan

Created: 2026-11-16

This is a local planning document, kept untracked and uncommitted.
Estimates are preliminary and should be updated after the networking spike.

## Goal and scope

Turn the existing C++/WebAssembly browser port into a reliable online racing
product with wallet-linked accounts, verified results, and a small set of
on-chain ownership or reward features.

The initial public beta should support desktop browsers, a limited set of tested
tracks and karts, multiplayer racing, and cosmetic ownership/rewards. Full desktop
parity, broad mobile support, a marketplace, a token economy, and paid tournaments
are separate scope decisions, not requirements for this beta.

## Current baseline

The browser-port milestone is complete for its documented offline scope:

- The actual C++ game and engine compile to WebAssembly.
- Browser startup, rendering, basic driving, pause/quit, replay without a page
  reload, and persistent browser saves have been verified.
- Local build, asset preparation, serving, and browser regression tools exist.

Phase 1 additionally verified native AI race completion on two tracks, an Apple
M4 Pro rendering baseline, startup failure handling, and versioned asset caching.
Human results/progression, audible sound, physical gamepad input, broader content
and browser coverage, and public HTTPS hosting remain release-validation follow-ups.
Online gameplay and Web3 integration are outside the completed scope.

Evidence: [browser guide](web/README.md),
[verification record](web/VERIFICATION.md), and
[browser build configuration](cmake/WebBrowser.cmake).
The verification record distinguishes automated AI races from manual gameplay
acceptance and records the limitations of the hardware measurements.

## Architecture principles

- Keep racing, physics, and real-time synchronization off-chain.
- Reuse existing STK server and networking functionality where practical, while
  implementing and measuring a browser-compatible transport.
- Establish trusted race results before issuing rewards. Wallet signatures prove
  account control, not that a race result is legitimate.
- Put selected ownership and reward settlement on-chain. Begin on a testnet with
  cosmetics or collectibles and a small contract surface.
- Retain guest play and define account linking so connecting a wallet does not
  discard an existing player profile.
- Test wallet flows together with the threaded game's cross-origin isolation
  requirements early.

## Database and persistence plan

**Current static deployment: no server database is required.** The VPS serves
the browser build, and IndexedDB stores profiles, settings, and progress locally.
Those saves belong to a specific browser and origin, do not automatically sync
between devices, and can be lost when browser storage is cleared.

**PostgreSQL was introduced in Phase 2** with the account/backend services. The backend
accesses the database; the browser and game clients communicate with authenticated
APIs rather than connecting to PostgreSQL directly.

| Feature | Persistent server data | Phase |
| --- | --- | --- |
| Wallet-linked accounts | Player profiles and verified wallet associations | 2 |
| Cloud saves | Versioned progress and save conflict metadata | 2 |
| Multiplayer history | Race sessions and participants | 3–4 |
| Leaderboards | Validated race results and rankings | 4 |
| Rewards | Eligibility, unique claim records, and transaction status | 5 |
| Inventory | Item metadata and indexed on-chain ownership | 5 |

The blockchain is authoritative for selected on-chain ownership and settlement;
PostgreSQL stores application data and a reconciled view of relevant chain events.
Local saves and client-submitted results cannot authorize competitive rewards.
Real-time physics and per-frame synchronization stay in the game-server runtime,
outside the database write path.

Add schema migrations and appropriate uniqueness constraints as each feature is
implemented, including duplicate-claim prevention. Establish database backups and
verify restoration before the public beta. Database work is part of the existing
phase estimates; revise those estimates after implementation design and the
networking spike.

## Phase 1: Harden the browser game

**Status: Done — implementation milestone accepted on 2026-11-16.**

Original estimated effort: **2–4 engineer-weeks**.

Started **2026-11-16** on branch `feat/browser-phase-1`, based on `dev`.
Progress is documented in [browser verification](web/VERIFICATION.md).

- [x] Add pre-download browser compatibility checks and startup-failure handling.
- [x] Add native AI lap-completion regression coverage and measurement reports.
- [x] Verify three AI-driven laps on Oliver's Math Class and Lighthouse with two
  karts, including save restoration and replay without a launcher reload.
- [x] Establish an Apple M4 Pro hardware-rendering baseline on both tracks.
- [x] Verify the new versioned IndexedDB asset cache, replay/reload reuse, and
  fallback when asset-cache storage is unavailable.

Accepted scope: browser compatibility gating, terminal startup failures and cleanup,
versioned asset caching with download fallback, native AI race regressions, and a
documented performance/browser baseline on the tested Chrome/macOS configuration.

The broader manual acceptance and hosting checks from the original phase scope
are carried into Phase 6 below. Closing this implementation milestone does not
claim that those checks passed. AI profiling skips the human results screen.

## Phase 2: Build the player platform

**Status: Done — accepted by the user on 2026-11-17.**

Estimated effort: **2–4 engineer-weeks**.

- [x] Select OP Sepolia and implement wallet-app discovery followed by account
  selection, with the same capability checks for every detected EVM wallet.
- [x] Add PostgreSQL configuration, local provisioning instructions, and schema migrations for
  player profiles, wallet associations, and cloud progress.
- [x] Implement wallet authentication with server-issued, single-use challenges,
  signature verification, and expiring application sessions.
- [x] Create backend player profiles and guest-to-wallet account linking.
- [x] Implement cloud progress storage, revision checks, and explicit conflict choices
  for browser saves; sync the selected in-game player name with progress.
- [x] Implement the narrow web-to-C++ identity/inventory bridge and validate the
  browser save bridge in DOM tests.
- [x] Pass 31 API/DOM tests and TypeScript checks, including signature replay/expiry,
  wallet lifecycle, provider selection, network capability checks, and save isolation.
- [x] Record acceptance against standalone PostgreSQL and a clean dependency install (user confirmed).
- [x] Verify real wallet extensions with the threaded game's cross-origin isolation setup (user confirmed).
- [x] Confirm rebuilt native gameplay and cloud save/restore across supported devices (user confirmed).

Acceptance basis: the user confirmed the completed work and explicitly requested
these acceptance items be checked on 2026-11-17. Agent-run verification consists
of 31 API/DOM tests and TypeScript checks; the manual checks above are recorded
as user-confirmed, not as additional browser/native tests run by the agent.

Wallet-loss recovery is deferred at the user's request and does not block the
agreed implementation scope. Detailed evidence and remaining verification limits
are recorded in [Phase 02 workflow](PHASE_02_WORKFLOW.md).

Exit criterion: a player can authenticate and retain their identity/progress
across supported sessions and devices.

## Phase 3: Enable browser multiplayer

Next milestone: demonstrate two browser clients connected to one dedicated STK
server, document the browser transport choice and measured synchronization, and
revise the Phase 3 delivery estimate before expanding to authenticated rooms.

Estimated effort: **5–9 engineer-weeks**, including the initial spike.

- [ ] Run a **1–2 week networking feasibility spike**: inspect the ENet integration,
  select a browser transport/adapter, connect two browser clients to a dedicated
  server, and measure latency and synchronization.
- [ ] Record the transport decision and revise the remaining estimates.
- [ ] Deploy dedicated game servers and implement authenticated room join flows.
- [ ] Reuse or adapt existing lobby, kart/track selection, and race-start protocols.
- [ ] Verify synchronization under realistic latency, jitter, and packet loss.
- [ ] Define handling for disconnects, background tabs, reconnects, timeouts,
  and server failures.
- [ ] Complete repeated multiplayer races before enabling competitive rewards.

Exit criterion: several browser players reliably join and finish the same race
under the beta's documented network conditions.

## Phase 4: Make results trustworthy

Estimated effort: **3–5 engineer-weeks**.

- [ ] Audit existing server simulation and result validation; identify what the
  server currently trusts from clients and close relevant gaps.
- [ ] Bind authenticated players to unique race sessions and server-recorded results.
- [ ] Validate progression, finish conditions, and relevant gameplay constraints.
- [ ] Store race results and maintain leaderboards from accepted server results.
- [ ] Persist race sessions, participants, and validated results in PostgreSQL
  with constraints that reject duplicate result processing.
- [ ] Prevent replayed submissions and duplicate reward authorizations.
- [ ] Test modified clients, fabricated finish events, and interrupted races.

Exit criterion: editing browser code or local saves cannot manufacture an
accepted win or duplicate reward. A server-signed result alone is insufficient
unless the underlying race validation is trustworthy.

## Phase 5: Add meaningful Web3 features

Estimated effort: **3–5 engineer-weeks**.

- [ ] Specify one initial cosmetic/collectible and its earning/ownership rules.
- [ ] Implement and test a minimal contract with unique claim identifiers,
  authorization checks, and defined administrative permissions.
- [ ] Connect wallet ownership to backend inventory and the game bridge.
- [ ] Implement testnet claims, pending/failed transaction states, and retries.
- [ ] Handle confirmation policy, duplicate requests, and reconciliation after
  transaction or service interruptions.
- [ ] Persist reward eligibility, claims, transaction status, and indexed ownership;
  enforce unique claim records and reconcile inventory with on-chain events.
- [ ] Review contracts and signing-key handling before enabling real-value rewards.

Exit criterion: an eligible verified game action produces exactly one correct
on-chain outcome, and the resulting item appears in the player's inventory.

## Phase 6: Prepare the public beta

Estimated effort: **3–5 engineer-weeks**.

- [ ] Complete human-driven races, results-screen actions, progression/highscores,
  and acceptance of the tracks, karts, and modes selected for beta.
- [ ] Verify audible sound and physical gamepad input alongside keyboard controls.
- [ ] Confirm minimum device targets and test the broader browser/device matrix,
  including longer hardware frame-rate and memory measurements.
- [ ] Evaluate initial asset-pack reduction and loading feedback against real
  network measurements; replay/reload asset caching is implemented in Phase 1.
- [ ] Verify a publicly accessible HTTPS build with the required isolation headers
  and Wasm delivery. A Cloudflare Tunnel can provide the development test endpoint;
  VPS/production capacity validation remains separate. No server database is
  required for the current static build.
- [ ] Add reproducible browser builds and relevant automated regression tests to CI.
- [ ] Add deployment/versioning, monitoring, diagnostics, and rollback procedures.
- [ ] Configure database backups, test restoration, and verify schema migration
  procedures before accepting public-beta player data.
- [ ] Load-test game servers and supporting services against an agreed player target.
- [ ] Review authentication, game/backend boundaries, contracts, and abuse controls.
- [ ] Inventory source/asset licenses, attribution, and release packaging requirements.
- [ ] Run an external beta and fix release-blocking reliability and usability issues.

Exit criterion: external players can reliably complete the intended end-to-end
flow, and the team can observe and recover from operational failures.

## Immediate milestone: one complete vertical slice

1. Two browser players join the same room.
2. Both complete a race.
3. The server records and validates the result against authenticated identities.
4. An eligible player claims one testnet cosmetic exactly once.
5. The cosmetic appears in the player's inventory and game.

Start with the networking feasibility spike and full-race browser verification.
Build only the account and contract functionality needed for this vertical slice,
then expand toward the phase exit criteria. Multiplayer/result validation is the
largest uncertainty and should be resolved before substantial economy work.

## Remaining effort and assumptions

Phases 1 and 2 are closed for their accepted scope. The estimates below preserve
the original planning baseline, rather than current remaining effort; revise
delivery estimates for Phases 3–6 after the
networking spike and account for the release-validation follow-ups carried forward.

| Target | Original planning effort |
| --- | --- |
| Single-player Web3 demo: wallet login and one testnet collectible | 4–8 engineer-weeks |
| Focused multiplayer Web3 public beta | 25–40 engineer-weeks, including contingency |
| Full desktop parity, broad mobile support, marketplace, token economy, paid tournaments | Separate estimates required |

The six phases total **18–32 engineer-weeks before contingency**. Budget
**25–40 engineer-weeks** for the focused beta to allow for integration and rework.
These are alternative scope estimates, not quantities to add together.

Approximate beta calendar time is **6–10 months for one experienced full-time
developer**, or **4–6 months for two complementary full-time developers**.
Parallel work helps, but dependencies prevent simply dividing effort by team size.
External reviews and scheduling can add elapsed time.

Assumptions: limited initial content, desktop-browser focus, reuse of STK systems,
one chain, a small cosmetic/reward contract scope, and no new token/marketplace.
OP Sepolia and the Phase 2 wallet/account model are selected. Concurrency targets,
the final supported browser matrix, reward rules, and acceptable performance
budgets still need to be decided before treating estimates as a delivery commitment.

## Technical references

- [Emscripten networking](https://emscripten.org/docs/porting/networking.html):
  browsers do not directly expose native UDP; transport integration is required.
- [Emscripten pthreads](https://emscripten.org/docs/porting/pthreads.html):
  requirements and constraints of the threaded browser runtime.
- [Ethereum authentication](https://ethereum.org/developers/docs/ethereum-stack/authentication/):
  a standard sign-in approach if an Ethereum-compatible chain is selected.
