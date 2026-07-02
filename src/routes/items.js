import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { getEmojiForItem } from '../lib/emoji.js';
import { notify } from '../lib/notify.js';

export const items = new Hono();

async function itemStats(db, item) {
    const pledges = (await db.prepare(`
        SELECT p.id, p.qty, p.person_id, pe.display_name FROM pledges p
        JOIN people pe ON pe.id = p.person_id
        WHERE p.item_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at
    `).bind(item.id).all()).results;

    const pledgedQty = pledges.reduce((sum, p) => sum + p.qty, 0);

    const votes = (await db.prepare('SELECT person_id FROM votes WHERE item_id = ? AND deleted_at IS NULL').bind(item.id).all()).results;

    const comments = (await db.prepare(`
        SELECT c.id, c.body, c.created_at, pe.display_name FROM comments c
        JOIN people pe ON pe.id = c.person_id
        WHERE c.target_type = 'item' AND c.target_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at
    `).bind(item.id).all()).results;

    return { pledges, pledgedQty, voteCount: votes.length, voterIds: votes.map((v) => v.person_id), comments };
}

function itemRow(festival, item, stats, person) {
    const { pledges, pledgedQty, voteCount, voterIds, comments } = stats;
    const pct = item.needed_qty > 0 ? Math.min(100, Math.round((pledgedQty / item.needed_qty) * 100)) : 0;
    const unclaimed = pledgedQty === 0;
    const iVoted = person && voterIds.includes(person.id);
    const myPledge = person && pledges.find((p) => p.person_id === person.id);

    return html`
    <details class="card ${unclaimed ? 'unclaimed' : ''}" id="item-${item.id}">
      <summary>
        <span style="font-size:1.3em">${item.emoji}</span>
        <b>${item.name}</b>
        ${item.is_seed ? html`<span class="rainbow"> ~ cush's 2026 forest must have list ~</span>` : ''}
        <span style="float:right">👍 ${voteCount}</span><br>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        ${pledgedQty}/${item.needed_qty} ${item.unit || ''} ${unclaimed ? html`<b style="color:#ff0000">UNCLAIMED!</b>` : ''}
        ${pledges.length ? html` — ${pledges.map((p) => `${p.display_name} (${p.qty})`).join(', ')}` : ''}
      </summary>

      <div style="padding:8px 0">
        <form hx-post="/items/${item.id}/vote" hx-target="#item-${item.id}" hx-swap="outerHTML" style="display:inline">
          <button class="btn" type="submit">${iVoted ? '👍 unvote' : '👍 vote'}</button>
        </form>

        <form hx-post="/items/${item.id}/pledge" hx-target="#item-${item.id}" hx-swap="outerHTML" style="display:inline">
          <input type="number" name="qty" value="1" min="1" style="width:50px">
          <button class="btn" type="submit">i got one!!</button>
        </form>

        ${myPledge ? html`
          <form hx-post="/pledges/${myPledge.id}/withdraw" hx-target="#item-${item.id}" hx-swap="outerHTML" style="display:inline">
            <button class="btn" type="submit">withdraw mine</button>
          </form>` : ''}

        <details style="margin-top:6px">
          <summary>edit</summary>
          <form hx-post="/items/${item.id}/edit" hx-target="#item-${item.id}" hx-swap="outerHTML">
            <input type="text" name="emoji" value="${item.emoji}" style="width:40px">
            <input type="text" name="name" value="${item.name}">
            need: <input type="number" name="needed_qty" value="${item.needed_qty}" style="width:60px">
            <input type="text" name="unit" value="${item.unit || ''}" placeholder="unit" style="width:70px">
            <input type="text" name="category" value="${item.category || ''}" placeholder="category" style="width:90px">
            <button class="btn" type="submit">save</button>
          </form>
          <form hx-post="/items/${item.id}/delete" hx-target="#item-${item.id}" hx-swap="outerHTML" hx-confirm="delete this item?">
            <button class="btn" type="submit">delete</button>
          </form>
        </details>

        <div style="margin-top:6px">
          ${comments.map((cm) => html`<div class="comment"><b>${cm.display_name}:</b> ${cm.body}</div>`)}
          <form hx-post="/items/${item.id}/comments" hx-target="#item-${item.id}" hx-swap="outerHTML">
            <input type="text" name="body" placeholder="say something..." style="width:70%">
            <button class="btn" type="submit">post</button>
          </form>
        </div>
      </div>
    </details>`;
}

async function renderStuffBody(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');
    const sort = c.req.query('sort') || 'votes';

    const rows = (await db.prepare('SELECT * FROM items WHERE festival_id = ? AND deleted_at IS NULL').bind(festival.id).all()).results;

    const withStats = [];
    for (const item of rows) {
        withStats.push({ item, stats: await itemStats(db, item) });
    }

    withStats.sort((a, b) => {
        const aUnclaimed = a.stats.pledgedQty === 0 ? 1 : 0;
        const bUnclaimed = b.stats.pledgedQty === 0 ? 1 : 0;
        if (aUnclaimed !== bUnclaimed) return bUnclaimed - aUnclaimed;
        if (sort === 'name') return a.item.name.localeCompare(b.item.name);
        return b.stats.voteCount - a.stats.voteCount;
    });

    return html`
    <div class="divider">★ whos bringing what ★</div>
    <p><a href="?sort=votes">sort by votes</a> | <a href="?sort=name">sort by name</a></p>

    <details class="card">
      <summary><b>+ add stuff</b></summary>
      <form hx-post="/f/${festival.id}/items" hx-target="#stuff-list" hx-swap="innerHTML">
        <input type="text" name="name" placeholder="item name (e.g. water)" required>
        need: <input type="number" name="needed_qty" value="1" min="1" style="width:60px">
        <input type="text" name="unit" placeholder="unit (e.g. packs)" style="width:90px">
        <input type="text" name="category" placeholder="category (optional)" style="width:110px">
        <button class="btn" type="submit">add it</button>
      </form>
    </details>

    <div id="stuff-list">
      ${withStats.map(({ item, stats }) => itemRow(festival, item, stats, person))}
    </div>
  `;
}

items.get('/f/:id/stuff', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await renderStuffBody(c, festival);
    return c.html(await renderPage(c, { title: `${festival.name} — stuff`, festival, activeTab: 'stuff', body }));
});

items.post('/f/:id/items', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const name = (body.name || '').toString().trim();
    if (!name) return c.html(await renderStuffBody(c, festival));

    const emoji = await getEmojiForItem(c.env, name);

    const result = await db.prepare(`
        INSERT INTO items (festival_id, name, emoji, needed_qty, unit, category, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
        festival.id, name, emoji,
        Number(body.needed_qty) || 1,
        (body.unit || '').toString() || null,
        (body.category || '').toString() || null,
        person ? person.id : null,
    ).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'items', entityId: result.meta.last_row_id,
        reversible: true,
        summary: `${person ? person.display_name : 'someone'} added ${emoji} ${name}`,
    });

    return c.html(await renderStuffBody(c, festival));
});

async function loadItem(c) {
    const id = Number(c.req.param('itemId'));
    const db = c.env.DB;
    const item = await db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').bind(id).first();
    if (!item) return null;
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(item.festival_id).first();
    return { item, festival };
}

async function itemRowResponse(c, festival, itemId) {
    const db = c.env.DB;
    const person = c.get('person');
    const item = await db.prepare('SELECT * FROM items WHERE id = ?').bind(itemId).first();
    if (!item || item.deleted_at) return c.html('');
    const stats = await itemStats(db, item);
    return c.html(itemRow(festival, item, stats, person));
}

items.post('/items/:itemId/edit', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    const before = { name: item.name, emoji: item.emoji, needed_qty: item.needed_qty, unit: item.unit, category: item.category };
    const after = {
        name: (body.name || '').toString().trim() || item.name,
        emoji: (body.emoji || '').toString().trim() || item.emoji,
        needed_qty: Number(body.needed_qty) || item.needed_qty,
        unit: (body.unit || '').toString() || null,
        category: (body.category || '').toString() || null,
    };

    await db.prepare('UPDATE items SET name=?, emoji=?, needed_qty=?, unit=?, category=? WHERE id=?')
        .bind(after.name, after.emoji, after.needed_qty, after.unit, after.category, item.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'items', entityId: item.id,
        before, after, reversible: true,
        summary: `${person ? person.display_name : 'someone'} changed ${after.name}`,
    });

    return itemRowResponse(c, festival, item.id);
});

items.post('/items/:itemId/delete', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    const db = c.env.DB;
    const person = c.get('person');

    await db.prepare("UPDATE items SET deleted_at = datetime('now') WHERE id = ?").bind(item.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'items', entityId: item.id,
        reversible: true,
        summary: `${person ? person.display_name : 'someone'} deleted ${item.emoji} ${item.name}`,
    });

    return c.html('');
});

items.post('/items/:itemId/vote', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) return itemRowResponse(c, festival, item.id);

    const existing = await db.prepare('SELECT * FROM votes WHERE item_id = ? AND person_id = ?').bind(item.id, person.id).first();

    if (existing && !existing.deleted_at) {
        await db.prepare("UPDATE votes SET deleted_at = datetime('now') WHERE id = ?").bind(existing.id).run();
        await logAction(c, { festivalId: festival.id, action: 'update', entityType: 'votes', entityId: existing.id, summary: `${person.display_name} unvoted ${item.name}` });
    } else if (existing) {
        await db.prepare('UPDATE votes SET deleted_at = NULL WHERE id = ?').bind(existing.id).run();
        await logAction(c, { festivalId: festival.id, action: 'update', entityType: 'votes', entityId: existing.id, summary: `${person.display_name} voted for ${item.name}` });
    } else {
        const result = await db.prepare('INSERT INTO votes (item_id, person_id) VALUES (?, ?)').bind(item.id, person.id).run();
        await logAction(c, { festivalId: festival.id, action: 'create', entityType: 'votes', entityId: result.meta.last_row_id, summary: `${person.display_name} voted for ${item.name}` });
    }

    return itemRowResponse(c, festival, item.id);
});

items.post('/items/:itemId/pledge', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) return itemRowResponse(c, festival, item.id);
    const body = await c.req.parseBody();
    const qty = Math.max(1, Number(body.qty) || 1);

    const result = await db.prepare('INSERT INTO pledges (item_id, person_id, qty) VALUES (?, ?, ?)')
        .bind(item.id, person.id, qty).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'pledges', entityId: result.meta.last_row_id,
        reversible: true,
        summary: `${person.display_name} pledged ${qty} ${item.unit || ''} of ${item.emoji} ${item.name}`,
    });

    await notify(c.env, {
        festivalId: festival.id, targetPersonId: item.added_by, actorPersonId: person.id,
        heading: `${person.display_name} pledged your item`,
        body: `${person.display_name} pledged ${qty} of ${item.name} on ${festival.name}.`,
    });

    return itemRowResponse(c, festival, item.id);
});

items.post('/pledges/:pledgeId/withdraw', async (c) => {
    const id = Number(c.req.param('pledgeId'));
    const db = c.env.DB;
    const person = c.get('person');
    const pledge = await db.prepare('SELECT * FROM pledges WHERE id = ?').bind(id).first();
    if (!pledge) return c.notFound();
    const item = await db.prepare('SELECT * FROM items WHERE id = ?').bind(pledge.item_id).first();
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(item.festival_id).first();

    await db.prepare("UPDATE pledges SET deleted_at = datetime('now') WHERE id = ?").bind(id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'pledges', entityId: id,
        reversible: true,
        summary: `${person ? person.display_name : 'someone'} withdrew their pledge on ${item.name}`,
    });

    return itemRowResponse(c, festival, item.id);
});

items.post('/items/:itemId/comments', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    if (!person) return itemRowResponse(c, festival, item.id);
    const body = await c.req.parseBody();
    const text = (body.body || '').toString().trim();
    if (!text) return itemRowResponse(c, festival, item.id);

    const result = await db.prepare("INSERT INTO comments (target_type, target_id, person_id, body) VALUES ('item', ?, ?, ?)")
        .bind(item.id, person.id, text).run();

    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'comments', entityId: result.meta.last_row_id,
        reversible: true,
        summary: `${person.display_name} commented on ${item.name}`,
    });

    await notify(c.env, {
        festivalId: festival.id, targetPersonId: item.added_by, actorPersonId: person.id,
        heading: `${person.display_name} commented on your item`,
        body: `${person.display_name} said "${text}" on ${item.name} (${festival.name}).`,
    });

    return itemRowResponse(c, festival, item.id);
});
