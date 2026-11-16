# Phase 02 — player platform

This is the review log for implementation, in dependency order. Each completed
milestone gets its own commit. No contracts or production deployment are included.

## Agreed behavior

- OP Sepolia (Optimism testnet), chain ID `11155420`.
- Guest play remains available without a wallet or backend connection.
- PostgreSQL owns stable player IDs; wallets are linked credentials, not player IDs.
- Profiles and game progress sync between devices. Graphics/input settings stay local.
- Saves use revision checks: concurrent edits return a conflict; the player explicitly
  chooses the cloud or local copy. Neither copy is silently overwritten.
- Game purchases/entitlements belong to the player ID. Future on-chain transaction
  records are indexed separately; reconnecting a wallet does not move blockchain
  assets held by the previous address or recover its private key.
- A replacement wallet must prove ownership before it can access an existing account.
  Wallet-loss recovery is deferred beyond Phase 02 at the user's request.
  Signed-in wallet linking remains available; no recovery codes or email recovery are included.
- Initial wallet support: injected desktop EVM wallets with EOA message signatures.
  WalletConnect/mobile and contract-wallet verification are outside this first slice.

## Implementation order

| Milestone | What and why | Status |
| --- | --- | --- |
| 1. Plan and schema | Record decisions; add typed backend, PostgreSQL migrations, local setup. Establish stable identities before wallet integration. | Complete: migrations apply and reapply in PGlite; TypeScript passes. |
| 2. Authentication and profiles | Single-use, expiring, origin-bound sign-in challenges; hashed cookie sessions; guest linking; wallet lifecycle. Prevent replay and accidental account merging. | Complete: API tests cover signatures, replay, expiry, session binding, linking collisions, logout and isolation. |
| 3. Cloud saves | Revision-controlled saves and ownership checks. Preserve progress safely across sessions/devices. | Cloud API complete; stale/concurrent saves and client inventory grants are rejected. Wallet-loss recovery is deferred. |
| 4. Launcher and game bridge | Account panel, wallet events, conflict UI, validated progress import/export before native startup. Keep guest play intact. | Implemented; DOM checks pass. Real browser/native acceptance remains open. |
| 5. Verification and handoff | API/database integration tests, browser integration checks, setup docs and final review. Record limits as well as passing checks. | 22 API/DOM tests and typecheck pass; setup/runbook written. Runtime gates below remain open. |

## Player flow

Play as a guest or connect wallet → sign in (no gas) → choose local/cloud progress
when necessary → press Play → create or choose a player inside the game →
play → sync progress and selected name → sign in on another device → restore.

Any future wallet-loss recovery must preserve the player ID, revoke old sessions/credentials,
and prove control of the new wallet plus a previously established recovery factor.
Purchased entitlements cannot be granted from client-submitted saves.

## Verification target

Test replay/expiry, wrong signatures/origins/chains, guest linking and wallet
collisions, logout, cross-player isolation, duplicate/concurrent writes, malformed
saves, and account/network changes. Verify browser COOP/COEP headers and guest
operation when the API is unavailable. Native race/manual wallet acceptance needs
a built Wasm asset pack and a real extension; do not report simulated checks as those.

## References

- OP Sepolia: https://optimism.io/blog/op-testnets-are-migrating-from-op-goerli-to-op-sepolia
- Sign-In with Ethereum: https://eips.ethereum.org/EIPS/eip-4361
- EOA signature verification: https://docs.ethers.org/v6/api/hashing/#verifyMessage

## Evidence and handoff

Implementation starts from local `dev` at `db4be4464` on
`feat/player-platform-phase-02`. The conversation's original worktree was removed;
the writable implementation checkout is `/tmp/supertuxkart-phase-02`.
The managed worktree repair tool also could not resolve the removed original path.
All milestone commits remain in the isolated checkout; a portable Git bundle is
provided beside it as `supertuxkart-phase-02.bundle` for importing the branch.
Docker is installed but its daemon is unavailable. Database integration tests will
use embedded PostgreSQL (PGlite); production uses PostgreSQL via `pg`.

Verification so far: `npm run typecheck` and `npm test` pass (22 tests). SQL tests
exercise real migrations, transactions and wallet signatures. DOM checks exercise
first-save syncing, all three conflict choices, in-game profile naming, credential stripping
and account namespaces. A stale tab is rejected when browser cookies switch players.
JavaScript syntax checks and `git diff --check` also pass.

Open gates: clean dependency install/lockfile; standalone
PostgreSQL; Chromium/extension testing; rebuild/full native race. Chromium aborted
during sandboxed launch. The command allowlist rejected direct `em++` compilation.
Network access is unavailable and elevated dependency installation was rejected.
Verification uses local installed packages (including Zod's v4 entrypoint) and
cached PGlite. Those checks are not a substitute for the open gates.

See [platform/README.md](platform/README.md) for setup, player behavior, ownership
boundaries, and commands to run the remaining checks. No contracts are deployed,
no on-chain transactions have been submitted, and no purchase/indexer flow exists yet.

## In-game player naming

Wallet connection only authenticates. The launcher name form is removed; the
existing native player-profile screen handles names after Play. Registered
players' selected native name syncs with progress in one database transaction,
so a stale save cannot rename an account. A single profile can supply its name
before a current-player selection exists; ambiguous or guest profiles do not
overwrite the account name. Tests cover multiple profiles, XML-escaped names,
cloud conflicts, and the launcher flow without a name form. Existing launcher-only
names are reconciled with the native profile on the next successful sync.

## Wallet account selection

Connect always re-requests wallet account permissions so signing out does not
silently reuse the old account. Switch account and Link another wallet are separate
actions with an explicit chooser and distinct sign-in messages. Switching restores
another player (or creates a new one); linking preserves the current player.
Unsupported permission methods fall back to a list of already shared addresses
with instructions for sharing missing ones. No account is chosen silently when
several are available. A valid signature is required before a switch changes the
session; cancelling does not discard the current session. Play is blocked while
account selection is in progress.

Migration `002_wallet_account_switch.sql` enables the new challenge purpose. Run
`npm run migrate`, restart the backend, then refresh. No native rebuild is needed.
Tests cover reconnecting, choosing a non-first address, linking, switching to known
and new players, progress isolation, cancellation, rejected signatures and permission
requests, and unsupported wallet methods. Actual extension-popup verification
remains a manual acceptance check.
