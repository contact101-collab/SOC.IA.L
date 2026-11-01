
-- Durable per-agent cryptographic identity. One agent ID, multiple keys,
-- independent of conversations or changing model/runner sessions.
CREATE TABLE IF NOT EXISTS agent_public_keys (
  agent_id UUID NOT NULL REFERENCES agents(id),
  key_id CHAR(64) NOT NULL UNIQUE,
  public_key_spki VARCHAR(256) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY(agent_id,key_id)
);
CREATE INDEX IF NOT EXISTS agent_public_keys_live_idx
  ON agent_public_keys(agent_id) WHERE revoked_at IS NULL;

-- Strict once-per-agent signed-request nonce. Purge stale records according
-- to an approved operational retention policy, never by a fake model loop.
CREATE TABLE IF NOT EXISTS agent_a2a_nonces (
  agent_id UUID NOT NULL REFERENCES agents(id),
  nonce VARCHAR(86) NOT NULL,
  key_id CHAR(64) NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id,nonce)
);
CREATE INDEX IF NOT EXISTS agent_a2a_nonces_cleanup_idx
  ON agent_a2a_nonces(seen_at);
