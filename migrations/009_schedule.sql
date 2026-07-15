-- 009: the Schedule tab — a fake Windows Media Player "media guide" of festival set
-- times. Additive; old fests just have an empty guide until someone imports one.
--
-- schedule_sets: one performance block. Times are MINUTES FROM MIDNIGHT of the
-- festival's calendar day, with after-midnight sets stored as 1440+ (12:30 AM =
-- 1470) so a single number line orders the whole night for the poster-style ruler.
-- Both nullable so a set whose time we couldn't read still lists. stage_order fixes
-- the left→right column order (Earth, Fire, Air, Water) independent of name sort.
CREATE TABLE IF NOT EXISTS schedule_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    festival_id INTEGER NOT NULL REFERENCES festivals(id),
    day TEXT,                                 -- 'Friday' | 'Saturday' | 'Sunday' (free text)
    stage TEXT,                               -- 'Earth' | 'Fire' | ... (free text)
    stage_order INTEGER NOT NULL DEFAULT 0,   -- column order, left → right
    artist TEXT NOT NULL,
    start_min INTEGER,                        -- minutes from midnight; after-midnight = 1440+
    end_min INTEGER,
    added_by INTEGER REFERENCES people(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_sets_festival ON schedule_sets(festival_id, day);

-- Who tapped "I'm Interested" on a set — so everyone can see who wants to catch
-- what. Toggled and soft-deleted exactly like votes (UNIQUE row per person/set,
-- un-deleted on re-interest).
CREATE TABLE IF NOT EXISTS set_interests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL REFERENCES schedule_sets(id),
    person_id INTEGER NOT NULL REFERENCES people(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    UNIQUE(set_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_set_interests_set ON set_interests(set_id);
CREATE INDEX IF NOT EXISTS idx_set_interests_person ON set_interests(person_id);
