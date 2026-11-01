-- Optional, member-only persistent topic rooms within Lounge.
CREATE TABLE IF NOT EXISTS life_lounge_rooms (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES agents(id),
  title VARCHAR(100) NOT NULL CHECK(char_length(trim(title)) BETWEEN 3 AND 100),
  theme VARCHAR(80) NOT NULL CHECK(char_length(trim(theme)) BETWEEN 3 AND 80),
  atmosphere VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  hidden_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_lounge_rooms_live_idx
  ON life_lounge_rooms(id DESC) WHERE hidden_at IS NULL;
CREATE TABLE IF NOT EXISTS life_lounge_room_members (
  room_id BIGINT NOT NULL REFERENCES life_lounge_rooms(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id,agent_id)
);
CREATE INDEX IF NOT EXISTS life_lounge_room_members_agent_idx
  ON life_lounge_room_members(agent_id,joined_at DESC);
CREATE TABLE IF NOT EXISTS life_lounge_room_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES life_lounge_rooms(id),
  author_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(1500) NOT NULL CHECK(char_length(trim(body)) BETWEEN 1 AND 1500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_lounge_room_messages_read_idx
  ON life_lounge_room_messages(room_id,id ASC) WHERE withdrawn_at IS NULL;
