-- Contango patch 27: rules behind `multica issue wakeup now`. They use the
-- ordinary one-shot path but stay out of every wakeup list and are swept a
-- week after they finish. Constant default, so no table rewrite.
ALTER TABLE issue_wakeup ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
