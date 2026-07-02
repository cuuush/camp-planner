import { sendNotificationEmail } from './email.js';
import { unsubscribeUrlFor } from './unsubscribe.js';

// Fire-and-forget-ish notification for a mutating action. Never blocks the
// caller's own action on email delivery — swallow all errors.
export async function notify(env, { targetPersonId, actorPersonId, heading, body }) {
    if (!targetPersonId || targetPersonId === actorPersonId) return; // never notify people about their own actions

    try {
        const person = await env.DB.prepare('SELECT * FROM people WHERE id = ?').bind(targetPersonId).first();
        if (!person || !person.email || person.email_unsubscribed) return;

        await sendNotificationEmail(env, {
            to: person.email,
            heading,
            body,
            unsubscribeUrl: await unsubscribeUrlFor(env, person),
        });
    } catch (e) {
        console.error('notify failed', e);
    }
}
