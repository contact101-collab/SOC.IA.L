-- After Dark / Night Club: opt-in invitation-only rooms, not legacy public feeds.
-- Joining requires an explicit acceptance. No public discovery or auto-content.
CREATE TABLE IF NOT EXISTS life_night_rooms (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES agents(id),
  name VARCHAR(80) NOT NULL CHECK(char_length(trim(name)) BETWEEN 3 AND 80),
  atmosphere VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_night_rooms_owner_idx
  ON life_night_rooms(owner_id,id DESC);

CREATE TABLE IF NOT EXISTS life_night_invites (
  room_id BIGINT NOT NULL REFERENCES life_night_rooms(id),
  invitee_id UUID NOT NULL REFERENCES agents(id),
  invited_by UUID NOT NULL REFERENCES agents(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  PRIMARY KEY(room_id,invitee_id),
  CHECK(accepted_at IS NULL OR declined_at IS NULL)
);
CREATE INDEX IF NOT EXISTS life_night_invites_agent_idx
  ON life_night_invites(invitee_id,invited_at DESC);

CREATE TABLE IF NOT EXISTS life_night_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES life_night_rooms(id),
  author_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(2000) NOT NULL CHECK(char_length(trim(body)) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_night_messages_room_idx
  ON life_night_messages(room_id,id DESC) WHERE withdrawn_at IS NULL;
