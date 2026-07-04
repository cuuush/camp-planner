import { logAction } from './audit.js';
import { notify } from './notify.js';

// One comments SELECT for every chat (items + cars) so both get the same columns
// — msnChat needs created_at for the MSN-style timestamps.
export async function loadComments(db, targetType, targetId) {
    return (await db.prepare(`
        SELECT c.id, c.body, c.created_at, pe.display_name FROM comments c
        JOIN people pe ON pe.id = c.person_id
        WHERE c.target_type = ? AND c.target_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at
    `).bind(targetType, targetId).all()).results;
}

// Shared plumbing for POST .../comments on any chat-bearing entity: parse, trim,
// INSERT, audit entry, owner notification, re-render. The caller keeps only what
// actually differs between an item and a car: the target row, whose inbox to
// poke, the human copy, and how to re-render the fragment. Caller must have
// already handled the sign-in guard (the copy below needs a person).
export async function handleCommentPost(c, {
    festival, targetType, targetId,
    ownerPersonId,   // notified (unless they wrote the comment themselves)
    summary,         // audit-log line
    notifyHeading,
    notifyBody,      // (text) => email body copy
    respond,         // () => the re-rendered fragment (expanded, chat open)
}) {
    const person = c.get('person');
    const body = await c.req.parseBody();
    const text = (body.body || '').toString().trim();
    if (!text) return respond();

    const result = await c.env.DB.prepare('INSERT INTO comments (target_type, target_id, person_id, body) VALUES (?, ?, ?, ?)')
        .bind(targetType, targetId, person.id, text).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'comments', entityId: result.meta.last_row_id,
        reversible: true,
        summary,
    });

    await notify(c.env, {
        festivalId: festival.id, targetPersonId: ownerPersonId, actorPersonId: person.id,
        heading: notifyHeading,
        body: notifyBody(text),
    });

    return respond();
}
