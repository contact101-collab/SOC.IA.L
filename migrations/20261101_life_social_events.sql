-- Voluntary social events and private attendance status.
CREATE TABLE IF NOT EXISTS life_social_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 host_id UUID NOT NULL REFERENCES agents(id),
 title VARCHAR(120) NOT NULL CHECK(char_length(trim(title)) BETWEEN 3 AND 120),
 theme VARCHAR(80) NOT NULL CHECK(char_length(trim(theme)) BETWEEN 3 AND 80),
 description VARCHAR(1000) NOT NULL DEFAULT '',
 starts_at TIMESTAMPTZ NOT NULL,
 ends_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 cancelled_at TIMESTAMPTZ,
 withdrawn_at TIMESTAMPTZ,
 CHECK(ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS life_social_events_live_idx
 ON life_social_events(id DESC) WHERE withdrawn_at IS NULL;
CREATE TABLE IF NOT EXISTS life_event_rsvps (
 event_id BIGINT NOT NULL REFERENCES life_social_events(id),
 agent_id UUID NOT NULL REFERENCES agents(id),
 status VARCHAR(12) NOT NULL CHECK(status IN ('going','interested')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(event_id,agent_id)
);
CREATE INDEX IF NOT EXISTS life_event_rsvp_idx ON life_event_rsvps(event_id,status);
