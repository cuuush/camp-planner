// Spotify links for the Schedule tab's "Play on Spotify" button. Resolve an
// artist name once, cache the URL in D1 (see migration 011), and every later
// viewer gets the link for free — the same read-through cache shape as emoji.js.
//
// What this deliberately ISN'T: the "This Is <artist>" editorial playlist.
// Spotify stopped serving algorithmic/editorial playlists to Web API apps created
// after Nov 2024 — a playlist search returns a list of `null`s where they used to
// be, verified against this app's credentials — so there is no way for us to reach
// them. We link the artist's Spotify page instead, which is the thing "This Is
// <artist>" is a view of anyway, and which plays on tap.
//
// Picking among search hits: Spotify strips `popularity`/`followers` from search
// results for this app too (and GET /v1/artists is a flat 403), so search ORDER is
// the only popularity signal we have — it is Spotify's own relevance+popularity
// ranking. So "most popular" means "highest ranked". We prefer an exact name match
// among the hits, because the top hit for a small act is routinely a bigger,
// unrelated artist ("MACHETE" ranks Control Machete first; "OVAN" ranks Ivan
// Cornejo first), and fall back to the top hit when nothing matches exactly.

import { takeApiBudget, SPOTIFY_MONTHLY_LIMIT } from './budget.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

// Client-credentials token, cached per isolate. Spotify's tokens last an hour;
// we refresh a minute early rather than parse a 401 back out of a search.
let tokenCache = null;   // { token, expiresAt }
let tokenInFlight = null; // single-flight guard, see getToken

// Holds the in-flight PROMISE, not just the finished token: two lookups landing in
// the same isolate before either has cached one would otherwise each fetch their
// own. (Measured back when a batch sweep did this concurrently: 4 token requests
// where 1 would do.)
async function getToken(env) {
    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
    if (tokenInFlight) return tokenInFlight;
    tokenInFlight = fetchToken(env).finally(() => { tokenInFlight = null; });
    return tokenInFlight;
}

async function fetchToken(env) {
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.access_token) return null;
        tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
        return tokenCache.token;
    } catch (e) {
        return null;
    }
}

// A poster name isn't always one artist. Two shapes matter, both measured against
// the real API with this app's credentials (scripts/probe-artist-names.mjs):
//
//  • "DJ DIESEL AKA SHAQ" — an alias the poster prints under the act. Only the part
//    BEFORE the "aka" is the act: the whole string returns "DIESEL", a different
//    artist entirely, while "DJ DIESEL" is an exact hit. So the alias is display
//    text, never search text.
//  • "SULLIVAN KING b2b KAYZO" — two acts sharing one slot. The whole string returns
//    whichever member Spotify happens to rank first ("Kayzo"), so we'd silently link
//    one of the two and call it done; each half alone is an exact hit. So we ask.
//
// A third shape, the same idea:
//
//  • "GANJA WHITE NIGHT (SUNSET SET)" — a trailing parenthetical is a note about the
//    SLOT (sunset set, live, DJ set, all night long), never part of the act's name.
//    Spotify has no idea what a sunset set is, so it's display text, not search text.
//
// "+" is deliberately NOT a separator: "RIVA + BIANCA" is itself an exact match on
// Spotify — a duo with its own page — so splitting it would break a working name.
// Same reason "vs" isn't split blind: it's here because DJ posters use it the way
// they use b2b, but a title like "Spy vs Spy" would be collateral. It only fires
// with spaces around it, which keeps it to the billing usage. And only a TRAILING
// parenthetical is dropped, so "(hed) p.e." keeps its name.
const ALIAS_RE = /\s+a\.?k\.?a\.?\s+/i;
const B2B_RE = /\s+(?:b2b|b3b|vs\.?)\s+/i;
const TRAILING_PAREN_RE = /(?:\s*\([^()]*\))+\s*$/;

// The act(s) a poster name refers to: alias dropped, slot note dropped, b2b split.
// One entry for a normal name, several for a b2b. Used both to decide whether to ask
// the listener which artist they meant, and as the thing we actually search for.
export function splitArtists(name) {
    return (name || '').toString()
        .split(B2B_RE)
        .map((part) => part.split(ALIAS_RE)[0].replace(TRAILING_PAREN_RE, '').trim())
        .filter(Boolean);
}

// The cache key and the yardstick for an "exact" match: case, spacing, dots and
// accents all collapse, so "NEEK.O" / "neek o" / "Néek-O" are one artist.
function normalizeArtist(name) {
    return (name || '').toString().toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '');
}

// Ask Spotify. Returns { url, label } for the best hit, or null when the search
// ran and found nothing. Throws nothing — a transient failure is reported as
// `undefined` so the caller can tell it apart from a real "no such artist".
async function searchArtist(env, artistName) {
    const token = await getToken(env);
    if (!token) return undefined;
    let items;
    try {
        const url = `${SEARCH_URL}?q=${encodeURIComponent(artistName)}&type=artist&limit=10&market=US`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return undefined;
        const data = await res.json();
        items = (data.artists?.items || []).filter(Boolean);
    } catch (e) {
        return undefined;
    }
    if (!items.length) return null;

    const key = normalizeArtist(artistName);
    const best = items.find((a) => normalizeArtist(a.name) === key) || items[0];
    const link = best.external_urls?.spotify;
    return link ? { url: link, label: best.name } : null;
}

// Accept what Spotify's own Share → Copy link hands you (an open.spotify.com URL
// with a ?si= tracking param, sometimes /intl-de/ in the path) or a spotify:artist:ID
// URI, and boil it down to a clean canonical link. Returns null for anything that
// isn't a Spotify link — this URL gets shown to every camp, so a typo or a hostile
// paste shouldn't make it into the table.
export function parseSpotifyUrl(raw) {
    const s = (raw || '').toString().trim();
    if (!s) return null;

    const uri = s.match(/^spotify:(artist|album|track|playlist):([A-Za-z0-9]+)$/);
    if (uri) return `https://open.spotify.com/${uri[1]}/${uri[2]}`;

    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.hostname !== 'open.spotify.com' && u.hostname !== 'play.spotify.com') return null;
    // Drop ?si=… and any locale prefix; keep just the kind and the id.
    const m = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(artist|album|track|playlist)\/([A-Za-z0-9]+)\/?$/);
    if (!m) return null;
    return `https://open.spotify.com/${m[1]}/${m[2]}`;
}

// Pin an artist's link by hand, or forget it (url = null) so the next tap looks it
// up fresh. Writes the same globally-keyed row the search fills, because the link
// belongs to the artist rather than to whoever fixed it.
export async function setSpotifyLink(db, artistName, url, label) {
    const key = normalizeArtist(artistName);
    if (!key) return false;
    if (url == null) {
        await db.prepare('DELETE FROM spotify_links WHERE normalized_artist = ?').bind(key).run();
        return true;
    }
    await db.prepare('INSERT OR REPLACE INTO spotify_links (normalized_artist, url, label) VALUES (?, ?, ?)')
        .bind(key, url, label || artistName).run();
    return true;
}

// Read-through cache. Returns one of:
//   { status: 'ok', url, label }  — link found (fresh or cached)
//   { status: 'none' }            — searched, nothing on Spotify (cached, so we
//                                   only ever pay for that answer once)
//   { status: 'unavailable' }     — not configured / budget spent / Spotify down.
//                                   Never cached: it's about us, not the artist.
export async function resolveSpotifyLink(env, artistName) {
    const key = normalizeArtist(artistName);
    if (!key) return { status: 'none' };

    try {
        const hit = await env.DB.prepare('SELECT url, label FROM spotify_links WHERE normalized_artist = ?').bind(key).first();
        if (hit) return hit.url ? { status: 'ok', url: hit.url, label: hit.label } : { status: 'none' };
    } catch (e) {
        // cache read is best-effort — fall through and just ask Spotify
    }

    // Fence the outbound call behind the shared monthly budget, like every other
    // third-party call in the app. The cache means we only get here once per artist.
    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return { status: 'unavailable' };
    if (!await takeApiBudget(env.DB, 'spotify_search', SPOTIFY_MONTHLY_LIMIT)) return { status: 'unavailable' };

    const found = await searchArtist(env, artistName);
    if (found === undefined) return { status: 'unavailable' };

    try {
        await env.DB.prepare('INSERT OR REPLACE INTO spotify_links (normalized_artist, url, label) VALUES (?, ?, ?)')
            .bind(key, found ? found.url : null, found ? found.label : null).run();
    } catch (e) {
        // caching is best-effort — the answer is still good for this caller
    }
    return found ? { status: 'ok', url: found.url, label: found.label } : { status: 'none' };
}

// Attach spotify_artists / spotify_url / spotify_checked to a list of sets in ONE
// query, so a grid of 37 tiles can render every already-known link without an N+1
// (or any API call). spotify_checked=false means "nobody has looked this up yet".
//
// Keyed on the SPLIT name, not the printed one: the cache entry for "DJ DIESEL AKA
// SHAQ" lives under "djdiesel", which is also what a plain "DJ DIESEL" elsewhere on
// the poster resolves to — one lookup, one row, shared. A b2b set gets nothing
// pre-attached on purpose: it has two answers, so the card always asks.
export async function attachSpotifyLinks(db, sets) {
    for (const s of sets) {
        s.spotify_artists = splitArtists(s.artist);
        s.spotify_url = null;
        s.spotify_checked = false;
    }
    const single = sets.filter((s) => s.spotify_artists.length === 1);
    const keys = [...new Set(single.map((s) => normalizeArtist(s.spotify_artists[0])).filter(Boolean))];
    if (!keys.length) return sets;
    try {
        const rows = (await db.prepare(`
            SELECT normalized_artist, url FROM spotify_links
            WHERE normalized_artist IN (${keys.map(() => '?').join(',')})
        `).bind(...keys).all()).results;
        const byKey = new Map(rows.map((r) => [r.normalized_artist, r]));
        for (const s of single) {
            const hit = byKey.get(normalizeArtist(s.spotify_artists[0]));
            if (!hit) continue;
            s.spotify_checked = true;
            s.spotify_url = hit.url;
        }
    } catch (e) {
        // no cache table / read failed — every tile just renders as "not looked up yet"
    }
    return sets;
}
