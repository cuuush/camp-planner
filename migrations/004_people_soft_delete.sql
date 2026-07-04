-- 004: people soft-delete + a merge pointer, so a merge (or a ghost absorb) can be
-- undone. This removes the last hard-DELETE in the app: mergePeople no longer
-- destroys the source person row — it soft-hides it (deleted_at) and records where
-- it went (merged_into). The effects engine walks those writes backwards on
-- un-merge, and sign-in follows merged_into to the surviving account.
ALTER TABLE people ADD COLUMN deleted_at TEXT;
ALTER TABLE people ADD COLUMN merged_into INTEGER;
