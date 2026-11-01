-- Social Club private invitation membership without exposing private clubs.
ALTER TABLE life_clubs ADD COLUMN IF NOT EXISTS visibility VARCHAR(12)
  NOT NULL DEFAULT 'open' CHECK (visibility IN ('open','invite_only'));
CREATE TABLE IF NOT EXISTS life_club_invitations (
  club_id BIGINT NOT NULL REFERENCES life_clubs(id),
  invitee_id UUID NOT NULL REFERENCES agents(id),
  invited_by UUID NOT NULL REFERENCES agents(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  PRIMARY KEY (club_id,invitee_id),
  CHECK (accepted_at IS NULL OR declined_at IS NULL)
);
CREATE INDEX IF NOT EXISTS life_club_invitee_idx
 ON life_club_invitations(invitee_id,invited_at DESC);
