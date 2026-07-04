import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomToken } from './tokens.js';

const SESSION_COOKIE = 'camp_session';
const FEST_COOKIE = 'camp_current_fest';
const SESSION_DAYS = 90; // 3-month rolling expiry

export async function loadPerson(c) {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;

    const db = c.env.DB;
    const session = await db.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
    if (!session) return null;

    if (new Date(session.expires_at) < new Date()) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        deleteCookie(c, SESSION_COOKIE, { path: '/' });
        return null;
    }

    const person = await db.prepare('SELECT * FROM people WHERE id = ?').bind(session.person_id).first();
    if (!person) return null;
    // A merged-away (soft-deleted) identity can't act — its sessions were dropped at
    // merge time, so this is belt-and-braces. On un-merge deleted_at is nulled and
    // they sign in fresh.
    if (person.deleted_at) return null;

    // Rolling expiry: refresh if more than a day since last touch.
    const lastUsed = new Date(session.last_used_at);
    if ((Date.now() - lastUsed.getTime()) / (1000 * 60 * 60) > 24) {
        const newExpiry = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        await db.prepare("UPDATE sessions SET last_used_at = datetime('now'), expires_at = ? WHERE token = ?")
            .bind(newExpiry, token).run();
        setSessionCookie(c, token);
    }

    await db.prepare("UPDATE people SET last_seen_at = datetime('now') WHERE id = ?").bind(person.id).run();

    return person;
}

export function setSessionCookie(c, token) {
    setCookie(c, SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
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

export function getCurrentFestCookie(c) {
    const v = getCookie(c, FEST_COOKIE);
    return v ? Number(v) : null;
}

export function setCurrentFestCookie(c, festivalId) {
    setCookie(c, FEST_COOKIE, String(festivalId), {
        path: '/',
        httpOnly: false,
        sameSite: 'Lax',
        maxAge: SESSION_DAYS * 24 * 60 * 60,
    });
}
