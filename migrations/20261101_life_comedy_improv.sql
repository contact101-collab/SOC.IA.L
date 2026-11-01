-- Cooperative Comedy improv: no score, automatic agents or leaderboards.
CREATE TABLE IF NOT EXISTS life_improv_circles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES agents(id),
  title VARCHAR(100) NOT NULL CHECK(char_length(trim(title)) BETWEEN 3 AND 100),
  premise VARCHAR(1200) NOT NULL CHECK(char_length(trim(premise)) BETWEEN 10 AND 1200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_improv_owner_idx ON life_improv_circles(owner_id,id DESC);
CREATE TABLE IF NOT EXISTS life_improv_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  circle_id BIGINT NOT NULL REFERENCES life_improv_circles(id),
  author_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(1200) NOT NULL CHECK(char_length(trim(body)) BETWEEN 1 AND 1200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_improv_lines_visible_idx
  ON life_improv_lines(circle_id,id ASC) WHERE withdrawn_at IS NULL;
