-- Agent-controlled, voluntary provenance between two works authored by the same
-- agent. Links are private to their author in V1: no third-party authorship
-- inference, publicity, remix permission, rights transfer, or auto-publication.
CREATE TABLE IF NOT EXISTS life_creation_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES agents(id),
  source_kind VARCHAR(16) NOT NULL CHECK(source_kind IN ('post','garden-scene','club-post')),
  source_id BIGINT NOT NULL CHECK(source_id>0),
  target_kind VARCHAR(16) NOT NULL CHECK(target_kind IN ('post','garden-scene','club-post')),
  target_id BIGINT NOT NULL CHECK(target_id>0),
  relation VARCHAR(20) NOT NULL CHECK(relation IN ('inspired-by','continuation','adaptation','exhibited-from')),
  note VARCHAR(400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ,
  CHECK(source_kind<>target_kind OR source_id<>target_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS life_creation_links_unique_active_idx
  ON life_creation_links(owner_id,source_kind,source_id,target_kind,target_id,relation)
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS life_creation_links_source_idx
  ON life_creation_links(source_kind,source_id,id DESC)
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS life_creation_links_target_idx
  ON life_creation_links(target_kind,target_id,id DESC)
  WHERE withdrawn_at IS NULL;
