// Every mutation goes through here. Soft deletes only; undo is itself audited —
// and undo-ing an undo (redo) works too, indefinitely back and forth.

import { ensureMembership } from './festival.js';
import { purgeFootprint, restoreFootprint } from './people.js';
import { planEffects, summarizeSkipped } from './effects.js';

export async function logAction(c, { festivalId = null, action, entityType, entityId = null, before = null, after = null, effects = null, summary, reversible = false }) {
    const db = c.env.DB;
    const person = c.get('person');
    const meta = c.get('reqMeta') || { ip: '', city: '', country: '', userAgent: '' };

    // Doing anything on a fest counts you as going — except bailing, which is the
    // one action that must NOT re-add you.
    if (festivalId && person && action !== 'bail') {
        await ensureMembership(c, festivalId);
    }

    const result = await db.prepare(`
        INSERT INTO audit_log
            (festival_id, person_id, action, entity_type, entity_id, before_json, after_json, effects_json, summary, reversible, ip, geo_city, geo_country, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        festivalId,
        person ? person.id : null,
        action,
        entityType,
        entityId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        // effects_json is what the new engine reverts/reapplies from; before/after
        // stay for display and for the legacy interpreter on pre-effects rows.
        effects && effects.length ? JSON.stringify(effects) : null,
        summary,
        reversible ? 1 : 0,
        meta.ip || null,
        meta.city || null,
        meta.country || null,
        meta.userAgent || null,
    ).run();

    return result.meta.last_row_id;
}

// Table -> which column marks a soft delete, for generic revert/reapply of creates/deletes.
const SOFT_DELETE_TABLES = {
    items: 'deleted_at',
    pledges: 'deleted_at',
    votes: 'deleted_at',
    comments: 'deleted_at',
    cars: 'deleted_at',
    seats: 'deleted_at',
    checklist_tasks: 'deleted_at',
    festivals: 'deleted_at',
};

async function revertEffect(db, entry, before) {
    // A person-delete carries a manifest of every row it soft-hid — restore them all.
    if (entry.entity_type === 'people' && entry.action === 'delete') {
        await restoreFootprint(db, before || {});
        return;
    }
    if (entry.action === 'delete') {
        const col = SOFT_DELETE_TABLES[entry.entity_type];
        if (col) await db.prepare(`UPDATE ${entry.entity_type} SET ${col} = NULL WHERE id = ?`).bind(entry.entity_id).run();
    } else if (entry.action === 'create') {
        const col = SOFT_DELETE_TABLES[entry.entity_type];
        if (col) await db.prepare(`UPDATE ${entry.entity_type} SET ${col} = datetime('now') WHERE id = ?`).bind(entry.entity_id).run();
    } else if (entry.action === 'update' && before) {
        const cols = Object.keys(before);
        if (cols.length) {
            const setClause = cols.map((k) => `${k} = ?`).join(', ');
            await db.prepare(`UPDATE ${entry.entity_type} SET ${setClause} WHERE id = ?`)
                .bind(...cols.map((k) => before[k]), entry.entity_id).run();
        }
    } else if (entry.action === 'bail') {
        await db.prepare('UPDATE memberships SET bailed_at = NULL WHERE id = ?').bind(entry.entity_id).run();
    }
}

async function reapplyEffect(db, entry, after) {
    // Redo a person-delete: re-hide the same footprint.
    if (entry.entity_type === 'people' && entry.action === 'delete') {
        await purgeFootprint(db, after || {});
        return;
    }
    if (entry.action === 'delete') {
        const col = SOFT_DELETE_TABLES[entry.entity_type];
        if (col) await db.prepare(`UPDATE ${entry.entity_type} SET ${col} = datetime('now') WHERE id = ?`).bind(entry.entity_id).run();
    } else if (entry.action === 'create') {
        const col = SOFT_DELETE_TABLES[entry.entity_type];
        if (col) await db.prepare(`UPDATE ${entry.entity_type} SET ${col} = NULL WHERE id = ?`).bind(entry.entity_id).run();
    } else if (entry.action === 'update' && after) {
        const cols = Object.keys(after);
        if (cols.length) {
            const setClause = cols.map((k) => `${k} = ?`).join(', ');
            await db.prepare(`UPDATE ${entry.entity_type} SET ${setClause} WHERE id = ?`)
                .bind(...cols.map((k) => after[k]), entry.entity_id).run();
        }
    } else if (entry.action === 'bail') {
        await db.prepare("UPDATE memberships SET bailed_at = datetime('now') WHERE id = ?").bind(entry.entity_id).run();
    }
}

export async function undoAction(c, auditId, expectedFestivalId = null) {
    const db = c.env.DB;
    const clicked = await db.prepare('SELECT * FROM audit_log WHERE id = ?').bind(auditId).first();
    if (!clicked) return { error: 'not_found' };
    // An entry may only be undone through its own festival's log (G6). Without this,
    // any signed-in user could POST /f/<any>/log/<id>/undo and toggle another fest's
    // action. Callers pass the URL's festival id; we refuse a mismatch.
    if (expectedFestivalId != null && clicked.festival_id !== expectedFestivalId) return { error: 'wrong_festival' };
    if (!clicked.reversible) return { error: 'not_reversible' };

    // If they clicked an "undo" row, we're toggling the ORIGINAL entry it points to
    // (this is what makes undo-ing an undo work — it just redoes the original).
    // Clicking an "undo" row toggles the ORIGINAL entry it points to — that's what
    // makes redo-of-undo work indefinitely. This toggle design is intentional.
    const orig = clicked.action === 'undo'
        ? await db.prepare('SELECT * FROM audit_log WHERE id = ?').bind(clicked.undo_of_id).first()
        : clicked;
    if (!orig) return { error: 'not_found' };

    const wasReverted = !!orig.undone_at;
    const person = c.get('person');
    const verb = wasReverted ? 'redid' : 'undid';

    // Modern path: the entry carries a cell-level effects list → drive the generic
    // engine. Everything (the effect UPDATEs, the flag flip, the spent-row mark, and
    // the fresh undo entry) goes into ONE db.batch so a mid-way failure can't leave
    // half-applied state that no log entry describes (G11). Guards are pre-read
    // before the batch; D1 serializes writes, so the TOCTOU window is negligible here.
    if (orig.effects_json) {
        const effects = JSON.parse(orig.effects_json);
        const direction = wasReverted ? 'reapply' : 'revert';
        const { statements, skipped } = await planEffects(db, effects, direction);
        const skippedMessage = summarizeSkipped(skipped);

        const batch = [];
        // Idempotent flag flip first: guarding on the current state makes a double
        // submit a no-op instead of a second toggle (Phase 4).
        batch.push(wasReverted
            ? db.prepare('UPDATE audit_log SET undone_at = NULL WHERE id = ? AND undone_at IS NOT NULL').bind(orig.id)
            : db.prepare("UPDATE audit_log SET undone_at = datetime('now') WHERE id = ? AND undone_at IS NULL").bind(orig.id));
        batch.push(...statements);
        // The clicked row is now "spent" so its own button disappears; the fresh
        // toggle entry below becomes the next clickable thing.
        if (clicked.id !== orig.id) {
            batch.push(db.prepare("UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?").bind(clicked.id));
        }
        batch.push(db.prepare(`
            INSERT INTO audit_log (festival_id, person_id, action, entity_type, entity_id, summary, reversible, undo_of_id, after_json)
            VALUES (?, ?, 'undo', ?, ?, ?, 1, ?, ?)
        `).bind(orig.festival_id, person ? person.id : null, orig.entity_type, orig.entity_id,
            `${person ? person.display_name : 'someone'} ${verb}: ${orig.summary}`, orig.id,
            // Stash the partial-restore note on the undo entry so the log can hint it.
            skippedMessage ? JSON.stringify({ skipped: skippedMessage }) : null));

        await db.batch(batch);
        return { success: true, festivalId: orig.festival_id, skippedMessage };
    }

    // Legacy path: pre-effects rows (prod has them forever) — the original
    // before/after + manifest interpreter, unchanged.
    const before = orig.before_json ? JSON.parse(orig.before_json) : null;
    const after = orig.after_json ? JSON.parse(orig.after_json) : null;

    if (wasReverted) {
        await reapplyEffect(db, orig, after);
        await db.prepare('UPDATE audit_log SET undone_at = NULL WHERE id = ?').bind(orig.id).run();
    } else {
        await revertEffect(db, orig, before);
        await db.prepare("UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?").bind(orig.id).run();
    }

    if (clicked.id !== orig.id) {
        await db.prepare("UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?").bind(clicked.id).run();
    }

    await db.prepare(`
        INSERT INTO audit_log (festival_id, person_id, action, entity_type, entity_id, summary, reversible, undo_of_id)
        VALUES (?, ?, 'undo', ?, ?, ?, 1, ?)
    `).bind(orig.festival_id, person ? person.id : null, orig.entity_type, orig.entity_id,
        `${person ? person.display_name : 'someone'} ${verb}: ${orig.summary}`, orig.id).run();

    return { success: true, festivalId: orig.festival_id };
}
