// Every mutation goes through here. Soft deletes only; undo is itself audited.

export async function logAction(c, { festivalId = null, action, entityType, entityId = null, before = null, after = null, summary, reversible = false }) {
    const db = c.env.DB;
    const person = c.get('person');
    const meta = c.get('reqMeta') || { ip: '', city: '', country: '', userAgent: '' };

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

// Table -> which column marks a soft delete, for generic undo of deletes.
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

export async function undoAction(c, auditId) {
    const db = c.env.DB;
    const entry = await db.prepare('SELECT * FROM audit_log WHERE id = ?').bind(auditId).first();
    if (!entry) return { error: 'not_found' };
    if (!entry.reversible) return { error: 'not_reversible' };
    if (entry.undone_at) return { error: 'already_undone' };

    const before = entry.before_json ? JSON.parse(entry.before_json) : null;
    const after = entry.after_json ? JSON.parse(entry.after_json) : null;

    if (entry.action === 'delete') {
        const col = SOFT_DELETE_TABLES[entry.entity_type];
        if (col) {
            await db.prepare(`UPDATE ${entry.entity_type} SET ${col} = NULL WHERE id = ?`).bind(entry.entity_id).run();
        }
    } else if (entry.action === 'bail') {
        // Restore membership (un-bail) — pledges/seats stay released, that's fine, they were unclaimed anyway.
        await db.prepare('UPDATE memberships SET bailed_at = NULL WHERE id = ?').bind(entry.entity_id).run();
    } else if (entry.action === 'update' && before) {
        const cols = Object.keys(before).filter((k) => k !== 'id');
        if (cols.length) {
            const setClause = cols.map((k) => `${k} = ?`).join(', ');
            await db.prepare(`UPDATE ${entry.entity_type} SET ${setClause} WHERE id = ?`)
                .bind(...cols.map((k) => before[k]), entry.entity_id).run();
        }
    } else if (entry.action === 'create') {
        // Undo a create = soft delete it (or hard delete for tables without soft-delete, e.g. checklist_checks/votes toggle).
        const col = SOFT_DELETE_TABLES[entry.entity_type];
        if (col) {
            await db.prepare(`UPDATE ${entry.entity_type} SET ${col} = datetime('now') WHERE id = ?`).bind(entry.entity_id).run();
        }
    }

    await db.prepare("UPDATE audit_log SET undone_at = datetime('now') WHERE id = ?").bind(auditId).run();

    const person = c.get('person');
    await db.prepare(`
        INSERT INTO audit_log (festival_id, person_id, action, entity_type, entity_id, summary, reversible, undo_of_id)
        VALUES (?, ?, 'undo', ?, ?, ?, 0, ?)
    `).bind(entry.festival_id, person ? person.id : null, entry.entity_type, entry.entity_id,
        `${person ? person.display_name : 'someone'} undid: ${entry.summary}`, auditId).run();

    return { success: true, festivalId: entry.festival_id };
}
