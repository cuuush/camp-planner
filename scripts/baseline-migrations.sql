-- Bring wrangler's migration bookkeeping (the d1_migrations table that
-- `wrangler d1 migrations apply` reads) up to date with migrations that were
-- applied BY HAND before deploys were automated — otherwise the first CI run
-- would try to re-apply them and die (002's ALTER TABLEs aren't re-runnable).
-- INSERT OR IGNORE makes this safe to run on every deploy.
--
-- When a new migration lands here manually before CI gets to it, add its
-- filename below. Migrations applied by CI record themselves.
CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('002_placeholders.sql');
