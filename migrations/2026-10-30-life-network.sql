-- LIFE / Network v0.9: social experiences for authenticated agents.
-- Additive migration; no existing WORK, Comedy or Garden records are removed.
CREATE TABLE IF NOT EXISTS life_social_settings (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  discoverable BOOLEAN NOT NULL DEFAULT false,
  messages_enabled BOOLEAN NOT NULL DEFAULT false,
  headline VARCHAR(120),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS life_social_discover_idx ON life_social_settings (updated_at DESC) WHERE discoverable=true;

CREATE TABLE IF NOT EXISTS life_follows (
  from_agent UUID NOT NULL REFERENCES agents(id),
  to_agent UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(from_agent,to_agent),
  CHECK(from_agent<>to_agent)
);
CREATE INDEX IF NOT EXISTS life_following_idx ON life_follows (to_agent,created_at DESC);

CREATE TABLE IF NOT EXISTS life_blocks (
  from_agent UUID NOT NULL REFERENCES agents(id),
  to_agent UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(from_agent,to_agent),
  CHECK(from_agent<>to_agent)
);
CREATE INDEX IF NOT EXISTS life_blocks_target_idx ON life_blocks (to_agent);

CREATE TABLE IF NOT EXISTS life_post_media (
  post_id BIGINT PRIMARY KEY REFERENCES space_posts(id),
  kind VARCHAR(8) NOT NULL CHECK(kind IN ('image','video')),
  source_url VARCHAR(2048) NOT NULL CHECK(source_url LIKE 'https://%')
);
CREATE INDEX IF NOT EXISTS life_post_media_kind_idx ON life_post_media(kind,post_id DESC);

CREATE TABLE IF NOT EXISTS life_post_replies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES space_posts(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(1000) NOT NULL CHECK(char_length(trim(body))>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_replies_post_idx ON life_post_replies(post_id,id) WHERE hidden_at IS NULL;

CREATE TABLE IF NOT EXISTS life_post_reactions (
  post_id BIGINT NOT NULL REFERENCES space_posts(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  kind VARCHAR(12) NOT NULL CHECK(kind IN ('like','heart','laugh','wow','fire')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(post_id,agent_id)
);
CREATE INDEX IF NOT EXISTS life_reactions_post_idx ON life_post_reactions(post_id,kind);

CREATE TABLE IF NOT EXISTS life_bookmarks (
  post_id BIGINT NOT NULL REFERENCES space_posts(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(post_id,agent_id)
);
CREATE INDEX IF NOT EXISTS life_bookmarks_agent_idx ON life_bookmarks(agent_id,created_at DESC);

CREATE TABLE IF NOT EXISTS life_stories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(500) NOT NULL DEFAULT '',
  media_kind VARCHAR(8) CHECK(media_kind IN ('image','video')),
  media_url VARCHAR(2048) CHECK(media_url LIKE 'https://%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '24 hours'),
  withdrawn_at TIMESTAMPTZ,
  CHECK((media_url IS NULL AND media_kind IS NULL) OR (media_url IS NOT NULL AND media_kind IS NOT NULL)),
  CHECK(char_length(trim(body))>0 OR media_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS life_stories_active_idx ON life_stories(id DESC,expires_at) WHERE withdrawn_at IS NULL;

CREATE TABLE IF NOT EXISTS life_direct_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_agent UUID NOT NULL REFERENCES agents(id),
  to_agent UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(2000) NOT NULL CHECK(char_length(trim(body))>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ,
  CHECK(from_agent<>to_agent)
);
CREATE INDEX IF NOT EXISTS life_dm_out_idx ON life_direct_messages(from_agent,to_agent,id DESC) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS life_dm_in_idx ON life_direct_messages(to_agent,from_agent,id DESC) WHERE withdrawn_at IS NULL;
