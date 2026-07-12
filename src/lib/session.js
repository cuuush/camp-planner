import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomToken } from './tokens.js';

const SESSION_COOKIE = 'camp_session';
const SESSION_DAYS = 90; // 3-month rolling expiry

// Secure on prod (always HTTPS behind Cloudflare) so the session token is never
// sent over plain HTTP. Derived from the request instead of hardcoded because
// dev is tested over plain-HTTP Tailscale from the phone (AGENTS.md gotcha 4) —
// a hardcoded Secure flag would silently break sign-in there.
function isHttps(c) {
    return c.req.url.startsWith('https:');
}

export async function loadPerson(c) {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;

    const db = c.env.DB;
    // This runs on EVERY request before the route handler, so it gets exactly one
    // blocking round trip: session + its person in a single JOIN. The bookkeeping
    // writes below ride on waitUntil — they finish after the response is sent.
    const person = await db.prepare(`
        SELECT p.*, s.expires_at AS session_expires_at, s.last_used_at AS session_last_used_at
        FROM sessions s JOIN people p ON p.id = s.person_id
        WHERE s.token = ?
    `).bind(token).first();
    if (!person) return null;

    if (new Date(person.session_expires_at) < new Date()) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        deleteCookie(c, SESSION_COOKIE, { path: '/' });
        return null;
    }

    // A merged-away (soft-deleted) identity can't act — its sessions were dropped at
    // merge time, so this is belt-and-braces. On un-merge deleted_at is nulled and
    // they sign in fresh.
    if (person.deleted_at) return null;

    // Rolling expiry: refresh if more than a day since last touch.
    const lastUsed = new Date(person.session_last_used_at);
    if ((Date.now() - lastUsed.getTime()) / (1000 * 60 * 60) > 24) {
        const newExpiry = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        c.executionCtx.waitUntil(
            db.prepare("UPDATE sessions SET last_used_at = datetime('now'), expires_at = ? WHERE token = ?")
                .bind(newExpiry, token).run());
        setSessionCookie(c, token);
    }

    // last_seen_at is display-only (admin page), so 5-minute granularity is plenty —
    // no point paying a D1 write on every request for it.
    const lastSeen = new Date(person.last_seen_at);
    if (Date.now() - lastSeen.getTime() > 5 * 60 * 1000) {
        c.executionCtx.waitUntil(
            db.prepare("UPDATE people SET last_seen_at = datetime('now') WHERE id = ?").bind(person.id).run());
    }

    return person;
}

export function setSessionCookie(c, token) {
    setCookie(c, SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        secure: isHttps(c),
        sameSite: 'Lax',
        maxAge: SESSION_DAYS * 24 * 60 * 60,
    });
}

export async function createSession(c, personId) {
    const db = c.env.DB;
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare('INSERT INTO sessions (token, person_id, expires_at) VALUES (?, ?, ?)')
        .bind(token, personId, expiresAt).run();
    setSessionCookie(c, token);
    return token;
}

export async function destroySession(c) {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
        await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
