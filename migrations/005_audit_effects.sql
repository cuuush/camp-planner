-- 005: cell-level "effects" for the generic undo engine. Every reversible action
-- records, at write time, the exact ordered list of cell changes it made — see
-- src/lib/effects.js. effects_json is purely additive: before_json / after_json
-- stay exactly as they were (old prod rows depend on them, and they're still used
-- for display and by the legacy interpreter that handles pre-effects entries).
ALTER TABLE audit_log ADD COLUMN effects_json TEXT;
