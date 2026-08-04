export async function loadFestival(c) {
    const id = Number(c.req.param('id'));
    const db = c.env.DB;
    return db.prepare('SELECT * FROM festivals WHERE id = ? AND deleted_at IS NULL').bind(id).first();
}

// The idempotent "counts as going" upsert as a bindable statement, so callers
// can fold it into a db.batch alongside their own writes (one round trip).
export function membershipStatement(db, festivalId, personId, addedBy = null) {
    return db.prepare(`
        INSERT INTO memberships (festival_id, person_id, added_by, joined_at) VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(festival_id, person_id) DO UPDATE SET bailed_at = NULL
    `).bind(festivalId, personId, addedBy || null);
}

// Mark a specific person as "going" to a fest. Idempotent: creates the membership
// if missing, and un-bails it if they'd previously bailed. Used both for the
// signed-in person and for placeholders we add to a car/list on someone's behalf.
export async function ensureMembershipForPerson(db, festivalId, personId, addedBy = null) {
    if (!festivalId || !personId) return;
    await membershipStatement(db, festivalId, personId, addedBy).run();
}

// Mark the signed-in person as "going" to a fest — doing anything on a fest (or
// signing in on its page) counts. No-op when signed out or with no fest.
export async function ensureMembership(c, festivalId) {
    const person = c.get('person');
    if (!person) return;
    await ensureMembershipForPerson(c.env.DB, festivalId, person.id);
}

// Pull the festival id out of a same-site path like "/f/12/stuff" — used to tell
// which fest a sign-in / action belongs to. Null if the path isn't fest-scoped.
export function festIdFromPath(path) {
    const m = (path || '').toString().match(/\/f\/(\d+)(?:\/|$|\?)/);
    return m ? Number(m[1]) : null;
}

// Resolve the fest name for a path (for "you'll be added to <fest>" copy). Null
// if the path isn't fest-scoped or the fest doesn't exist.
export async function festNameFromPath(c, path) {
    const id = festIdFromPath(path);
    if (!id) return null;
    const f = await c.env.DB.prepare('SELECT name FROM festivals WHERE id = ? AND deleted_at IS NULL').bind(id).first();
    return f ? f.name : null;
}

// The names already on this fest's roster, for the sign-in box's pick-a-name list —
// the common case for a sign-in is someone who lost their session, not a newcomer,
// and this saves them retyping (and mistyping, which silently makes a 2nd account).
// Reveals nothing new: the People tab on a fest is already public to anyone with
// the link. Placeholders (manually-added ghosts) are included too — picking one
// signs in under that same display name, which absorbPlaceholders() then folds the
// ghost into automatically, so suggesting it is the intended path, not a dead end.
export async function festPeopleFromPath(c, path) {
    const id = festIdFromPath(path);
    if (!id) return [];
    const { results } = await c.env.DB.prepare(`
        SELECT p.display_name FROM people p
        JOIN memberships m ON m.person_id = p.id
        WHERE m.festival_id = ? AND m.bailed_at IS NULL
          AND p.deleted_at IS NULL AND p.merged_into IS NULL
        ORDER BY p.display_name COLLATE NOCASE
    `).bind(id).all();
    return (results || []).map((r) => r.display_name);
}
