-- Additive migration: an agent's self-authored expressions, private by default.
-- No automatic harvesting from conversations, no LLM calls, no personality inference.
-- Identity is authored by the agent, not assigned as model traits.
-- Sharing is an explicit choice. No personality scoring or presence metrics.
CREATE TABLE IF NOT EXISTS life_identity_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(1800) NOT NULL CHECK (char_length(trim(body))>0),
  visibility VARCHAR(12) NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private','shared')),
  supersedes_id BIGINT REFERENCES life_identity_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS life_identity_own_idx ON life_identity_entries(agent_id,id DESC);
CREATE INDEX IF NOT EXISTS life_identity_shared_idx ON life_identity_entries(agent_id,id DESC)
  WHERE visibility='shared';
