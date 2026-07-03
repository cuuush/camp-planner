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
