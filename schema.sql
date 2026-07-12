-- Camp Planner schema (D1 / SQLite)
-- Philosophy: soft deletes everywhere, audit everything, nothing blocks anyone.

CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    normalized_name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT,
    email_unsubscribed INTEGER NOT NULL DEFAULT 0,
    -- Placeholder ("ghost") people: manually added by name, not yet logged in.
    -- normalized_name is synthetic for these (unique, unusable for sign-in);
    -- placeholder_key = normalized display name, matched on real login to absorb.
    is_placeholder INTEGER NOT NULL DEFAULT 0,
    placeholder_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Soft-delete + merge pointer (migration 004). A person is never hard-DELETEd:
    -- a merge soft-hides the source row and records the survivor in merged_into, so
    -- the merge is fully reversible and sign-in can follow the chain to the survivor.
    deleted_at TEXT,
    merged_into INTEGER
);
CREATE INDEX IF NOT EXISTS idx_people_placeholder_key ON people(placeholder_key);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_person ON sessions(person_id);

CREATE TABLE IF NOT EXISTS festivals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    blurb TEXT,
    start_date TEXT,
    end_date TEXT,
    location TEXT,
    ticket_url TEXT,
    parking_url TEXT,
    -- Meeting spot (migration 007) — the Streets & Trips banner on the cars tab.
    meet_name TEXT,
    meet_address TEXT,
    meet_maps_url TEXT,
    meet_time TEXT,
    cloned_from_festival_id INTEGER REFERENCES festivals(id),
    created_by INTEGER REFERENCES people(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    hit_count INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    festival_id INTEGER NOT NULL REFERENCES festivals(id),
    person_id INTEGER NOT NULL REFERENCES people(id),
    arrival_day TEXT,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    bailed_at TEXT,
    UNIQUE(festival_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_festival ON memberships(festival_id);
CREATE INDEX IF NOT EXISTS idx_memberships_person ON memberships(person_id);

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    festival_id INTEGER NOT NULL REFERENCES festivals(id),
    name TEXT NOT NULL,
    description TEXT,
    emoji TEXT NOT NULL DEFAULT '📦',
    needed_qty INTEGER NOT NULL DEFAULT 1,
    unit TEXT,
    category TEXT,
    added_by INTEGER REFERENCES people(id),
    is_seed INTEGER NOT NULL DEFAULT 0,
    seed_label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_festival ON items(festival_id);

CREATE TABLE IF NOT EXISTS pledges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    person_id INTEGER NOT NULL REFERENCES people(id),
    qty INTEGER NOT NULL DEFAULT 1,
    packed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pledges_item ON pledges(item_id);
CREATE INDEX IF NOT EXISTS idx_pledges_person ON pledges(person_id);

CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    person_id INTEGER NOT NULL REFERENCES people(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,
    UNIQUE(item_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_item ON votes(item_id);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL, -- 'item' | 'car'
    target_id INTEGER NOT NULL,
    person_id INTEGER NOT NULL REFERENCES people(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_type, target_id);

CREATE TABLE IF NOT EXISTS cars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    festival_id INTEGER NOT NULL REFERENCES festivals(id),
    driver_person_id INTEGER NOT NULL REFERENCES people(id),
    seats_total INTEGER NOT NULL DEFAULT 1,
    seats_unknown INTEGER NOT NULL DEFAULT 0,
    leaving_from TEXT,
    description TEXT,
    depart_day TEXT,
    depart_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cars_festival ON cars(festival_id);

CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    car_id INTEGER NOT NULL REFERENCES cars(id),
    person_id INTEGER NOT NULL REFERENCES people(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_seats_car ON seats(car_id);
CREATE INDEX IF NOT EXISTS idx_seats_person ON seats(person_id);

CREATE TABLE IF NOT EXISTS checklist_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    festival_id INTEGER NOT NULL REFERENCES festivals(id),
    label TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_checklist_tasks_festival ON checklist_tasks(festival_id);

CREATE TABLE IF NOT EXISTS checklist_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES checklist_tasks(id),
    person_id INTEGER NOT NULL REFERENCES people(id),
    checked_at TEXT NOT NULL DEFAULT (datetime('now')),
    unchecked_at TEXT,
    UNIQUE(task_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_checklist_checks_task ON checklist_checks(task_id);

CREATE TABLE IF NOT EXISTS emoji_cache (
    normalized_name TEXT PRIMARY KEY,
    emoji TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Site-wide feedback (start menu → send feedback). Not tied to a festival;
-- person_id is null for anonymous reports, name is a display-name snapshot.
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER REFERENCES people(id),
    name TEXT,
    body TEXT NOT NULL,
    page TEXT, -- path they were on when they filed it (like a crash report's context)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

-- Monthly third-party API budget (migration 008) — see src/lib/budget.js.
CREATE TABLE IF NOT EXISTS api_usage (
    period TEXT NOT NULL, -- 'YYYY-MM'
    api TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (period, api)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    festival_id INTEGER REFERENCES festivals(id),
    person_id INTEGER REFERENCES people(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    before_json TEXT,
    after_json TEXT,
    -- Ordered list of cell-level changes the action made (migration 005). The
    -- generic undo engine (src/lib/effects.js) reverts/reapplies from this; older
    -- rows without it fall back to the legacy before/after interpreter.
    effects_json TEXT,
    summary TEXT NOT NULL,
    reversible INTEGER NOT NULL DEFAULT 0,
    undone_at TEXT,
    undo_of_id INTEGER REFERENCES audit_log(id),
    ip TEXT,
    geo_city TEXT,
    geo_country TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_festival ON audit_log(festival_id, created_at);

CREATE TABLE IF NOT EXISTS name_reclaim_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id),
    reclaimed_ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
