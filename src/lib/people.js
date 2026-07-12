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

// Merge person `fromId` into `toId`, fully reversibly. Used both to absorb a ghost
// into a real login AND to fold one real account into another (accidental double
// sign-in). Returns the ordered effects array — callers log it so the merge undoes
// cleanly (a true un-merge, splitting the two people apart again). Nothing is
// destroyed: unique-key dupes on the source are soft-hidden (never DELETEd),
// everything else is reassigned, and the source person row is soft-deleted with a
// merged_into pointer. The only hard delete is the source's ephemeral sessions —
// credentials, not undo-domain state — so the merged-away device can't become the
// survivor (G7); on un-merge that person just signs in again.
//
// Deliberately NOT touched: audit_log.person_id keeps true attribution forever
// (rewriting it is what made the old merge un-reconstructable, G1).

// One table with a UNIQUE/natural key: dedupe against the target, promote the target
// where "yes wins", reassign the rest. Collects prepared statements (run later as one
// batch) and the matching effects. `key` are the columns (besides personCol) that
// must stay unique among active rows; `softCol` marks a soft-hidden dup; `promote`
// returns target-side cell changes to apply when a live source outranks the target.
async function mergeUniqueTable(db, { table, personCol = 'person_id', key, softCol, fromId, toId, stamp, promote }, stmts, effects) {
    const rows = (await db.prepare(`SELECT * FROM ${table} WHERE ${personCol} = ?`).bind(fromId).all()).results;
    for (const row of rows) {
        const where = key.map((c) => `${c} = ?`).join(' AND ');
        const target = await db.prepare(`SELECT * FROM ${table} WHERE ${personCol} = ? AND ${where}`)
            .bind(toId, ...key.map((c) => row[c])).first();
        if (target) {
            // Dup on this key. Promote the target first (checked-wins / un-bail), then
            // soft-hide the source's dup — keeping person_id on the source so un-merge
            // can find and un-hide it. Leave an already-hidden source dup alone.
            for (const chg of (promote ? promote(row, target) : [])) {
                stmts.push(db.prepare(`UPDATE ${table} SET ${chg.col} = ? WHERE id = ?`).bind(chg.to, target.id));
                effects.push({ t: table, id: target.id, col: chg.col, from: chg.from, to: chg.to });
            }
            if (row[softCol] == null) {
                stmts.push(db.prepare(`UPDATE ${table} SET ${softCol} = ? WHERE id = ?`).bind(stamp, row.id));
                effects.push({ t: table, id: row.id, col: softCol, from: null, to: stamp });
            }
        } else {
            stmts.push(db.prepare(`UPDATE ${table} SET ${personCol} = ? WHERE id = ?`).bind(toId, row.id));
            effects.push({ t: table, id: row.id, col: personCol, from: fromId, to: toId });
        }
    }
}

// A table with no unique constraint on the person — reassign every row wholesale.
async function reassignAll(db, table, col, fromId, toId, stmts, effects) {
    const rows = (await db.prepare(`SELECT id FROM ${table} WHERE ${col} = ?`).bind(fromId).all()).results;
    for (const r of rows) {
        stmts.push(db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).bind(toId, r.id));
        effects.push({ t: table, id: r.id, col, from: fromId, to: toId });
    }
}

export async function mergePeople(db, fromId, toId) {
    if (!fromId || !toId || fromId === toId) return [];
    const stmts = [];
    const effects = [];
    const stamp = sqlNow();

    // memberships — UNIQUE(festival_id, person_id). If both are in a fest and the
    // target had bailed while the source is active, un-bail the target (they're going).
    await mergeUniqueTable(db, {
        table: 'memberships', key: ['festival_id'], softCol: 'bailed_at', fromId, toId, stamp,
        promote: (src, tgt) => (src.bailed_at == null && tgt.bailed_at != null)
            ? [{ col: 'bailed_at', from: tgt.bailed_at, to: null }] : [],
    }, stmts, effects);

    // seats — natural key car_id+person_id; keep the target's, hide the source's dup.
    await mergeUniqueTable(db, { table: 'seats', key: ['car_id'], softCol: 'deleted_at', fromId, toId, stamp }, stmts, effects);

    // checklist_checks — UNIQUE(task_id, person_id). "Checked" wins: if the source
    // checked a task the target left unchecked, flip the target on before hiding.
    await mergeUniqueTable(db, {
        table: 'checklist_checks', key: ['task_id'], softCol: 'unchecked_at', fromId, toId, stamp,
        promote: (src, tgt) => (src.unchecked_at == null && tgt.unchecked_at != null)
            ? [{ col: 'unchecked_at', from: tgt.unchecked_at, to: null }, { col: 'checked_at', from: tgt.checked_at, to: stamp }] : [],
    }, stmts, effects);

    // votes — UNIQUE(item_id, person_id): dedupe then reassign.
    await mergeUniqueTable(db, { table: 'votes', key: ['item_id'], softCol: 'deleted_at', fromId, toId, stamp }, stmts, effects);

    // No unique constraint on these — plain reassign so the source row has no live refs.
    await reassignAll(db, 'pledges', 'person_id', fromId, toId, stmts, effects);
    await reassignAll(db, 'comments', 'person_id', fromId, toId, stmts, effects);
    await reassignAll(db, 'cars', 'driver_person_id', fromId, toId, stmts, effects);
    await reassignAll(db, 'name_reclaim_log', 'person_id', fromId, toId, stmts, effects);
    await reassignAll(db, 'festivals', 'created_by', fromId, toId, stmts, effects);
    await reassignAll(db, 'items', 'added_by', fromId, toId, stmts, effects);

    // The source person row: soft-delete + point at the survivor. No DELETE.
    stmts.push(db.prepare('UPDATE people SET deleted_at = ?, merged_into = ? WHERE id = ?').bind(stamp, toId, fromId));
    effects.push({ t: 'people', id: fromId, col: 'deleted_at', from: null, to: stamp });
    effects.push({ t: 'people', id: fromId, col: 'merged_into', from: null, to: toId });

    // One transaction for every reversible write (G11). Guards read pre-merge state
    // above; each source row maps to a distinct target key, so the decisions don't
    // interfere and are safe to apply together.
    if (stmts.length) await db.batch(stmts);

    // Sessions are not undo-domain state — drop the source's outside the batch so the
    // merged-away device can't act as the survivor.
    await db.prepare('DELETE FROM sessions WHERE person_id = ?').bind(fromId).run();

    return effects;
}

// Follow a merged_into chain to the surviving, un-merged person. After a merge the
// source asserts "this is the same human", so honoring their name at sign-in means
// landing on the survivor. After an un-merge the pointer is nulled, so the name
// naturally belongs to the restored person again. Loop-guarded against cycles.
export async function resolveMergedPerson(db, person) {
    let p = person;
    const seen = new Set();
    while (p && p.merged_into && !seen.has(p.id)) {
        seen.add(p.id);
        const next = await db.prepare('SELECT * FROM people WHERE id = ?').bind(p.merged_into).first();
        if (!next) break;
        p = next;
    }
    return p;
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
// (case-insensitive exact match). Name-matching stays global across fests — that's
// the documented "pre-added people" behavior — but a ghost that's already merged
// away (deleted_at) or was deliberately removed from its fest (no active membership
// anywhere) is DEAD and must not silently glue itself to whoever signs in with that
// name later (G8). Returns the merges performed (effects + summary) so the caller
// can log each as a reversible audit entry — kept out of this module to avoid an
// import cycle with audit.js.
export async function absorbPlaceholders(c, personId, normalized) {
    if (!personId || !normalized) return [];
    const db = c.env.DB;
    const ghosts = (await db.prepare('SELECT * FROM people WHERE is_placeholder = 1 AND placeholder_key = ? AND deleted_at IS NULL').bind(normalized).all()).results;
    const merges = [];
    for (const g of ghosts) {
        if (g.id === personId) continue;
        const liveFest = await db.prepare('SELECT festival_id FROM memberships WHERE person_id = ? AND bailed_at IS NULL LIMIT 1').bind(g.id).first();
        if (!liveFest) continue; // dead ghost — leave it be
        const effects = await mergePeople(db, g.id, personId);
        merges.push({
            festivalId: liveFest.festival_id,
            effects,
            summary: `${g.display_name} logged on. Replaced manually created user`,
        });
    }
    return merges;
}
