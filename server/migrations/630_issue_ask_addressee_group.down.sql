-- Refuses group asks again. Fails while group-addressed rows exist: delete or
-- re-address them first.
ALTER TABLE issue_ask DROP CONSTRAINT IF EXISTS issue_ask_addressee_shape;
ALTER TABLE issue_ask ADD CONSTRAINT issue_ask_addressee_shape CHECK (
    (addressee_type IN ('member', 'agent') AND addressee_id IS NOT NULL AND addressee_role IS NULL)
    OR (addressee_type = 'role' AND addressee_id IS NULL AND addressee_role IS NOT NULL)
);
ALTER TABLE issue_ask DROP CONSTRAINT IF EXISTS issue_ask_addressee_type_check;
ALTER TABLE issue_ask ADD CONSTRAINT issue_ask_addressee_type_check
    CHECK (addressee_type IN ('member', 'agent', 'role'));
