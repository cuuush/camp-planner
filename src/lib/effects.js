// The effects engine — one uniform, guarded, atomic mechanism for undo/redo.
//
// Every reversible action records, at write time, the exact ordered list of
// cell-level changes it made ("effects"). One effect = one cell of one row:
//
//   { "t": "pledges", "id": 1, "col": "deleted_at", "from": null, "to": "2026-07-04 13:55:42" }
//
// `from` is the value the cell held before the action; `to` after. To REVERT we
// write `from` (where the cell still equals `to`); to REAPPLY we write `to` (where
// it still equals `from`). This generalizes the old person-delete manifest to
// every action, and — being cell-precise and guarded — fixes the whole family of
// "one soft-delete bit, many independent owners" interleaving bugs (UNDO_PLAN G12).

// Which column marks a soft delete / release, per table. Used by the create/delete
// effect builders so a "create" and a "delete" are the same cell moving opposite ways.
export const SOFT_DELETE_COL = {
    items: 'deleted_at',
    pledges: 'deleted_at',
    votes: 'deleted_at',
    comments: 'deleted_at',
    cars: 'deleted_at',
    seats: 'deleted_at',
    checklist_tasks: 'deleted_at',
    festivals: 'deleted_at',
    people: 'deleted_at',
    memberships: 'bailed_at',
    checklist_checks: 'unchecked_at',
};

// Every table/column the engine is allowed to touch. Effects are our own data, but
// they live as JSON in the DB forever — validate before interpolating into SQL so a
// corrupt or hand-edited row can never turn into an injection or a wild write.
const WRITABLE = {
    pledges: ['deleted_at', 'qty', 'person_id'],
    votes: ['deleted_at', 'person_id'],
    comments: ['deleted_at', 'person_id'],
    cars: ['deleted_at', 'seats_total', 'seats_unknown', 'leaving_from', 'description', 'depart_day', 'depart_time', 'driver_person_id'],
    seats: ['deleted_at', 'person_id'],
    checklist_tasks: ['deleted_at'],
    checklist_checks: ['unchecked_at', 'checked_at', 'person_id'],
    festivals: ['deleted_at', 'name', 'blurb', 'start_date', 'end_date', 'location', 'ticket_url', 'parking_url', 'created_by'],
    items: ['deleted_at', 'name', 'emoji', 'needed_qty', 'unit', 'description', 'added_by'],
    memberships: ['bailed_at', 'person_id'],
    people: ['deleted_at', 'merged_into'],
    name_reclaim_log: ['person_id'],
};

// Tables where UN-HIDING a soft-deleted row (deleted_at non-null → null) could
// create a second active row the app forbids. Value = the natural-key columns that
// must stay unique among active (deleted_at IS NULL) rows. A pledge route already
// refuses a second live pledge by one person on one item; undo must honor the same
// rule so restoring an old delete can't smuggle a duplicate past it (G3). (votes and
// checklist_checks have real UNIQUE constraints and toggle-reuse their rows, so they
// self-guard and are deliberately absent.)
const UNHIDE_GUARD = {
    pledges: ['item_id', 'person_id'],
    seats: ['car_id', 'person_id'],
};

// SQLite's datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC). We generate the
// stamp in JS so the SAME value goes into both the row and the effect — the revert
// guard compares the cell against the effect's `to`, so they must match exactly.
export function sqlNow() {
    return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// Loose cell equality: null/undefined are interchangeable "empty"; everything else
// compares by string form (SQLite hands back ints for qty, strings for timestamps;
// JSON round-trips numbers and strings — String() collapses the two views).
function cellEquals(a, b) {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    return String(a) === String(b);
}

// --- effect builders (used at emission sites next to logAction) ------------------

// A CREATE: the row is active now; undo hides it, redo brings it back. `stamp` is
// the value undo will write into the soft-delete column (any consistent non-null).
export function createEffect(t, id, stamp) {
    return { t, id, col: SOFT_DELETE_COL[t], from: stamp, to: null };
}

// A DELETE / soft-hide: undo un-hides, redo re-hides. `stamp` MUST be the exact
// value the action wrote into the row's soft-delete column.
export function deleteEffect(t, id, stamp) {
    return { t, id, col: SOFT_DELETE_COL[t], from: null, to: stamp };
}

// An UPDATE: one effect per CHANGED column only — so undoing an old edit reverts
// just the fields that edit touched, never blind-clobbering a newer edit (G5).
export function fieldEffects(t, id, before, after) {
    const out = [];
    for (const k of Object.keys(after)) {
        if (!cellEquals(before[k], after[k])) {
            out.push({ t, id, col: k, from: before[k] ?? null, to: after[k] ?? null });
        }
    }
    return out;
}

// --- the engine ------------------------------------------------------------------

async function hasDuplicateActive(db, t, id, keyCols) {
    // Read this row's natural-key values, then look for ANOTHER active row sharing
    // them. Used only when we're about to un-hide, to refuse forbidden duplicates.
    const self = await db.prepare(`SELECT ${keyCols.join(', ')} FROM ${t} WHERE id = ?`).bind(id).first();
    if (!self) return false;
    const where = keyCols.map((c) => `${c} = ?`).join(' AND ');
    const dup = await db.prepare(`SELECT 1 FROM ${t} WHERE ${where} AND deleted_at IS NULL AND id != ?`)
        .bind(...keyCols.map((c) => self[c]), id).first();
    return !!dup;
}

// Plan the application of an effects list in a direction ('revert' | 'reapply').
// Pre-reads every guard, then returns the surviving UPDATE statements (for the
// caller to run inside ONE db.batch with its own bookkeeping writes) plus an honest
// list of what it skipped and why. Revert walks the list backwards so effects that
// depend on order (a merge's reassign-then-hide) come apart cleanly.
export async function planEffects(db, effects, direction) {
    const list = direction === 'revert' ? [...(effects || [])].reverse() : (effects || []);
    const statements = [];
    const applied = [];
    const skipped = [];

    for (const e of list) {
        // Defensive: never interpolate a table/column we don't recognize.
        if (!WRITABLE[e.t] || !WRITABLE[e.t].includes(e.col)) {
            skipped.push({ effect: e, reason: 'invalid' });
            continue;
        }
        const target = direction === 'revert' ? e.from : e.to; // value to write
        const expect = direction === 'revert' ? e.to : e.from;  // value the cell must still hold

        const row = await db.prepare(`SELECT ${e.col} AS val FROM ${e.t} WHERE id = ?`).bind(e.id).first();
        if (!row) { skipped.push({ effect: e, reason: 'row_missing' }); continue; }

        // Guard: if the cell no longer holds what this action left, a newer action
        // owns it now — leave it alone rather than clobber (G5/G12).
        if (!cellEquals(row.val, expect)) { skipped.push({ effect: e, reason: 'changed_since' }); continue; }

        // Domain guard: refuse to un-hide a soft-deleted row into a duplicate the app
        // forbids (e.g. two live pledges by one person on one item — G3).
        const guardKeys = UNHIDE_GUARD[e.t];
        if (guardKeys && e.col === 'deleted_at' && expect != null && target == null) {
            if (await hasDuplicateActive(db, e.t, e.id, guardKeys)) {
                skipped.push({ effect: e, reason: 'duplicate_active' });
                continue;
            }
        }

        statements.push(db.prepare(`UPDATE ${e.t} SET ${e.col} = ? WHERE id = ?`).bind(target, e.id));
        applied.push(e);
    }
    return { statements, applied, skipped };
}

// Turn a skipped list into one honest, XP-voiced sentence — or null if nothing was
// skipped. Leads with the dominant reason; the UI shows it in a message dialog.
export function summarizeSkipped(skipped) {
    if (!skipped || !skipped.length) return null;
    const reasonText = {
        changed_since: 'were changed since this action',
        row_missing: 'no longer exist',
        duplicate_active: 'would duplicate something that is already there',
        invalid: 'could not be read',
    };
    const counts = {};
    for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1;
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const n = skipped.length;
    const thing = n === 1 ? '1 change' : `${n} changes`;
    return `${thing} could not be undone because they ${reasonText[top] || 'could not be applied'}. The rest of the action was undone.`;
}
