// Every mutation goes through here. Soft deletes only; undo is itself audited —
// and undo-ing an undo (redo) works too, indefinitely back and forth.

import { ensureMembership } from './festival.js';
import { purgeFootprint, restoreFootprint } from './people.js';

export async function logAction(c, { festivalId = null, action, entityType, entityId = null, before = null, after = null, summary, reversible = false }) {
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
            (festival_id, person_id, action, entity_type, entity_id, before_json, after_json, summary, reversible, ip, geo_city, geo_country, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        festivalId,
        person ? person.id : null,
        action,
        entityType,
        entityId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
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

export async function undoAction(c, auditId) {
    const db = c.env.DB;
    const clicked = await db.prepare('SELECT * FROM audit_log WHERE id = ?').bind(auditId).first();
    if (!clicked) return { error: 'not_found' };
    if (!clicked.reversible) return { error: 'not_reversible' };

    // If they clicked an "undo" row, we're toggling the ORIGINAL entry it points to
    // (this is what makes undo-ing an undo work — it just redoes the original).
    const orig = clicked.action === 'undo'
        ? await db.prepare('SELECT * FROM audit_log WHERE id = ?').bind(clicked.undo_of_id).first()
        : clicked;
    if (!orig) return { error: 'not_found' };

    const wasReverted = !!orig.undone_at;
    const before = orig.before_json ? JSON.parse(orig.before_json) : null;
    const after = orig.after_json ? JSON.parse(orig.after_json) : null;

    if (wasReverted) {
        await reapplyEffect(db, orig, after);
        await db.prepare('UPDATE audit_log SET undone_at = NULL WHERE id = ?').bind(orig.id).run();
    } else {
        await revertEffect(db, orig, before);
        await db.prepare("UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?").bind(orig.id).run();
    }

    // The row they clicked is now "spent" so its own button disappears — a fresh
    // toggle entry (below) takes over as the next thing that can be clicked.
    if (clicked.id !== orig.id) {
        await db.prepare("UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?").bind(clicked.id).run();
    }

    const person = c.get('person');
    const verb = wasReverted ? 'redid' : 'undid';
    await db.prepare(`
        INSERT INTO audit_log (festival_id, person_id, action, entity_type, entity_id, summary, reversible, undo_of_id)
        VALUES (?, ?, 'undo', ?, ?, ?, 1, ?)
    `).bind(orig.festival_id, person ? person.id : null, orig.entity_type, orig.entity_id,
        `${person ? person.display_name : 'someone'} ${verb}: ${orig.summary}`, orig.id).run();

    return { success: true, festivalId: orig.festival_id };
}
