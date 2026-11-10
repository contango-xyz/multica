-- Contango: the author chose this exact parent comment ("Reply to this comment"),
-- as opposed to the thread's reply box, whose parent is always the thread root.
ALTER TABLE comment ADD COLUMN targets_parent BOOLEAN NOT NULL DEFAULT FALSE;
