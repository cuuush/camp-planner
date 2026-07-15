-- 010: decentralized schedule sharing. Any crew can PUBLISH their hand-corrected
-- schedule as a snapshot; any other crew can ADOPT it (copy into their own fest,
-- then edit and re-publish). There is no central/official master — the "library"
-- is simply everyone's published snapshots. Adopting forks a copy, so a crew's
-- edits never clobber the source publication or other adopters.
CREATE TABLE IF NOT EXISTS schedule_publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,                                  -- e.g. "Elements Music & Arts Festival 2026"
    source_festival_id INTEGER REFERENCES festivals(id), -- the fest it was published from (nullable if later gone)
    published_by INTEGER REFERENCES people(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),  -- bumped when the snapshot is refreshed (re-publish)
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_pub_updated ON schedule_publications(updated_at);

-- Immutable snapshot of a publication's sets, copied at publish time so the registry
-- entry is self-contained (unaffected by later edits to, or deletion of, the source
-- fest). Same shape as schedule_sets minus the per-fest columns.
CREATE TABLE IF NOT EXISTS schedule_publication_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publication_id INTEGER NOT NULL REFERENCES schedule_publications(id),
    day TEXT,
    stage TEXT,
    stage_order INTEGER NOT NULL DEFAULT 0,
    artist TEXT NOT NULL,
    start_min INTEGER,
    end_min INTEGER
);
CREATE INDEX IF NOT EXISTS idx_schedule_pub_sets ON schedule_publication_sets(publication_id);

-- Provenance: which publication a fest's current schedule was adopted from (for a
-- "based on …" note and a future "check for updates"). Nullable — a from-scratch or
-- freshly-imported schedule has no parent.
ALTER TABLE festivals ADD COLUMN schedule_adopted_from INTEGER REFERENCES schedule_publications(id);
