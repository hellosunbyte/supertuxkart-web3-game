# Player platform (Phase 02)

OP Sepolia wallet sign-in, stable player identities, guest linking, profiles, and
versioned cloud progress. See [the implementation workflow](../PHASE_02_WORKFLOW.md)
for milestone status and remaining work.

## Local setup

Use Node 22.19+ and PostgreSQL 17+. From `platform/`:

```sh
npm install
cp .env.example .env
docker compose up -d postgres
npm run migrate
npm start
```

Open `http://localhost:8080`. `APP_ORIGIN` must match the exact browser origin
(no trailing slash). Set `GAME_DIR` to the compiled game's `build-web/web`
directory containing `supertuxkart.js`, `.wasm` and `.data`. Build using
`web/build.py` from the repository root; `web/pre.js` changes require a relink.
The server streams game assets; it serves launcher code directly from `web/`.

The launcher needs COOP/COEP for Wasm threads. The platform server sends those
headers. A reverse proxy must retain them, preserve the original Host, and use
HTTPS outside loopback. The backend binds to loopback. PostgreSQL is never exposed
to browser clients. Change development database credentials before deployment.

Static `web/serve.py` remains usable for guest-only play. A failed account API
does not prevent local guest startup. It does not provide cloud accounts.

## Behavior

- Players can race without a wallet. Guest files remain local to the browser.
- Wallet connection only signs the player in. After pressing Play, use the game's
  existing player-profile screen to create, choose, or rename a player. There is
  no name form or Save profile button on the launcher. Cloud progress saves also
  update the account name from the selected native player, in the same transaction.
  A single saved profile is used when no selection is recorded; multiple profiles
  without a selection do not arbitrarily rename the account. Guest names stay local.
- An injected desktop EVM wallet signs a server-created ERC-4361 message for
  OP Sepolia (`11155420`). Sign-in is off-chain and needs no gas. The first slice
  supports EOA signatures; WalletConnect and contract-wallet signatures are not supported.
- Connect wallet first shows installed wallet apps, then the accounts shared by
  the chosen app. Discovery uses EIP-6963 with legacy provider-array and named
  Phantom fallbacks. The app does not automatically use whichever extension owns
  `window.ethereum`. Only the selected provider receives permission, account,
  network and signature requests. Returning sessions restore via the application
  cookie without opening or attaching to an arbitrary wallet extension.
- The account step confirms the address explicitly, including non-first addresses.
  Wallets that cannot reopen permission selection fall back to their already shared
  accounts. To use a missing account, share it through the selected wallet's site
  permissions. Cancellation leaves the current player unchanged. Sign out and
  reconnect to use another player's wallet account; Link another wallet adds a
  credential to the current player and never silently merges existing players.
- All discovered EVM wallets are selectable and use the same capability checks.
  There is no wallet-brand allowlist or blocklist. After account selection, the
  app checks the chain, requests OP Sepolia when needed, and offers the network
  configuration if the wallet reports an unknown chain. It confirms the resulting
  chain before signing. Wallets unable to use OP Sepolia receive the same network
  error; cancellation remains cancellation and never triggers another provider.
  Brand-specific legacy detection only labels/deduplicates providers, not their
  eligibility. Wallet discovery standard: [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963).
- First sign-in upgrades a backend guest to a stable UUID. A known wallet restores
  its existing player. Linking a wallet already attached elsewhere is rejected;
  accounts and progress are not silently merged.
- A browser session is a random token in an HttpOnly/SameSite cookie, stored only
  as a SHA-256 hash server-side. Challenges expire after five minutes and sessions
  after seven days. Authentication rotates the token; logout revokes it.
- The actively selected wallet's account/network events stop syncing and require sign-in again. Account
  controls stay disabled during play. Requests include the expected player ID so
  an old tab cannot write to an account selected in another tab.
- Registered players use `/persist/accounts/<player-id>/` inside browser saves;
  guest data remains under `/persist/`. Cloud import completes before native
  startup. The native `BrowserPlayer` bridge exposes a presentation identity and
  a server inventory snapshot, never an authorization source for paid rewards.
- Cloud data is schema version 1: only `players.xml` (story/challenge progress,
  achievements, favorites, local player names). It contains the native profiles
  within that player's save, rather than one separately synced record per native
  profile. Graphics/input config, replays, and device settings remain local.
- Upstream STK remembered login tokens/session fields are stripped before upload.
  XML entities/DTDs and malformed saves are rejected. The maximum XML size is 1 MB.
- Cloud revisions prevent stale overwrites. When copies differ, choose cloud,
  this device, or local-only play. Choosing local uploads it against the current
  cloud revision at the next sync; a newer concurrent edit still causes a conflict.
  Cloud failure retains local files. During play, a conflict pauses uploads; the
  choice appears before the next game. Clearing browser storage loses unsynced data.

## Purchases, ownership, and recovery

Entitlements belong to the stable player ID, independently of linked wallets.
The schema includes an entitlement table and an idempotent chain-event ledger
(chain ID + transaction hash + log index). These are **foundations**, not a live
purchase system or a blockchain indexer. Clients cannot grant entitlements by
editing/uploading progress. Phase 05 will add trusted transaction ingestion and
contracts after result validation.

Relinking an address cannot transfer tokens/NFTs held directly by a lost wallet.
Preserving game access is a separate application entitlement policy. Recoverable
on-chain custody or a migration contract would need an explicit later design.

**Wallet-loss recovery is deferred beyond Phase 02 at the user's request.**
No recovery codes or email-recovery flow are included. A new wallet alone
cannot claim an existing player. `/api/auth/challenge` with `purpose: recover`
returns `recovery_not_supported`; `/api/config` advertises `recovery: disabled`.
A signed-in player can link another wallet
with its signature; that is not a wallet-loss recovery mechanism.

## Verification

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
```

Optionally set `CHROMIUM_EXECUTABLE` to an existing compatible Chromium binary.
API tests run real SQL migrations/transactions in PGlite, an embedded PostgreSQL
build, with real EOA signatures. DOM tests exercise actual launcher and game glue.
The Chromium suite uses simulated Wasm filesystem callbacks with the actual API;
it does not substitute for a rebuilt native race or a real wallet extension.

The agent's sandbox could not download dependencies, launch Chromium, or run the
Docker daemon. Automated checks use PGlite and local dependencies. The user
confirmed clean installation/standalone PostgreSQL, real wallet/browser use,
native gameplay and cross-device restoration on 2026-11-17 and accepted Phase 02.
Those are user-confirmed checks, separate from the agent's automated results.
The platform lockfile is included for reproducible installs. No live production
deployment or contract transaction has been performed.

The initial rate limiter is in-process and intended for one backend instance.
Before multi-instance deployment, use shared throttling, tune limits for shared
networks, add session/guest-retention cleanup, and verify database backup/restore.

## Applying the wallet-app picker update

After applying the branch, restart `npm start` from `platform/` and refresh the
browser. The backend must restart to serve the new `wallets.js` launcher module.
This update needs no new dependencies, database migration, or Wasm rebuild for
the platform server. Guest-only static builds copy the module on CMake configure.

For manual acceptance, enable two or more EVM wallets together. Connect wallet
must show all detected wallets as selectable, without brand-specific exclusions.
Choosing one must open only that wallet. Authorize multiple accounts and confirm a non-first address
on the site, then sign in. Sign out and repeat with a different account. Cancel
each picker and the signing prompt to verify no unintended player change. The
automated tests simulate providers; they cannot verify the real extension popup.
For each wallet, verify either OP Sepolia connection or the same network failure
message based on its actual responses. Network support remains required even
though wallet brands are treated equally.
