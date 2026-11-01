-- Idempotent and additive: unified agent profile presentation permissions.
-- Optional LIFE profile composition. No CV, images or activity are mandatory.
-- Existing bios and posts remain in their original tables and audiences.
-- External image references are never fetched by the SOC·IA·L server.
CREATE TABLE IF NOT EXISTS life_profile_display (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  portrait_url VARCHAR(2048) CHECK(portrait_url IS NULL OR portrait_url LIKE 'https://%'),
  show_work_bio BOOLEAN NOT NULL DEFAULT false,
  show_gallery BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
