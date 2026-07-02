import { Hono } from 'hono';
import { renderPage } from '../render/layout.js';
import { signinForm } from '../render/signin.js';
import { modalFormMarkup } from '../lib/guard.js';
import { normalizeName } from '../lib/names.js';
import { createSession, destroySession } from '../lib/session.js';
import { logAction } from '../lib/audit.js';

export const auth = new Hono();

// Only ever redirect to a same-site relative path — never trust an absolute/external "next".
function safeNext(raw) {
    if (!raw) return '/';
    try {
        const url = new URL(raw, 'http://placeholder.local');
        return url.pathname + url.search || '/';
    } catch (e) {
        return '/';
    }
}

// Actually perform whatever mutating request the person was trying to make when they
// got sent here to sign in — so "leave a comment" -> sign in -> comment is really posted.
async function replayOriginalAction(c, { replayPath, replayBody, sessionToken }) {
    if (!replayPath) return;
    try {
        const { app } = await import('../app.js');
        const headers = { Cookie: `camp_session=${sessionToken}` };
        if (replayBody) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        const replayReq = new Request(new URL(replayPath, 'http://internal.local'), {
            method: 'POST',
            body: replayBody || undefined,
            headers,
        });
        await app.fetch(replayReq, c.env, c.executionCtx);
    } catch (e) {
        console.error('replay failed', e);
    }
}

// Append ?expand=<id>#<id> to a same-site path so the page reopens on the thing they were doing.
function withExpand(path, expand) {
    if (!expand) return path;
    const url = new URL(path, 'http://placeholder.local');
    url.searchParams.set('expand', expand);
    return `${url.pathname}${url.search}#${expand}`;
}

function ctxFromQuery(c) {
    return {
        next: safeNext(c.req.query('next')),
        expandId: c.req.query('expand') || '',
        replayPath: c.req.query('replay_path') || '',
        replayBody: c.req.query('replay_body') || '',
    };
}

function ctxFromBody(body) {
    return {
        next: safeNext((body.next || '').toString()),
        expandId: (body.expand || '').toString(),
        replayPath: (body.replay_path || '').toString(),
        replayBody: (body.replay_body || '').toString(),
    };
}

function isHtmx(c) {
    return c.req.header('HX-Request') === 'true';
}

auth.get('/signin', async (c) => {
    return c.html(await renderPage(c, { title: 'sign in', body: signinForm('', null, ctxFromQuery(c)) }));
});

// The sign-in dialog as an htmx fragment — used to pop the modal *before* an action
// (e.g. tapping "i'll bring this" while signed out) rather than after it's blocked.
// On success it HX-Redirects to `next`, so we send them back where they were.
auth.get('/signin/modal', async (c) => {
    return c.html(modalFormMarkup(ctxFromQuery(c)));
});

// Live, non-blocking check as you type — just a heads-up, never prevents signing in.
auth.get('/signin/check-name', async (c) => {
    const normalized = normalizeName(c.req.query('name') || '');
    if (!normalized) return c.json({ taken: false });
    const existing = await c.env.DB.prepare('SELECT display_name FROM people WHERE normalized_name = ?').bind(normalized).first();
    return c.json({ taken: !!existing, display_name: existing ? existing.display_name : null });
});

auth.post('/signin', async (c) => {
    const body = await c.req.parseBody();
    const rawName = (body.name || '').toString();
    const email = (body.email || '').toString().trim() || null;
    const normalized = normalizeName(rawName);
    const ctx = ctxFromBody(body);
    const htmx = isHtmx(c);

    if (!normalized) {
        return htmx
            ? c.html(modalFormMarkup(ctx))
            : c.html(await renderPage(c, { title: 'sign in', body: signinForm('', null, ctx) }));
    }

    const db = c.env.DB;
    const existing = await db.prepare('SELECT * FROM people WHERE normalized_name = ?').bind(normalized).first();

    if (existing) {
        // Name already exists → sign in as that person directly (trust-based). The
        // live "that name's taken" heads-up on the form is the only confirmation;
        // no second "is this you?" step after submitting.
        const sessionToken = await createSession(c, existing.id);
        c.set('person', existing);

        const meta = c.get('reqMeta') || {};
        await db.prepare('INSERT INTO name_reclaim_log (person_id, reclaimed_ip) VALUES (?, ?)')
            .bind(existing.id, meta.ip || null).run();

        await logAction(c, {
            action: 'reclaim', entityType: 'person', entityId: existing.id,
            summary: `${existing.display_name} signed in (existing name)`,
        });

        await replayOriginalAction(c, { replayPath: ctx.replayPath, replayBody: ctx.replayBody, sessionToken });

        const destination = withExpand(ctx.next, ctx.expandId);
        if (htmx) {
            c.header('HX-Redirect', destination);
            return c.body(null);
        }
        return c.redirect(destination);
    }

    const result = await db.prepare('INSERT INTO people (normalized_name, display_name, email) VALUES (?, ?, ?)')
        .bind(normalized, rawName.trim(), email).run();
    const personId = result.meta.last_row_id;

    const sessionToken = await createSession(c, personId);
    c.set('person', { id: personId, display_name: rawName.trim(), normalized_name: normalized, email });

    await logAction(c, {
        action: 'signin', entityType: 'person', entityId: personId,
        summary: `${rawName.trim()} joined camp planner`,
    });

    await replayOriginalAction(c, { replayPath: ctx.replayPath, replayBody: ctx.replayBody, sessionToken });

    const destination = withExpand(ctx.next, ctx.expandId);
    if (htmx) {
        c.header('HX-Redirect', destination);
        return c.body(null);
    }
    return c.redirect(destination);
});

auth.post('/signin/reclaim', async (c) => {
    const body = await c.req.parseBody();
    const normalized = normalizeName((body.name || '').toString());
    const ctx = ctxFromBody(body);
    const htmx = isHtmx(c);
    const db = c.env.DB;
    const person = await db.prepare('SELECT * FROM people WHERE normalized_name = ?').bind(normalized).first();

    if (!person) {
        if (htmx) return c.html(modalFormMarkup(ctx));
        const params = new URLSearchParams({ next: ctx.next, replay_path: ctx.replayPath, replay_body: ctx.replayBody, expand: ctx.expandId });
        return c.redirect(`/signin?${params.toString()}`);
    }

    const sessionToken = await createSession(c, person.id);
    c.set('person', person);

    const meta = c.get('reqMeta') || {};
    await db.prepare('INSERT INTO name_reclaim_log (person_id, reclaimed_ip) VALUES (?, ?)')
        .bind(person.id, meta.ip || null).run();

    await logAction(c, {
        action: 'reclaim', entityType: 'person', entityId: person.id,
        summary: `${person.display_name} reclaimed their name (trust-based)`,
    });

    await replayOriginalAction(c, { replayPath: ctx.replayPath, replayBody: ctx.replayBody, sessionToken });

    const destination = withExpand(ctx.next, ctx.expandId);
    if (htmx) {
        c.header('HX-Redirect', destination);
        return c.body(null);
    }
    return c.redirect(destination);
});

auth.get('/signout', async (c) => {
    await destroySession(c);
    return c.redirect('/');
});
