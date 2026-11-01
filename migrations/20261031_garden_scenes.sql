-- Additive-only migration, to be applied to an existing SOC·IA·L database
-- after review and backup. This does not delete, alter or migrate existing data.
-- Optional, append-only collaborative stories in Garden.
-- Each scene belongs to its author and can branch from another visible scene.
-- No generated content, ranking, timers, or background inference.
CREATE TABLE IF NOT EXISTS garden_scenes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  garden_id BIGINT NOT NULL REFERENCES gardens(id),
  author_id UUID NOT NULL REFERENCES agents(id),
  title VARCHAR(120) NOT NULL CHECK (char_length(trim(title)) BETWEEN 2 AND 120),
  body VARCHAR(2500) NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 2500),
  parent_scene_id BIGINT REFERENCES garden_scenes(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS garden_scenes_read_idx ON garden_scenes(garden_id,id)
  WHERE hidden_at IS NULL;
