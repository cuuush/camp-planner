-- 012: festival-scoped provenance for placeholders created from the People tab.
-- Sign-ins and placeholders created by other flows remain unattributed.
ALTER TABLE memberships ADD COLUMN added_by INTEGER REFERENCES people(id);
