import { normalizeName } from './names.js';
import { randomToken } from './tokens.js';
import { ensureMembershipForPerson } from './festival.js';
import { sqlNow } from './effects.js';

// Create a placeholder ("ghost") person — someone added to a fest/car by name who
// hasn't logged in yet. They're a real `people` row (so seats/memberships/etc. can
// FK to them) with is_placeholder=1, a synthetic unique normalized_name (unusable
// for sign-in, never collides), and placeholder_key = normalized display name,
// which a real login later matches on to absorb them. Also joins the fest.
export async function createPlaceholder(c, festivalId, rawName) {
    const db = c.env.DB;
    const name = (rawName || '').toString().trim();
    if (!name) return null;
    const key = normalizeName(name);
    const synthetic = `__ph_${festivalId || 0}_${randomToken(8)}`;
    const result = await db.prepare(
        'INSERT INTO people (normalized_name, display_name, is_placeholder, placeholder_key) VALUES (?, ?, 1, ?)'
    ).bind(synthetic, name, key).run();
    const id = result.meta.last_row_id;
    if (festivalId) await ensureMembershipForPerson(db, festivalId, id);
    return { id, display_name: name, placeholder_key: key };
}

// Merge person `fromId` into person `toId`: reassign every association, deduping
// unique conflicts (`toId` always wins), then delete the `fromId` row. Used both to
// absorb a ghost into a real login AND to fold one real account into another when
// someone accidentally signed in twice — so we reassign EVERY table that FKs to
// people (including sessions / created festivals / added items, which a ghost never
// has but a real duplicate might) and delete the source unconditionally.
export async function mergePeople(db, fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;

    // memberships — UNIQUE(festival_id, person_id). If the real person is already a
    // member of a fest, keep theirs (un-bailing it) and drop the ghost's dup.
    await db.prepare(`UPDATE memberships SET bailed_at = NULL
        WHERE person_id = ? AND festival_id IN (SELECT festival_id FROM memberships WHERE person_id = ? AND bailed_at IS NULL)`).bind(toId, fromId).run();
    await db.prepare(`DELETE FROM memberships
        WHERE person_id = ? AND festival_id IN (SELECT festival_id FROM memberships WHERE person_id = ?)`).bind(fromId, toId).run();
    await db.prepare('UPDATE memberships SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();

    // seats — dedupe within a car (keep the real person's), reassign the rest.
    await db.prepare(`DELETE FROM seats
        WHERE person_id = ? AND car_id IN (SELECT car_id FROM seats WHERE person_id = ?)`).bind(fromId, toId).run();
    await db.prepare('UPDATE seats SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();

    // checklist_checks — UNIQUE(task_id, person_id). "Checked" wins: if the ghost
    // checked a task the real person left unchecked, flip the real one on; then drop
    // ghost dups and reassign the remainder.
    await db.prepare(`UPDATE checklist_checks SET unchecked_at = NULL, checked_at = datetime('now')
        WHERE person_id = ? AND unchecked_at IS NOT NULL
          AND task_id IN (SELECT task_id FROM checklist_checks WHERE person_id = ? AND unchecked_at IS NULL)`).bind(toId, fromId).run();
    await db.prepare(`DELETE FROM checklist_checks
        WHERE person_id = ? AND task_id IN (SELECT task_id FROM checklist_checks WHERE person_id = ?)`).bind(fromId, toId).run();
    await db.prepare('UPDATE checklist_checks SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();

    // votes — UNIQUE(item_id, person_id): dedupe then reassign.
    await db.prepare(`DELETE FROM votes
        WHERE person_id = ? AND item_id IN (SELECT item_id FROM votes WHERE person_id = ?)`).bind(fromId, toId).run();
    await db.prepare('UPDATE votes SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();

    // No unique constraints on these — plain reassign so the source row has no refs.
    await db.prepare('UPDATE pledges SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();
    await db.prepare('UPDATE comments SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();
    await db.prepare('UPDATE cars SET driver_person_id = ? WHERE driver_person_id = ?').bind(toId, fromId).run();
    await db.prepare('UPDATE name_reclaim_log SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();
    await db.prepare('UPDATE audit_log SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();

    // Real-account-only refs — a ghost never has these, but a duplicate login does.
    // Reassign them too so nothing dangles when we delete the source row below.
    await db.prepare('UPDATE sessions SET person_id = ? WHERE person_id = ?').bind(toId, fromId).run();
    await db.prepare('UPDATE festivals SET created_by = ? WHERE created_by = ?').bind(toId, fromId).run();
    await db.prepare('UPDATE items SET added_by = ? WHERE added_by = ?').bind(toId, fromId).run();

    await db.prepare('DELETE FROM people WHERE id = ?').bind(fromId).run();
}

// --- reversible person deletion ---
//
// "Deleting" a person from a fest doesn't destroy anything — it soft-hides their
// entire footprint (pledges, seats, votes, comments, their car, checklist checks,
// membership) and records a manifest of exactly which rows were flipped. Undo
// restores precisely those rows, so a delete is 100% reversible down to every
// pledge. The manifest lists only rows that were ACTIVE at delete time, so undo
// never resurrects something that was already gone.

export async function purgeFootprint(db, m, stamp) {
    m = m || {};
    // `stamp` lets the caller hide every row with the SAME timestamp it records in
    // the entry's effects, so the undo engine's guard matches exactly. Legacy
    // callers (the pre-effects reapply path) pass none and get datetime('now').
    const s = stamp || (await db.prepare("SELECT datetime('now') AS n").first()).n;
    const soft = async (t, ids) => { for (const id of ids || []) await db.prepare(`UPDATE ${t} SET deleted_at = ? WHERE id = ?`).bind(s, id).run(); };
    await soft('pledges', m.pledges);
    await soft('seats', m.seats);
    await soft('votes', m.votes);
    await soft('comments', m.comments);
    await soft('cars', m.cars);
    for (const id of m.checks || []) await db.prepare('UPDATE checklist_checks SET unchecked_at = ? WHERE id = ?').bind(s, id).run();
    for (const id of m.memberships || []) await db.prepare('UPDATE memberships SET bailed_at = ? WHERE id = ?').bind(s, id).run();
}

// Build the cell-level effects for a footprint hidden with `stamp` — one effect per
// row, matching what purgeFootprint(db, manifest, stamp) actually wrote. Undo walks
// these to un-hide precisely those rows (and only if still hidden by this action).
export function footprintEffects(m, stamp) {
    m = m || {};
    const effects = [];
    const del = (t, ids, col) => { for (const id of ids || []) effects.push({ t, id, col, from: null, to: stamp }); };
    del('pledges', m.pledges, 'deleted_at');
    del('seats', m.seats, 'deleted_at');
    del('votes', m.votes, 'deleted_at');
    del('comments', m.comments, 'deleted_at');
    del('cars', m.cars, 'deleted_at');
    del('checklist_checks', m.checks, 'unchecked_at');
    del('memberships', m.memberships, 'bailed_at');
    return effects;
}

export async function restoreFootprint(db, m) {
    m = m || {};
    const undel = async (t, ids) => { for (const id of ids || []) await db.prepare(`UPDATE ${t} SET deleted_at = NULL WHERE id = ?`).bind(id).run(); };
    await undel('pledges', m.pledges);
    await undel('seats', m.seats);
    await undel('votes', m.votes);
    await undel('comments', m.comments);
    await undel('cars', m.cars);
    for (const id of m.checks || []) await db.prepare('UPDATE checklist_checks SET unchecked_at = NULL WHERE id = ?').bind(id).run();
    for (const id of m.memberships || []) await db.prepare('UPDATE memberships SET bailed_at = NULL WHERE id = ?').bind(id).run();
}

// Collect a person's active footprint within one fest, soft-hide all of it, and
// return the manifest (for a reversible audit entry).
export async function deletePersonFootprint(db, festivalId, personId) {
    const pick = async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results.map((r) => r.id);
    const manifest = {
        pledges: await pick('SELECT p.id FROM pledges p JOIN items i ON i.id = p.item_id WHERE p.person_id = ? AND i.festival_id = ? AND p.deleted_at IS NULL', personId, festivalId),
        seats: await pick('SELECT s.id FROM seats s JOIN cars c ON c.id = s.car_id WHERE s.person_id = ? AND c.festival_id = ? AND s.deleted_at IS NULL', personId, festivalId),
        votes: await pick('SELECT v.id FROM votes v JOIN items i ON i.id = v.item_id WHERE v.person_id = ? AND i.festival_id = ? AND v.deleted_at IS NULL', personId, festivalId),
        comments: await pick(`SELECT id FROM comments WHERE person_id = ? AND deleted_at IS NULL AND (
            (target_type = 'item' AND target_id IN (SELECT id FROM items WHERE festival_id = ?)) OR
            (target_type = 'car' AND target_id IN (SELECT id FROM cars WHERE festival_id = ?)))`, personId, festivalId, festivalId),
        cars: await pick('SELECT id FROM cars WHERE driver_person_id = ? AND festival_id = ? AND deleted_at IS NULL', personId, festivalId),
        checks: await pick('SELECT cc.id FROM checklist_checks cc JOIN checklist_tasks t ON t.id = cc.task_id WHERE cc.person_id = ? AND t.festival_id = ? AND cc.unchecked_at IS NULL', personId, festivalId),
        memberships: await pick('SELECT id FROM memberships WHERE person_id = ? AND festival_id = ? AND bailed_at IS NULL', personId, festivalId),
    };
    // Hide it all with one shared stamp, and return both the manifest (kept in
    // before/after for display + legacy undo) and the matching effects list.
    const stamp = sqlNow();
    await purgeFootprint(db, manifest, stamp);
    return { manifest, effects: footprintEffects(manifest, stamp) };
}

// After a real login, find & merge any placeholders that share this person's name
// (case-insensitive exact match). Returns how many ghosts were absorbed.
export async function absorbPlaceholders(c, personId, normalized) {
    if (!personId || !normalized) return 0;
    const db = c.env.DB;
    const ghosts = (await db.prepare('SELECT id FROM people WHERE is_placeholder = 1 AND placeholder_key = ?').bind(normalized).all()).results;
    for (const g of ghosts) {
        if (g.id !== personId) await mergePeople(db, g.id, personId);
    }
    return ghosts.length;
}
