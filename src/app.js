import { Hono } from 'hono';
import { loadPerson } from './lib/session.js';
import { requestMeta } from './lib/geo.js';
import { isD1ResetError, retryOnD1Reset } from './lib/d1retry.js';
import { auth } from './routes/auth.js';
import { festivals } from './routes/festivals.js';
import { items } from './routes/items.js';
import { people } from './routes/people.js';
import { rides } from './routes/rides.js';
import { schedule } from './routes/schedule.js';
import { mine } from './routes/mine.js';
import { log } from './routes/log.js';
import { settings } from './routes/settings.js';
import { feedback } from './routes/feedback.js';
import { admin } from './routes/admin.js';
import { webring } from './routes/webring.js';

export const app = new Hono();

// Plain HTTP on the public domain is a SILENT SIGN-IN BREAKER, not just a security
// nit. Over HTTPS the session cookie is set with `Secure` (see lib/session.js). Over
// HTTP it isn't — and Chromium implements RFC 6265bis §5.4 "leave secure cookies
// alone": a non-Secure cookie is NOT allowed to overwrite an existing Secure cookie
// of the same name. So for anyone who had ever visited over HTTPS, http:// sign-in
// set `camp_session` into the void — no error, no warning, just permanently signed
// out. Safari doesn't enforce that rule, and localhost never has a Secure cookie to
// collide with, which is exactly why this only ever reproduced in Chrome/Brave on
// prod and looked impossible to pin down.
//
// Fixed at the door rather than by loosening the cookie: dropping `Secure` would
// hand the session token to anyone on the same coffee-shop wifi.
//
// Scoped to the public host on purpose. Dev is served over plain HTTP — localhost
// and Tailscale from a phone (AGENTS.md gotcha 4) — and blanket-redirecting every
// http:// request would make the app unreachable there.
const PROD_HOST = 'camp.cuuush.com';
app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    if (!c.env.DEV && url.protocol === 'http:' && url.hostname === PROD_HOST) {
        url.protocol = 'https:';
        // 301: this is permanent, and letting browsers remember it means the
        // insecure hop happens once per client instead of on every navigation.
        return c.redirect(url.toString(), 301);
    }
    await next();
});

app.use('*', async (c, next) => {
    c.set('reqMeta', requestMeta(c));
    c.set('person', await retryOnD1Reset(() => loadPerson(c)));
    await next();

    // Every response the worker emits is dynamic, per-user HTML (real static
    // files are served by Cloudflare's asset layer and never reach here). If we
    // send no Cache-Control, browsers fall back to *heuristic* caching and are
    // free to invent a freshness lifetime — iOS Safari (betas especially) does
    // this aggressively, stashing the HTML in disk/bfcache and later restoring
    // the whole page, stale subresource state and all, without hitting the
    // network. The visible result: pages that come back with no CSS/JS until
    // the cache is cleared. Declaring the document uncacheable forces a real
    // network fetch every navigation, which re-runs proper subresource
    // revalidation. (The assets themselves are fine — they already revalidate
    // correctly via ETag.)
    if (c.res.headers.get('content-type')?.includes('text/html')) {
        c.res.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
});

app.route('/', auth);
app.route('/', festivals);
app.route('/', items);
app.route('/', people);
app.route('/', rides);
app.route('/', schedule);
app.route('/', mine);
app.route('/', log);
app.route('/', settings);
app.route('/', feedback);
app.route('/', admin);
app.route('/', webring);

app.onError((err, c) => {
    console.error(err);

    if (!isD1ResetError(err)) {
        return c.html(
            '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>camp planner</title></head>' +
            '<body style="font-family: sans-serif; text-align: center; padding: 4rem 1rem;">' +
            '<h1>Something went wrong</h1><p>Please try again.</p></body></html>',
            500
        );
    }

    // D1's backing storage got reset — usually clears within a few seconds.
    // Safe to auto-retry GET/HEAD; anything else (a form submit) shouldn't be
    // resubmitted silently, so just ask the person to try again.
    const MAX_AUTO_RETRIES = 5; // ~15s of auto-refresh before we stop and ask the person to act
    const retryCount = Number(c.req.query('d1retry') ?? '0');
    const canAutoRetry = (c.req.method === 'GET' || c.req.method === 'HEAD') && retryCount < MAX_AUTO_RETRIES;

    let retryUrl;
    if (canAutoRetry) {
        const url = new URL(c.req.url);
        url.searchParams.set('d1retry', String(retryCount + 1));
        retryUrl = url.pathname + url.search;
    }

    return c.html(
        '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        (canAutoRetry ? `<meta http-equiv="refresh" content="3;url=${retryUrl}">` : '') +
        '<title>camp planner</title></head>' +
        '<body style="font-family: sans-serif; text-align: center; padding: 4rem 1rem;">' +
        '<h1>🏕️ Hang tight…</h1>' +
        '<p>' + (canAutoRetry
            ? 'The database is waking up. This page will retry automatically.'
            : 'The database is taking longer than usual to wake up. Please try again in a minute — sorry for the trouble.') +
        '</p>' +
        (canAutoRetry ? '' : '<p><a href="' + c.req.path + '">Reload</a></p>') +
        '</body></html>',
        503,
        { 'Retry-After': '3' }
    );
});
