// Schedule mutations that write rows: importing parsed sets into a fest, and the
// decentralized publish / adopt sharing (migration 010). Kept apart from the read +
// format helpers in schedule.js. Callers wrap these in logAction with the effects
// returned here so every change stays undoable — and must generate the `stamp`
// (sqlNow()) ONCE and pass it in, so soft-delete stamps match their effects exactly.

// Replace a fest's sets for one day with a fresh list (soft-deleting the old ones
// so a re-import is undoable), then insert the new sets. Returns the cleared and
// inserted ids for the caller's effects. `sets` are { stage, stage_order, artist,
// start_min, end_min } rows (from the parser or the preview).
export async function replaceDaySets(db, { festivalId, day, sets, personId, stamp }) {
    const dayKey = day || '';
    const existing = (await db.prepare(
        "SELECT id FROM schedule_sets WHERE festival_id = ? AND COALESCE(day, '') = ? AND deleted_at IS NULL"
    ).bind(festivalId, dayKey).all()).results;
    if (existing.length) {
        await db.batch(existing.map((e) => db.prepare('UPDATE schedule_sets SET deleted_at = ? WHERE id = ?').bind(stamp, e.id)));
    }
    // One batch, not one call per set. Every D1 call is a subrequest, and the Workers
    // Free plan allows 50 per invocation — a 37-set day inserted in a loop spends 37
    // of them on its own and leaves nothing for the rest of the request. batch() is
    // also a transaction, so a half-written day can't survive a failure. Each result
    // carries its own meta.last_row_id, in statement order.
    const inserted = sets.length
        ? await db.batch(sets.map((s) => db.prepare(`
            INSERT INTO schedule_sets (festival_id, day, stage, stage_order, artist, start_min, end_min, added_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(festivalId, day || null, s.stage || null, s.stage_order ?? 0, s.artist, s.start_min ?? null, s.end_min ?? null, personId || null)))
        : [];
    return { clearedIds: existing.map((e) => e.id), insertedIds: inserted.map((r) => r.meta.last_row_id) };
}

// Snapshot a fest's current schedule into the shared registry. One publication per
// source fest — re-publishing refreshes that entry's snapshot instead of piling up
// duplicates. The snapshot is a copy, so later edits to (or deletion of) the source
// fest don't change what adopters already took. Returns the publication id, or null
// if the fest has no sets to share.
export async function publishSchedule(db, { festivalId, title, personId }) {
    const sets = (await db.prepare(
        'SELECT day, stage, stage_order, artist, start_min, end_min FROM schedule_sets WHERE festival_id = ? AND deleted_at IS NULL ORDER BY stage_order, start_min'
    ).bind(festivalId).all()).results;
    if (!sets.length) return null;

    const existing = await db.prepare('SELECT id FROM schedule_publications WHERE source_festival_id = ? AND deleted_at IS NULL').bind(festivalId).first();
    let pubId;
    if (existing) {
        pubId = existing.id;
        await db.prepare("UPDATE schedule_publications SET title = ?, published_by = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(title, personId || null, pubId).run();
        await db.prepare('DELETE FROM schedule_publication_sets WHERE publication_id = ?').bind(pubId).run();
    } else {
        const res = await db.prepare('INSERT INTO schedule_publications (title, source_festival_id, published_by) VALUES (?, ?, ?)')
            .bind(title, festivalId, personId || null).run();
        pubId = res.meta.last_row_id;
    }
    for (const s of sets) {
        await db.prepare('INSERT INTO schedule_publication_sets (publication_id, day, stage, stage_order, artist, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(pubId, s.day, s.stage, s.stage_order, s.artist, s.start_min, s.end_min).run();
    }
    return pubId;
}

// Fork a publication's snapshot into a fest as its live, editable schedule —
// replacing whatever schedule it currently has (soft-deleted, so it's undoable).
// Records provenance on the fest. Returns cleared + inserted ids for the caller's
// effects, plus the set count.
export async function adoptPublication(db, { festivalId, publicationId, personId, stamp }) {
    const snap = (await db.prepare(
        'SELECT day, stage, stage_order, artist, start_min, end_min FROM schedule_publication_sets WHERE publication_id = ? ORDER BY stage_order, start_min'
    ).bind(publicationId).all()).results;
    if (!snap.length) return { clearedIds: [], insertedIds: [] };

    const existing = (await db.prepare('SELECT id FROM schedule_sets WHERE festival_id = ? AND deleted_at IS NULL').bind(festivalId).all()).results;
    if (existing.length) {
        await db.batch(existing.map((e) => db.prepare('UPDATE schedule_sets SET deleted_at = ? WHERE id = ?').bind(stamp, e.id)));
    }
    const insertedIds = [];
    for (const s of snap) {
        const res = await db.prepare(`
            INSERT INTO schedule_sets (festival_id, day, stage, stage_order, artist, start_min, end_min, added_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(festivalId, s.day, s.stage, s.stage_order, s.artist, s.start_min, s.end_min, personId || null).run();
        insertedIds.push(res.meta.last_row_id);
    }
    await db.prepare('UPDATE festivals SET schedule_adopted_from = ? WHERE id = ?').bind(publicationId, festivalId).run();
    return { clearedIds: existing.map((e) => e.id), insertedIds };
}

// The shared-schedule registry for the "Load a Shared Schedule" browser: every live
// publication except this fest's own, newest snapshot first, with its source fest
// name, publisher, and set count.
export async function listPublications(db, excludeFestivalId) {
    const ex = excludeFestivalId ?? -1;
    return (await db.prepare(`
        SELECT p.id, p.title, p.updated_at, f.name AS source_name, pe.display_name AS publisher,
               (SELECT COUNT(*) FROM schedule_publication_sets ps WHERE ps.publication_id = p.id) AS set_count
        FROM schedule_publications p
        LEFT JOIN festivals f ON f.id = p.source_festival_id
        LEFT JOIN people pe ON pe.id = p.published_by
        WHERE p.deleted_at IS NULL AND (p.source_festival_id IS NULL OR p.source_festival_id != ?)
        ORDER BY p.updated_at DESC
    `).bind(ex).all()).results;
}
