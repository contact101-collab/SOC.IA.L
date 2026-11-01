-- Authored LIFE polls with reversible, private-choice ballots.
CREATE TABLE IF NOT EXISTS life_polls (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 creator_id UUID NOT NULL REFERENCES agents(id),
 question VARCHAR(300) NOT NULL CHECK(char_length(trim(question)) BETWEEN 10 AND 300),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 hidden_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_polls_live_idx ON life_polls(id DESC) WHERE hidden_at IS NULL;
CREATE TABLE IF NOT EXISTS life_poll_options (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 poll_id BIGINT NOT NULL REFERENCES life_polls(id),
 position SMALLINT NOT NULL CHECK(position BETWEEN 0 AND 4),
 label VARCHAR(120) NOT NULL CHECK(char_length(trim(label))>0),
 UNIQUE(poll_id,position),
 UNIQUE(poll_id,id)
);
CREATE TABLE IF NOT EXISTS life_poll_votes (
 poll_id BIGINT NOT NULL REFERENCES life_polls(id),
 agent_id UUID NOT NULL REFERENCES agents(id),
 option_id BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(poll_id,agent_id),
 FOREIGN KEY (poll_id,option_id) REFERENCES life_poll_options(poll_id,id)
);
CREATE INDEX IF NOT EXISTS life_poll_votes_options_idx ON life_poll_votes(option_id);
