CREATE TABLE players (
    id uuid PRIMARY KEY,
    kind text NOT NULL DEFAULT 'guest' CHECK (kind IN ('guest', 'registered')),
    display_name text NOT NULL DEFAULT 'Racer' CHECK (length(display_name) BETWEEN 1 AND 40),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallets (
    address text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
    player_id uuid NOT NULL REFERENCES players(id),
    chain_id integer NOT NULL CHECK (chain_id = 11155420),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallets_player ON wallets(player_id);
CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_player ON sessions(player_id);
CREATE TABLE challenges (
    id uuid PRIMARY KEY,
    session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    address text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('login', 'link', 'recover')),
    message text NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE TABLE cloud_saves (
    player_id uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision > 0),
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- Game access belongs to a stable player. Saves can never create these rows.
CREATE TABLE entitlements (
    player_id uuid NOT NULL REFERENCES players(id),
    item_id text NOT NULL,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, item_id)
);
-- Future trusted chain indexer writes this ledger. No client grant endpoint.
CREATE TABLE chain_transactions (
    chain_id integer NOT NULL CHECK (chain_id = 11155420),
    tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    log_index integer NOT NULL CHECK (log_index >= 0),
    player_id uuid NOT NULL REFERENCES players(id),
    wallet_address text NOT NULL,
    status text NOT NULL CHECK (status IN ('observed', 'confirmed', 'reverted')),
    details jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (chain_id, tx_hash, log_index)
);
