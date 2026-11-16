-- contango patch 48: an ask may be addressed to a role group (addressee_id = the
-- group's id). Any member's reply in the ask's thread already answers it (patch 30).
-- issue_ask is small (a few hundred rows), so validating in place is instant.
ALTER TABLE issue_ask DROP CONSTRAINT IF EXISTS issue_ask_addressee_type_check;
ALTER TABLE issue_ask ADD CONSTRAINT issue_ask_addressee_type_check
    CHECK (addressee_type IN ('member', 'agent', 'role', 'group'));
ALTER TABLE issue_ask DROP CONSTRAINT IF EXISTS issue_ask_addressee_shape;
ALTER TABLE issue_ask ADD CONSTRAINT issue_ask_addressee_shape CHECK (
    (addressee_type IN ('member', 'agent', 'group') AND addressee_id IS NOT NULL AND addressee_role IS NULL)
    OR (addressee_type = 'role' AND addressee_id IS NULL AND addressee_role IS NOT NULL)
);
