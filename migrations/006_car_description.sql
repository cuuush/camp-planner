-- 006: a free-text description for cars (planning notes — "might have room for
-- gear", "not 100% confirmed yet", etc.) and a flag for when the seat count isn't
-- known yet. Both additive so old rows keep working. seats_unknown lets us post a
-- car for a maybe-driver who hasn't logged in: capacity shows "idk" instead of a
-- made-up number, and they can fill it in later. seats_total stays NOT NULL (we
-- keep a harmless placeholder in it); seats_unknown=1 just means "ignore it".
ALTER TABLE cars ADD COLUMN description TEXT;
ALTER TABLE cars ADD COLUMN seats_unknown INTEGER NOT NULL DEFAULT 0;
