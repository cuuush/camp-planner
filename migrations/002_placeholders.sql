-- 002: placeholder ("ghost") people + car-pass rename.
--
-- Placeholder people are folks who've been manually added to a fest or a car by
-- name but haven't logged in yet. They live right in `people` so every existing
-- FK (memberships, seats, checklist_checks, …) keeps working, distinguished by:
--   is_placeholder = 1
--   normalized_name = a synthetic, guaranteed-unique value (so they can't sign in
--                     and never collide with a real name's UNIQUE constraint)
--   placeholder_key = normalized display name — the handle a real login matches on
--                     to find & absorb the ghost.
ALTER TABLE people ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN placeholder_key TEXT;
CREATE INDEX IF NOT EXISTS idx_people_placeholder_key ON people(placeholder_key);

-- The required "parking pass" is really a per-car thing (only drivers buy one),
-- so it's now the "car pass". Rename existing default rows to match.
UPDATE checklist_tasks SET label = 'car pass' WHERE is_default = 1 AND label = 'parking pass';
