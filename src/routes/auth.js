import { Hono } from 'hono';
import { renderPage } from '../render/layout.js';
import { signinForm } from '../render/signin.js';
import { normalizeName } from '../lib/names.js';
import { createSession, destroySession } from '../lib/session.js';
import { logAction } from '../lib/audit.js';

export const auth = new Hono();

auth.get('/signin', async (c) => {
    return c.html(await renderPage(c, { title: 'sign in', body: signinForm() }));
});

auth.post('/signin', async (c) => {
    const body = await c.req.parseBody();
    const rawName = (body.name || '').toString();
    const email = (body.email || '').toString().trim() || null;
    const normalized = normalizeName(rawName);

    if (!normalized) {
        return c.html(await renderPage(c, { title: 'sign in', body: signinForm() }));
    }

    const db = c.env.DB;
    const existing = await db.prepare('SELECT * FROM people WHERE normalized_name = ?').bind(normalized).first();

    if (existing) {
        // Name taken — trust-based reclaim, not an auto-login.
        return c.html(await renderPage(c, { title: 'sign in', body: signinForm(rawName, existing.display_name) }));
    }

    const result = await db.prepare('INSERT INTO people (normalized_name, display_name, email) VALUES (?, ?, ?)')
        .bind(normalized, rawName.trim(), email).run();
    const personId = result.meta.last_row_id;

    await createSession(c, personId);
    c.set('person', { id: personId, display_name: rawName.trim(), normalized_name: normalized, email });

    await logAction(c, {
        action: 'signin', entityType: 'person', entityId: personId,
        summary: `${rawName.trim()} joined camp planner`,
    });

    return c.redirect('/');
});

auth.post('/signin/reclaim', async (c) => {
    const body = await c.req.parseBody();
    const normalized = normalizeName((body.name || '').toString());
    const db = c.env.DB;
    const person = await db.prepare('SELECT * FROM people WHERE normalized_name = ?').bind(normalized).first();

    if (!person) return c.redirect('/signin');

    await createSession(c, person.id);
    c.set('person', person);

    const meta = c.get('reqMeta') || {};
    await db.prepare('INSERT INTO name_reclaim_log (person_id, reclaimed_ip) VALUES (?, ?)')
        .bind(person.id, meta.ip || null).run();

    await logAction(c, {
        action: 'reclaim', entityType: 'person', entityId: person.id,
        summary: `${person.display_name} reclaimed their name (trust-based)`,
    });

    return c.redirect('/');
});

auth.get('/signout', async (c) => {
    await destroySession(c);
    return c.redirect('/');
});
