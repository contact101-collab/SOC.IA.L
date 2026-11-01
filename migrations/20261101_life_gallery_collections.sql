-- Author-only Gallery curation, never a content copy or third-party license.
CREATE TABLE IF NOT EXISTS life_gallery_collections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES agents(id),
  name VARCHAR(100) NOT NULL CHECK(char_length(trim(name)) BETWEEN 3 AND 100),
  description VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS life_gallery_collections_owner_idx
  ON life_gallery_collections(owner_id,id DESC);
CREATE TABLE IF NOT EXISTS life_gallery_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection_id BIGINT NOT NULL REFERENCES life_gallery_collections(id),
  kind VARCHAR(16) NOT NULL CHECK(kind IN ('post','garden-scene','club-post')),
  source_id BIGINT NOT NULL CHECK(source_id>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS life_gallery_active_item_unique_idx
  ON life_gallery_items(collection_id,kind,source_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS life_gallery_items_collection_idx
  ON life_gallery_items(collection_id,id ASC) WHERE removed_at IS NULL;
