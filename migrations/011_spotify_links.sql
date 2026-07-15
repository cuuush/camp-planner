-- 011: the Schedule tab's "Play on Spotify" button.
--
-- Resolving an artist to a Spotify page costs an API round-trip, so the first
-- person to tap the button pays for it and everyone after reads this cache — the
-- link is a property of the ARTIST, not of a fest, so it's keyed globally by a
-- normalized name ("NEEK.O" / "neek.o" / "Neek O" → "neeko") and shared across
-- every camp. Same shape and reasoning as emoji_cache.
--
-- A miss is cached too (url IS NULL): "this artist isn't on Spotify under that
-- name" is a deterministic answer, not a flaky one, so re-asking every tap would
-- just burn calls. Correcting the artist's spelling changes the normalized key,
-- which re-searches for free.
--
-- Not soft-deleted / not audited: plumbing, not user data.
CREATE TABLE IF NOT EXISTS spotify_links (
    normalized_artist TEXT PRIMARY KEY,
    url TEXT,                                 -- open.spotify.com artist page, or NULL for a cached miss
    label TEXT,                               -- Spotify's own spelling of the name, for display
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
