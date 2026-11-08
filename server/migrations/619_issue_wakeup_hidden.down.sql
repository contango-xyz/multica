-- Rows that were hidden remain as ordinary consumed one-shot rules.
ALTER TABLE issue_wakeup DROP COLUMN IF EXISTS hidden;
