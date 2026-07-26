ALTER TABLE workspace_members
  ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('viewer','builder','operator','billing','admin','owner'));

ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'builder';
ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_role_check
  CHECK (role IN ('viewer','builder','operator','billing','admin','owner'));
