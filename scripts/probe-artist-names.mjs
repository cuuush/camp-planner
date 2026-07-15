// Throwaway probe: how does Spotify actually answer the multi-artist and alias
// names on our poster? Decides whether "+" pairings should be split like "b2b"
// (do they exist as duos?) and confirms that stripping "AKA ..." finds the act.
//
// Run: node scripts/probe-artist-names.mjs
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
    readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
        .split('\n').filter((l) => l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
        Authorization: 'Basic ' + Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
});
const { access_token: token } = await res.json();
if (!token) { console.error('no token'); process.exit(1); }

async function search(q) {
    const r = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=artist&limit=3&market=US`,
        { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return `HTTP ${r.status}`;
    const items = ((await r.json()).artists?.items || []).filter(Boolean);
    return items.length ? items.map((a) => a.name).join(' | ') : '(nothing)';
}

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

// The exact strings sitting in our DB, plus the pieces we'd split them into.
const cases = [
    ['FULL   ', 'RIVA + BIANCA'], ['piece  ', 'RIVA'], ['piece  ', 'BIANCA'],
    ['FULL   ', 'OBA + FLIP'], ['piece  ', 'OBA'], ['piece  ', 'FLIP'],
    ['FULL   ', 'SULLIVAN KING b2b KAYZO'], ['piece  ', 'SULLIVAN KING'], ['piece  ', 'KAYZO'],
    ['FULL   ', 'TORREN FOOT b2b AIRWOLF PARADISE'], ['piece  ', 'TORREN FOOT'], ['piece  ', 'AIRWOLF PARADISE'],
    ['FULL   ', 'HVNLEE b2b LUNA MAR'], ['piece  ', 'HVNLEE'], ['piece  ', 'LUNA MAR'],
    ['FULL   ', 'DJ DIESEL AKA SHAQ'], ['piece  ', 'DJ DIESEL'], ['piece  ', 'SHAQ'],
];

for (const [kind, q] of cases) {
    const hits = await search(q);
    // Does the top hit actually match what we asked for, or is it a stranger?
    const top = hits.split(' | ')[0];
    const exact = norm(top) === norm(q) ? 'EXACT' : '     ';
    console.log(`${kind} ${exact}  ${q.padEnd(34)} → ${hits}`);
}
