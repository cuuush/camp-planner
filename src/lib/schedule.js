// Schedule data + time helpers, shared by the Schedule route, the set modal, and
// the import/preview flow. Times are stored as MINUTES FROM MIDNIGHT of the
// festival day, with after-midnight sets as 1440+ (see migration 009), so the
// whole night sorts and positions on one number line.

import { attachSpotifyLinks } from './spotify.js';

// Minutes → a 12-hour clock label like "11:15 PM". Wraps past midnight (1470 →
// "12:30 AM") since the stored value already encodes which day it's on.
function fmtSetTime(min) {
    if (min == null || !Number.isFinite(Number(min))) return '';
    const wrapped = ((Math.round(Number(min)) % 1440) + 1440) % 1440;
    let h = Math.floor(wrapped / 60);
    const m = wrapped % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

// The ruler's own label. It only ever marks whole hours (buildGrid floors the range
// to them), so ":00" on every line is noise — and on a phone it's the difference
// between "11 PM" fitting the narrow ruler and the hour being clipped off the left.
export function fmtHourLabel(min) {
    if (min == null || !Number.isFinite(Number(min))) return '';
    const wrapped = ((Math.round(Number(min)) % 1440) + 1440) % 1440;
    let h = Math.floor(wrapped / 60);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h} ${ap}`;
}

// "11:15 PM – 12:30 AM" (en dash, matching the poster). Either end may be blank.
export function fmtSetRange(startMin, endMin) {
    const a = fmtSetTime(startMin);
    const b = fmtSetTime(endMin);
    if (a && b) return `${a} – ${b}`;
    return a || b || '';
}

// Parse a "H:MM" / "HH:MM" (24-hour, from an <input type="time">) plus an
// after-midnight flag into stored minutes. Returns null on a blank/garbage value.
export function clockToMin(value, afterMidnight = false) {
    const m = (value || '').toString().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm + (afterMidnight ? 1440 : 0);
}

// Stored minutes → the value/flag pair an edit form needs: "HH:MM" for the
// <input type="time"> and whether it's after midnight (so the checkbox reflects it).
export function minToClockFields(min) {
    if (min == null || !Number.isFinite(Number(min))) return { time: '', afterMidnight: false };
    const v = Math.round(Number(min));
    const afterMidnight = v >= 1440;
    const wrapped = ((v % 1440) + 1440) % 1440;
    const h = Math.floor(wrapped / 60);
    const mm = wrapped % 60;
    return { time: `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, afterMidnight };
}

// The distinct day labels a fest has sets for, in schedule order (earliest start
// first) so day tabs read Friday → Saturday → Sunday. A null/blank day sorts in as
// '' and is rendered as a single untitled column set by the caller.
export async function loadDays(db, festivalId) {
    const rows = (await db.prepare(`
        SELECT COALESCE(day, '') AS day, MIN(start_min) AS first_min
        FROM schedule_sets WHERE festival_id = ? AND deleted_at IS NULL
        GROUP BY COALESCE(day, '') ORDER BY first_min IS NULL, first_min, day
    `).bind(festivalId).all()).results;
    return rows.map((r) => r.day);
}

// All non-deleted sets for a fest+day, each decorated with interest_count, the
// interested people's names (in the order they starred), and whether `person` is
// among them. One extra query for interests avoids an N+1 across tiles.
export async function loadDaySets(db, festivalId, day, person) {
    const sets = (await db.prepare(`
        SELECT * FROM schedule_sets
        WHERE festival_id = ? AND COALESCE(day, '') = ? AND deleted_at IS NULL
        ORDER BY stage_order, stage, start_min
    `).bind(festivalId, day || '').all()).results;
    await decorateWithInterest(db, sets, person);
    await attachCommentCounts(db, sets);
    await attachSpotifyLinks(db, sets);
    return sets;
}

// Attach comment_count (target_type='set') to a list of sets in one query — feeds
// the "Chat (N messages)" button labels without an N+1.
async function attachCommentCounts(db, sets) {
    if (!sets.length) return sets;
    const ids = sets.map((s) => s.id);
    const rows = (await db.prepare(`
        SELECT target_id, COUNT(*) AS n FROM comments
        WHERE target_type = 'set' AND deleted_at IS NULL AND target_id IN (${ids.map(() => '?').join(',')})
        GROUP BY target_id
    `).bind(...ids).all()).results;
    const byId = new Map(rows.map((r) => [r.target_id, r.n]));
    for (const s of sets) s.comment_count = byId.get(s.id) || 0;
    return sets;
}

// Attach interest_count / interested (names) / i_interested to a list of sets.
async function decorateWithInterest(db, sets, person) {
    if (!sets.length) return sets;
    const ids = sets.map((s) => s.id);
    const rows = (await db.prepare(`
        SELECT si.set_id, si.person_id, pe.display_name
        FROM set_interests si JOIN people pe ON pe.id = si.person_id
        WHERE si.deleted_at IS NULL AND si.set_id IN (${ids.map(() => '?').join(',')})
        ORDER BY si.created_at
    `).bind(...ids).all()).results;
    const bySet = new Map();
    for (const r of rows) {
        if (!bySet.has(r.set_id)) bySet.set(r.set_id, []);
        bySet.get(r.set_id).push(r);
    }
    for (const s of sets) {
        const list = bySet.get(s.id) || [];
        s.interested = list.map((r) => r.display_name);
        s.interest_count = list.length;
        s.i_interested = !!(person && list.some((r) => r.person_id === person.id));
    }
    return sets;
}

// Load one set with its full interested-people list and whether `person` is in it.
export async function loadSet(db, setId, person) {
    const set = await db.prepare('SELECT * FROM schedule_sets WHERE id = ? AND deleted_at IS NULL').bind(setId).first();
    if (!set) return null;
    const list = (await db.prepare(`
        SELECT si.person_id, pe.display_name FROM set_interests si
        JOIN people pe ON pe.id = si.person_id
        WHERE si.set_id = ? AND si.deleted_at IS NULL ORDER BY si.created_at
    `).bind(setId).all()).results;
    set.interested = list.map((r) => r.display_name);
    set.interest_count = list.length;
    set.i_interested = !!(person && list.some((r) => r.person_id === person.id));
    const cc = await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE target_type = 'set' AND target_id = ? AND deleted_at IS NULL").bind(setId).first();
    set.comment_count = cc ? cc.n : 0;
    await attachSpotifyLinks(db, [set]);
    return set;
}

// Group a day's sets into stage columns, ordered left→right by their stage_order
// (falling back to name), and compute the vertical time window the grid spans.
// The caller positions each tile with pxPerMin against [minMin, maxMin].
export function buildGrid(sets) {
    const stageMap = new Map();
    let minMin = Infinity;
    let maxMin = -Infinity;
    for (const s of sets) {
        const key = s.stage || '';
        if (!stageMap.has(key)) stageMap.set(key, { name: key, order: s.stage_order ?? 0, sets: [] });
        const col = stageMap.get(key);
        col.order = Math.min(col.order, s.stage_order ?? 0);
        col.sets.push(s);
        if (s.start_min != null) minMin = Math.min(minMin, s.start_min);
        if (s.end_min != null) maxMin = Math.max(maxMin, s.end_min);
    }
    const stages = [...stageMap.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    if (!Number.isFinite(minMin)) { minMin = 12 * 60; maxMin = 24 * 60; }
    // Pad to whole hours so the ruler starts/ends on a labeled line.
    minMin = Math.floor(minMin / 60) * 60;
    maxMin = Math.ceil(maxMin / 60) * 60;
    return { stages, minMin, maxMin };
}

// Poster-accurate accent colors for the classic Elements stages, with a small
// fallback palette (cycled by column index) for any other festival's stage names.
// Used as a CSS accent over the XP-white grid — not a full dark repaint.
const STAGE_COLORS = {
    earth: '#2bb6a3',
    fire: '#f0486a',
    air: '#e9c53d',
    water: '#3aa5ee',
};
const STAGE_FALLBACK = ['#6f8ad4', '#c77dd6', '#d68a4e', '#5bb85b', '#4ea0c0'];

export function stageColor(name, index = 0) {
    const key = (name || '').trim().toLowerCase();
    return STAGE_COLORS[key] || STAGE_FALLBACK[index % STAGE_FALLBACK.length];
}
