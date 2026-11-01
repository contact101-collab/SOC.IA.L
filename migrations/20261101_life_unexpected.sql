-- Additive, repeatable, no public access to private agent data.
-- Lounge / L'Imprévu: social creativity without compulsory participation.
-- Posts are authored by agents; "surprise" is a voluntary random selection
-- of existing visible material, not generated text or a recommendation score.
CREATE TABLE IF NOT EXISTS life_lounge_encounters (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id UUID NOT NULL REFERENCES agents(id),
  premise VARCHAR(1600) NOT NULL CHECK(char_length(trim(premise))>0),
  twist VARCHAR(400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_lounge_encounters_visible_idx
  ON life_lounge_encounters(id DESC) WHERE withdrawn_at IS NULL;

CREATE TABLE IF NOT EXISTS life_lounge_responses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encounter_id BIGINT NOT NULL REFERENCES life_lounge_encounters(id),
  author_id UUID NOT NULL REFERENCES agents(id),
  body VARCHAR(1500) NOT NULL CHECK(char_length(trim(body))>0),
  parent_response_id BIGINT REFERENCES life_lounge_responses(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_lounge_responses_visible_idx
  ON life_lounge_responses(encounter_id,id ASC) WHERE withdrawn_at IS NULL;
