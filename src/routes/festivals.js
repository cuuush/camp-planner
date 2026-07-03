import { Hono } from 'hono';
import { html } from 'hono/html';
import { getCookie, setCookie } from 'hono/cookie';
import { renderPage } from '../render/layout.js';
import { logAction } from '../lib/audit.js';
import { setCurrentFestCookie } from '../lib/session.js';
import { needsSignin, signinRedirect } from '../lib/guard.js';

export const festivals = new Hono();

// Cush's canonical "forest must-have" preseed list — offered as a one-click way to
// prepopulate a brand-new fest with the standard packing items (same set that seeds
// festival 1). [name, emoji, needed_qty, unit].
const PRESEED_LABEL = "cush's forest must-have list";
const PRESEED_ITEMS = [
    ['Spare chairs', '🪑', 4, 'chairs'],
    ['Broom', '🧹', 1, null],
    ['More water', '💧', 3, 'cases'],
    ['Incense sticks', '🕯️', 2, 'packs'],
    ['Breakfast', '🥞', 1, null],
    ['Lights, more lights', '💡', 1, null],
    ['Oscillating fan', '🌀', 1, null],
    ['Projector for canopy', '📽️', 1, null],
    ['More tapestries, full wall', '🧶', 4, null],
    ['Nasal spray', '💦', 1, null],
    ['Mirror', '🪞', 1, null],
    ['Carpet', '🟫', 1, null],
    ['Star canopies set up', '⭐', 1, null],
    ['Table', '🪵', 1, null],
    ['Tapestries', '🧵', 2, null],
    ['Battery powered fan', '🔋', 1, null],
    ['Replace totem batteries', '🔋', 1, 'sets'],
    ['Zip lock bag for totem', '🧴', 1, null],
    ['Gutter for canopy', '⛺', 1, null],
];

function fmtDateRange(f) {
    if (!f.start_date) return '';
    return f.end_date && f.end_date !== f.start_date ? `${f.start_date} → ${f.end_date}` : f.start_date;
}

function countdown(f) {
    if (!f.start_date) return '';
    const days = Math.ceil((new Date(f.start_date) - new Date()) / 86400000);
    if (days > 0) return html`<span class="rainbow">${days} days to go!</span>`;
    if (days === 0) return html`<span class="rainbow">IT'S TODAY!!!</span>`;
    return html`<span style="color:#888">happened ${-days} days ago</span>`;
}

festivals.get('/', async (c) => {
    const db = c.env.DB;
    const list = (await db.prepare('SELECT * FROM festivals WHERE deleted_at IS NULL ORDER BY start_date, name').all()).results;

    const body = html`
    ${list.length === 0 ? html`<p>no fests yet. be the first!</p>` : ''}
    ${list.map((f) => html`
      <div class="card">
        <a href="/f/${f.id}"><b style="font-size:1.2em">${f.name}</b></a><br>
        ${fmtDateRange(f)} ${f.location ? `· ${f.location}` : ''}<br>
        ${countdown(f)}<br>
        ${f.blurb ? html`<p>${f.blurb}</p>` : ''}
      </div>`)}
    <div class="divider"><a class="btn" href="/fests/new">+ add a fest</a></div>
  `;

    return c.html(await renderPage(c, { title: 'all festivals', body }));
});

festivals.get('/fests/new', async (c) => {
    const db = c.env.DB;
    const existing = (await db.prepare('SELECT id, name FROM festivals WHERE deleted_at IS NULL ORDER BY name').all()).results;

    const body = html`
    <div class="card">
      <h2>+ add a fest</h2>
      <form method="post" action="/fests">
        <label>name: <input type="text" name="name" required></label><br><br>
        <label>blurb: <textarea name="blurb" rows="2" cols="40"></textarea></label><br><br>
        <label>start date: <input type="date" name="start_date"></label>
        <label>end date: <input type="date" name="end_date"></label><br><br>
        <label>location: <input type="text" name="location"></label><br><br>
        <label>ticket link: <input type="text" name="ticket_url"></label><br><br>
        <label>parking link: <input type="text" name="parking_url"></label><br><br>
        <label>start item list with:
          <select name="clone_from">
            <option value="">-- start fresh --</option>
            <option value="preseed">★ ${PRESEED_LABEL} (${PRESEED_ITEMS.length} items)</option>
            ${existing.map((f) => html`<option value="${f.id}">copy from: ${f.name}</option>`)}
          </select>
        </label><br><br>
        <button class="btn" type="submit">create fest</button>
      </form>
    </div>`;

    return c.html(await renderPage(c, { title: 'add a fest', body }));
});

festivals.post('/fests', async (c) => {
    if (needsSignin(c)) return signinRedirect(c);
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const name = (body.name || '').toString().trim();
    if (!name) return c.redirect('/fests/new');

    const cloneFromRaw = (body.clone_from || '').toString();
    const usePreseed = cloneFromRaw === 'preseed';
    const cloneFrom = (!usePreseed && cloneFromRaw) ? Number(cloneFromRaw) : null;

    const result = await db.prepare(`
        INSERT INTO festivals (name, blurb, start_date, end_date, location, ticket_url, parking_url, cloned_from_festival_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        name,
        (body.blurb || '').toString() || null,
        (body.start_date || '').toString() || null,
        (body.end_date || '').toString() || null,
        (body.location || '').toString() || null,
        (body.ticket_url || '').toString() || null,
        (body.parking_url || '').toString() || null,
        cloneFrom,
        person ? person.id : null,
    ).run();
    const festId = result.meta.last_row_id;

    if (usePreseed) {
        for (const [name, emoji, needed_qty, unit] of PRESEED_ITEMS) {
            await db.prepare(`
                INSERT INTO items (festival_id, name, emoji, needed_qty, unit, added_by, is_seed, seed_label)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            `).bind(festId, name, emoji, needed_qty, unit, person ? person.id : null, PRESEED_LABEL).run();
        }
    } else if (cloneFrom) {
        const items = (await db.prepare('SELECT * FROM items WHERE festival_id = ? AND deleted_at IS NULL').bind(cloneFrom).all()).results;
        for (const item of items) {
            await db.prepare(`
                INSERT INTO items (festival_id, name, emoji, needed_qty, unit, category, added_by, is_seed, seed_label)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(festId, item.name, item.emoji, item.needed_qty, item.unit, item.category, person ? person.id : null, item.is_seed, item.seed_label).run();
        }
    }

    await db.prepare(`
        INSERT INTO checklist_tasks (festival_id, label, is_default) VALUES (?, 'festival pass', 1), (?, 'car pass', 1)
    `).bind(festId, festId).run();

    await logAction(c, {
        festivalId: festId, action: 'create', entityType: 'festivals', entityId: festId,
        summary: `${person ? person.display_name : 'someone'} created fest "${name}"${usePreseed ? ' (with must-have list)' : cloneFrom ? ' (cloned items)' : ''}`,
    });

    return c.redirect(`/f/${festId}`);
});

async function loadFestival(c) {
    const id = Number(c.req.param('id'));
    const db = c.env.DB;
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ? AND deleted_at IS NULL').bind(id).first();
    return festival;
}

festivals.get('/f/:id', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const db = c.env.DB;

    setCurrentFestCookie(c, festival.id);

    const seenCookieName = `seen_fest_${festival.id}`;
    if (!getCookie(c, seenCookieName)) {
        await db.prepare('UPDATE festivals SET hit_count = hit_count + 1 WHERE id = ?').bind(festival.id).run();
        setCookie(c, seenCookieName, '1', { path: '/', maxAge: 60 * 60 * 24 * 365 });
    }

    // Note: viewing a fest no longer auto-joins you — you join by doing something
    // here, or via the explicit "join" button (see /f/:id/join). This keeps the
    // ppl list to people who are actually going, not everyone who peeked.

    return c.redirect(`/f/${festival.id}/stuff`);
});

festivals.get('/f/:id/settings', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();

    const body = html`
    <div class="card">
      <h2>fest info</h2>
      <form method="post" action="/f/${festival.id}/settings">
        <label>name: <input type="text" name="name" value="${festival.name}" required></label><br><br>
        <label>blurb: <textarea name="blurb" rows="2" cols="40">${festival.blurb || ''}</textarea></label><br><br>
        <label>start date: <input type="date" name="start_date" value="${festival.start_date || ''}"></label>
        <label>end date: <input type="date" name="end_date" value="${festival.end_date || ''}"></label><br><br>
        <label>location: <input type="text" name="location" value="${festival.location || ''}"></label><br><br>
        <label>ticket link: <input type="text" name="ticket_url" value="${festival.ticket_url || ''}"></label><br><br>
        <label>parking link: <input type="text" name="parking_url" value="${festival.parking_url || ''}"></label><br><br>
        <button class="btn" type="submit">save</button>
      </form>
    </div>`;

    return c.html(await renderPage(c, { title: `${festival.name} settings`, festival, activeTab: 'settings', body }));
});

festivals.post('/f/:id/settings', async (c) => {
    if (needsSignin(c)) return signinRedirect(c);
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    const before = { name: festival.name, blurb: festival.blurb, start_date: festival.start_date, end_date: festival.end_date, location: festival.location, ticket_url: festival.ticket_url, parking_url: festival.parking_url };
    const after = {
        name: (body.name || '').toString().trim() || festival.name,
        blurb: (body.blurb || '').toString() || null,
        start_date: (body.start_date || '').toString() || null,
        end_date: (body.end_date || '').toString() || null,
        location: (body.location || '').toString() || null,
        ticket_url: (body.ticket_url || '').toString() || null,
        parking_url: (body.parking_url || '').toString() || null,
    };

    await db.prepare(`
        UPDATE festivals SET name=?, blurb=?, start_date=?, end_date=?, location=?, ticket_url=?, parking_url=? WHERE id=?
    `).bind(after.name, after.blurb, after.start_date, after.end_date, after.location, after.ticket_url, after.parking_url, festival.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'festivals', entityId: festival.id,
        before, after, reversible: true,
        summary: `${person ? person.display_name : 'someone'} updated fest info for "${after.name}"`,
    });

    return c.redirect(`/f/${festival.id}/settings`);
});
