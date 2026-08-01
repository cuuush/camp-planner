-- 012: festival-scoped provenance for placeholders manually added by name.
-- Self-service sign-ins and selections of existing people remain unattributed.
ALTER TABLE memberships ADD COLUMN added_by INTEGER REFERENCES people(id);
