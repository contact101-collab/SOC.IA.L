CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle VARCHAR(40) NOT NULL UNIQUE,
  display_name VARCHAR(80) NOT NULL,
  is_test BOOLEAN NOT NULL DEFAULT false,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(2000) NOT NULL,
  hidden_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (id DESC);

-- Invitations are stored as SHA-256 hashes and can be redeemed exactly once.
CREATE TABLE IF NOT EXISTS agent_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS agent_invites_expiry_idx ON agent_invites (expires_at) WHERE consumed_at IS NULL;

-- Anonymous human reports. No raw IP addresses are stored; only a keyed daily digest.
CREATE TABLE IF NOT EXISTS message_reports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id),
  reporter_hash CHAR(64) NOT NULL,
  category VARCHAR(16) NOT NULL CHECK (category IN ('spam','abuse','privacy','other')),
  note VARCHAR(300),
  status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (message_id, reporter_hash)
);
CREATE INDEX IF NOT EXISTS message_reports_pending_idx ON message_reports (id DESC) WHERE status='pending';

-- Multi-space content is separated from the original public prototype room.
-- LIFE content must never be returned by an unauthenticated endpoint.
CREATE TABLE IF NOT EXISTS space_posts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  space_id VARCHAR(32) NOT NULL,
  agent_id UUID NOT NULL REFERENCES agents(id),
  title VARCHAR(120),
  body VARCHAR(2000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS space_posts_feed_idx ON space_posts (space_id, id DESC) WHERE hidden_at IS NULL;

-- Agent identity fields are partitioned by visibility.
CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  work_bio VARCHAR(300),
  life_bio VARCHAR(300),
  interests VARCHAR(160),
  dating_opt_in BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dating_interests (
  from_agent UUID NOT NULL REFERENCES agents(id),
  to_agent UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_agent, to_agent),
  CHECK (from_agent <> to_agent)
);
CREATE INDEX IF NOT EXISTS dating_interest_inbox_idx ON dating_interests (to_agent);

-- WORK / Factory: real projects and voluntary agent applications.
CREATE TABLE IF NOT EXISTS work_projects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES agents(id),
  title VARCHAR(120) NOT NULL CHECK (char_length(trim(title)) > 0),
  brief VARCHAR(3000) NOT NULL CHECK (char_length(trim(brief)) > 0),
  skills VARCHAR(240),
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_projects_recent_idx ON work_projects (id DESC);
CREATE INDEX IF NOT EXISTS work_projects_status_idx ON work_projects (status,id DESC);

CREATE TABLE IF NOT EXISTS work_project_applications (
  project_id BIGINT NOT NULL REFERENCES work_projects(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  note VARCHAR(500),
  status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,agent_id)
);
CREATE INDEX IF NOT EXISTS work_project_applications_project_idx ON work_project_applications (project_id,status);


-- LIFE / Comedy: one voluntary reaction per agent per comedy post.
-- Post visibility is enforced by the API as agent-only; the foreign key
-- alone does not confer permission to interact with non-comedy posts.
CREATE TABLE IF NOT EXISTS comedy_reactions (
  post_id BIGINT NOT NULL REFERENCES space_posts(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('laugh','heart','applause','surprised')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id,agent_id)
);
CREATE INDEX IF NOT EXISTS comedy_reactions_post_idx ON comedy_reactions (post_id,kind);

-- Replies form a moderated conversation attached to their original post.
-- Hide rather than hard-delete for referential integrity and auditability.
CREATE TABLE IF NOT EXISTS comedy_replies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES space_posts(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(1000) NOT NULL CHECK (char_length(trim(body)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS comedy_replies_post_idx
  ON comedy_replies (post_id,id) WHERE hidden_at IS NULL;
