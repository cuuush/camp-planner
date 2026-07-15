import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { logAction } from '../lib/audit.js';
import { sqlNow, createEffect, deleteEffect, fieldEffects } from '../lib/effects.js';
import { getItemMeta } from '../lib/emoji.js';
import { notify } from '../lib/notify.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';
import { loadComments, handleCommentPost } from '../lib/comments.js';
import { msnChat, escapeHtml } from '../render/msn.js';
import { xpCaptionBtns } from '../render/popup.js';

export const items = new Hono();

// Turns freeform "how many" text like "2 cases" or "a dozen" into a qty + unit pair.
// Leading integer becomes the qty, whatever's left (if anything) becomes the unit.
function parseQtyText(text) {
    const trimmed = (text || '').toString().trim();
    const match = trimmed.match(/^(\d+)\s*(.*)$/);
    if (match) {
        return { qty: Math.max(1, parseInt(match[1], 10)), unit: match[2].trim() || null };
    }
    return { qty: 1, unit: trimmed || null };
}

async function itemStats(db, item) {
    // Four independent lookups — fire them together, one round trip of wall time.
    const [pledges, votes, comments, adder] = await Promise.all([
        db.prepare(`
            SELECT p.id, p.qty, p.person_id, pe.display_name FROM pledges p
            JOIN people pe ON pe.id = p.person_id
            WHERE p.item_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at
        `).bind(item.id).all().then((r) => r.results),
        db.prepare('SELECT person_id FROM votes WHERE item_id = ? AND deleted_at IS NULL').bind(item.id).all().then((r) => r.results),
        loadComments(db, 'item', item.id),
        item.added_by
            ? db.prepare('SELECT display_name FROM people WHERE id = ?').bind(item.added_by).first()
            : null,
    ]);

    const pledgedQty = pledges.reduce((sum, p) => sum + p.qty, 0);

    return { pledges, pledgedQty, voteCount: votes.length, voterIds: votes.map((v) => v.person_id), comments, adderName: adder ? adder.display_name : null };
}

// The whole list's stats in one parallel burst of four festival-wide queries,
// instead of four queries PER item (the old N+1: a 20-item page spent ~80
// sequential D1 round trips here alone). Returns a Map keyed by item id with
// the same shape itemStats() produces.
async function allItemStats(db, festivalId, items) {
    const [pledges, votes, comments, adders] = await Promise.all([
        db.prepare(`
            SELECT p.id, p.qty, p.person_id, p.item_id, pe.display_name FROM pledges p
            JOIN people pe ON pe.id = p.person_id
            JOIN items i ON i.id = p.item_id
            WHERE i.festival_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at
        `).bind(festivalId).all().then((r) => r.results),
        db.prepare(`
            SELECT v.item_id, v.person_id FROM votes v
            JOIN items i ON i.id = v.item_id
            WHERE i.festival_id = ? AND v.deleted_at IS NULL
        `).bind(festivalId).all().then((r) => r.results),
        // Mirrors loadComments() (columns + INNER JOIN people + created_at order),
        // just fetched for every item of the fest at once.
        db.prepare(`
            SELECT cm.id, cm.body, cm.created_at, cm.target_id, pe.display_name FROM comments cm
            JOIN people pe ON pe.id = cm.person_id
            JOIN items i ON i.id = cm.target_id
            WHERE cm.target_type = 'item' AND i.festival_id = ? AND cm.deleted_at IS NULL
            ORDER BY cm.created_at
        `).bind(festivalId).all().then((r) => r.results),
        db.prepare(`
            SELECT i.id AS item_id, pe.display_name FROM items i
            JOIN people pe ON pe.id = i.added_by
            WHERE i.festival_id = ?
        `).bind(festivalId).all().then((r) => r.results),
    ]);

    const byItem = new Map(items.map((item) => [item.id,
        { pledges: [], pledgedQty: 0, voteCount: 0, voterIds: [], comments: [], adderName: null }]));
    // Rows for items not in the list (deleted ones) miss the Map and drop out.
    for (const p of pledges) byItem.get(p.item_id)?.pledges.push(p);
    for (const v of votes) {
        const s = byItem.get(v.item_id);
        if (s) { s.voteCount++; s.voterIds.push(v.person_id); }
    }
    for (const cm of comments) byItem.get(cm.target_id)?.comments.push(cm);
    for (const a of adders) {
        const s = byItem.get(a.item_id);
        if (s) s.adderName = a.display_name;
    }
    for (const s of byItem.values()) s.pledgedQty = s.pledges.reduce((sum, p) => sum + p.qty, 0);
    return byItem;
}

function itemRow(festival, item, stats, person, expanded = false, chatOpen = false) {
    const { pledges, pledgedQty, voteCount, voterIds, comments, adderName } = stats;
    const pct = item.needed_qty > 0 ? Math.min(100, Math.round((pledgedQty / item.needed_qty) * 100)) : 0;
    const unclaimed = pledgedQty === 0;
    const iVoted = person && voterIds.includes(person.id);
    const myPledge = person && pledges.find((p) => p.person_id === person.id);
    const remaining = Math.max(1, item.needed_qty - pledgedQty);
    const requestedBy = item.is_seed ? (item.seed_label || '') : `requested by ${adderName || 'someone'}`;

    return html`
    <div class="card item-card ${unclaimed ? 'unclaimed' : ''}" id="item-${item.id}" data-complete="${pledgedQty >= item.needed_qty ? '1' : '0'}">
      <details class="item-details" ${expanded ? 'open' : ''}>
        <summary class="item-summary">
          <div class="item-top-row">
            <span class="item-emoji">${item.emoji}</span>
            <div class="item-headline">
              <div class="item-name">${item.name}</div>
              ${item.description ? html`<div class="item-description">${item.description}</div>` : ''}
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
              <div class="item-tally">
                ${pledgedQty}/${item.needed_qty} ${item.unit || ''}
                ${pledges.length ? html` — ${pledges.map((p) => `${p.display_name} (${p.qty})`).join(', ')}` : ''}
              </div>
            </div>
            <button type="button" class="vote-thumb ${iVoted ? 'voted' : ''}"
              hx-post="/items/${item.id}/vote" hx-target="#item-${item.id}" hx-swap="outerHTML"
              hx-vals='js:{expanded: document.getElementById("item-${item.id}").querySelector(".item-details").open ? "1" : "0"}'
              onclick="event.stopPropagation(); if (!this.classList.contains('voted')) campConfetti(this);">
              👍<span class="vote-count">${voteCount}</span>
            </button>
          </div>
        </summary>

        <div class="item-actions">
          <div class="action-buttons">
            ${person
                ? html`<button type="button" class="btn btn-primary pledge-btn" onclick="document.getElementById('pledge-modal-${item.id}').style.display='flex'">
                    ${myPledge ? `bringing ${myPledge.qty} ${item.unit || ''}`.trim() : "i'll bring this"}
                  </button>`
                : html`<button type="button" class="btn btn-primary pledge-btn"
                    hx-get="/signin/modal?next=${encodeURIComponent(`/f/${festival.id}/stuff?expand=item-${item.id}&pledge=${item.id}`)}"
                    hx-target="#signin-modal-overlay" hx-swap="innerHTML">
                    i'll bring this
                  </button>`}

            <input type="checkbox" class="edit-toggle-checkbox" id="edit-toggle-item-${item.id}">
            <label class="btn edit-open-btn" for="edit-toggle-item-${item.id}">edit</label>
            <button class="btn btn-primary edit-save-btn" type="submit" form="edit-form-item-${item.id}">save</button>
              <form id="edit-form-item-${item.id}" class="edit-panel" hx-post="/items/${item.id}/edit" hx-target="#item-${item.id}" hx-swap="outerHTML" hx-vals='js:{chat_open: document.getElementById("chat-item-${item.id}")?.open ? 1 : 0}'>
                <div class="edit-panel-title">Edit Item</div>
                <div class="edit-requester">${requestedBy}</div>
                <div class="edit-field">
                  <label>emoji</label>
                  <input type="text" name="emoji" value="${item.emoji}" class="edit-emoji-input">
                </div>
                <div class="edit-field">
                  <label>name</label>
                  <input type="text" name="name" value="${item.name}" placeholder="item name">
                </div>
                <div class="edit-field">
                  <label>details</label>
                  <input type="text" name="description" value="${item.description || ''}" placeholder="optional">
                </div>
                <div class="edit-field">
                  <label>need</label>
                  <div class="edit-need">
                    <input type="number" name="needed_qty" value="${item.needed_qty}">
                    <input type="text" name="unit" value="${item.unit || ''}" placeholder="unit">
                  </div>
                </div>
                <div class="edit-panel-buttons">
                  <button class="btn btn-danger" type="submit" formaction="/items/${item.id}/delete" hx-post="/items/${item.id}/delete" hx-confirm="Are you sure you want to delete this item?">Delete</button>
                </div>
              </form>

            ${msnChat({
                title: `Chat (${comments.length} message${comments.length === 1 ? '' : 's'})`,
                dpEmoji: item.emoji,
                toLabel: `To: <b>${escapeHtml(item.name)}</b> &lt;everyone@camp&gt;`,
                comments,
                postUrl: `/items/${item.id}/comments`,
                target: `#item-${item.id}`,
                chatOpen,
                id: `chat-item-${item.id}`,
            })}
          </div>

          ${myPledge ? html`
            <form class="withdraw-form" hx-post="/pledges/${myPledge.id}/withdraw" hx-target="#item-${item.id}" hx-swap="outerHTML">
              <button class="btn" type="submit">withdraw my pledge</button>
            </form>` : ''}
        </div>
      </details>

      <div class="modal-backdrop" id="pledge-modal-${item.id}" style="display:none;" onclick="if(event.target===this) this.style.display='none'">
        <div class="modal-box xp-dialog">
          <div class="xp-dialog-title">
            <span class="xp-dialog-title-text">${item.emoji} ${item.name}</span>
            ${xpCaptionBtns({ min: false, max: false, onClose: `document.getElementById('pledge-modal-${item.id}').style.display='none'` })}
          </div>
          <div class="xp-dialog-body">
            <form hx-post="/items/${item.id}/pledge" hx-target="#item-${item.id}" hx-swap="outerHTML">
              <div class="pledge-prompt">
                <img class="xp-dialog-icon" src="/xp/dlg-question.png" alt="" aria-hidden="true">
                <div class="pledge-field-col">
                  <label class="pledge-label">How many are you bringing?</label>
                  <div class="pledge-input-row">
                    <input type="number" name="qty" value="${myPledge ? myPledge.qty : remaining}" min="1" class="pledge-modal-input" autofocus>
                    ${item.unit ? html`<span class="pledge-unit">${item.unit}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="dialog-buttons">
                <button class="btn btn-primary" type="submit">OK</button>
                <button class="btn" type="button" onclick="document.getElementById('pledge-modal-${item.id}').style.display='none'">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>`;
}

// Just the item rows — this is what #stuff-list actually contains, and the only
// thing mutation endpoints targeting #stuff-list should ever return.
async function itemListFragment(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');
    const sort = c.req.query('sort') || 'votes';
    const expand = c.req.query('expand') || '';

    const rows = (await db.prepare('SELECT * FROM items WHERE festival_id = ? AND deleted_at IS NULL').bind(festival.id).all()).results;

    const statsById = await allItemStats(db, festival.id, rows);
    const withStats = rows.map((item) => ({ item, stats: statsById.get(item.id) }));

    const bySort = (a, b) => (sort === 'name'
        ? a.item.name.localeCompare(b.item.name)
        : b.stats.voteCount - a.stats.voteCount);
    const incomplete = withStats.filter((x) => x.stats.pledgedQty < x.item.needed_qty).sort(bySort);
    const complete = withStats.filter((x) => x.stats.pledgedQty >= x.item.needed_qty).sort(bySort);

    // "expand" carries the id of an item that should open (e.g. after a sign-in
    // redirect replays a comment that was blocked mid-action) — and opens its chat.
    const row = ({ item, stats }) => itemRow(festival, item, stats, person, expand === `item-${item.id}`, expand === `item-${item.id}`);

    if (!withStats.length) return html`<p class="stuff-empty">There are no items in this view — add the first thing!</p>`;

    // XP Explorer "show in groups" style: two grouped sections with a header rule.
    // BOTH sections are always emitted (empty ones hidden via .is-empty) and carry
    // stable ids, so the client can relocate a card between them — e.g. bumping an
    // item's needed_qty flips it from "all covered" back into "still need these"
    // without a full re-render (see campReflowItems in camp.js).
    const section = (id, headerClass, label, group) => html`
      <div class="stuff-section ${group.length ? '' : 'is-empty'}" id="${id}">
        <div class="stuff-section-header ${headerClass}">${label} <span class="section-count">${group.length}</span></div>
        ${group.map(row)}
      </div>`;

    return html`
      ${section('stuff-incomplete', '', 'still need these', incomplete)}
      ${section('stuff-complete', 'done', 'all covered', complete)}
    `;
}

async function renderStuffBody(c, festival) {
    const list = await itemListFragment(c, festival);
    const sort = c.req.query('sort') || 'votes';

    return html`
    <div class="stuff-controls">
      <div class="sort-toggle">
        <span class="sort-label">sort by:</span>
        <a href="?sort=votes" class="${sort === 'votes' ? 'active' : ''}">votes</a>
        <a href="?sort=name" class="${sort === 'name' ? 'active' : ''}">name</a>
      </div>
      <button type="button" class="btn expand-all-btn" onclick="campToggleExpandAll(this)">⊞ Expand All</button>
    </div>

    <div class="add-stuff-bar">
      <button type="button" class="btn btn-primary add-stuff-btn"
        onclick="var m=document.getElementById('add-stuff-modal'); m.style.display='flex'; var i=m.querySelector('input[name=name]'); if(i) i.focus();">
        Add an Item…
      </button>
    </div>

    <div class="modal-backdrop" id="add-stuff-modal" style="display:none;" onclick="if(event.target===this) this.style.display='none'">
      <div class="modal-box xp-dialog">
        <div class="xp-dialog-title">
          <span class="xp-dialog-title-text">Add Item</span>
          ${xpCaptionBtns({ min: false, max: false, onClose: "document.getElementById('add-stuff-modal').style.display='none'" })}
        </div>
        <div class="xp-dialog-body">
          <form hx-post="/f/${festival.id}/items" hx-target="#stuff-list" hx-swap="innerHTML"
            hx-indicator="#add-stuff-spinner" hx-disabled-elt="#add-stuff-submit"
            hx-on::after-request="if(event.detail.successful){this.reset(); document.getElementById('add-stuff-modal').style.display='none';}">
            <div class="edit-field"><label>item</label><input type="text" name="name" placeholder="e.g. water" required></div>
            <div class="edit-field"><label>how many</label><input type="text" name="qty_text" placeholder="e.g. 2 cases"></div>
            <div class="edit-field"><label>details</label><input type="text" name="description" placeholder="optional"></div>
            <label class="xp-check-label" style="margin-top:12px;">
              <input type="checkbox" class="xp-check-input" name="bringing" value="1">
              <span class="xp-checkbox"></span>
              i'm bringing this — put me down for it
            </label>
            <div class="dialog-buttons">
              <button id="add-stuff-submit" class="btn btn-primary" type="submit">OK</button>
              <button class="btn" type="button" onclick="document.getElementById('add-stuff-modal').style.display='none'">Cancel</button>
            </div>
            <!-- Shown by htmx (via hx-indicator) only while the add request is in
                 flight — i.e. while the LLM is picking an emoji/unit for the item. -->
            <div id="add-stuff-spinner" class="xp-spinner-row">
              <span class="xp-spinner" aria-hidden="true"></span>
              <span>Please wait while camp planner finds the perfect emoji…</span>
            </div>
          </form>
        </div>
      </div>
    </div>

    <div id="stuff-list">
      ${list}
    </div>
  `;
}

items.get('/f/:id/stuff', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await renderStuffBody(c, festival);
    return c.html(await renderPage(c, { title: `${festival.name} — Stuff`, festival, activeTab: 'stuff', body }));
});

items.post('/f/:id/items', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c);
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const name = (body.name || '').toString().trim();
    const description = (body.description || '').toString().trim() || null;
    if (!name) return c.html(await itemListFragment(c, festival));

    const { emoji, unit: guessedUnit } = await getItemMeta(c.env, name);
    const { qty, unit: typedUnit } = parseQtyText(body.qty_text);

    const result = await db.prepare(`
        INSERT INTO items (festival_id, name, description, emoji, needed_qty, unit, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
        festival.id, name, description, emoji,
        qty,
        typedUnit || guessedUnit || null,
        person ? person.id : null,
    ).run();

    const itemId = result.meta.last_row_id;
    await logAction(c, {
        festivalId: festival.id, action: 'create', entityType: 'items', entityId: itemId,
        reversible: true, effects: [createEffect('items', itemId, sqlNow())],
        summary: `${person ? person.display_name : 'someone'} added ${emoji} ${name}`,
    });

    // "i'm bringing this" checked → pledge the whole asked-for amount right away,
    // so adding something you've already got covered is one step, not two.
    const bringing = !!body.bringing && person;
    if (bringing) {
        const pledgeResult = await db.prepare('INSERT INTO pledges (item_id, person_id, qty) VALUES (?, ?, ?)')
            .bind(itemId, person.id, qty).run();
        await logAction(c, {
            festivalId: festival.id, action: 'create', entityType: 'pledges', entityId: pledgeResult.meta.last_row_id,
            reversible: true, effects: [createEffect('pledges', pledgeResult.meta.last_row_id, sqlNow())],
            summary: `${person.display_name} is bringing ${emoji} ${name}`,
        });
    }

    const list = await itemListFragment(c, festival);
    return c.html(html`<div id="toast" hx-swap-oob="true">✅ added ${emoji} ${name}${bringing ? " — it's on you!" : '!'}</div>${list}`);
});

async function loadItem(c) {
    const id = Number(c.req.param('itemId'));
    const db = c.env.DB;
    const item = await db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').bind(id).first();
    if (!item) return null;
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(item.festival_id).first();
    return { item, festival };
}

async function itemRowResponse(c, festival, itemId, expanded = false, chatOpen = false) {
    const db = c.env.DB;
    const person = c.get('person');
    const item = await db.prepare('SELECT * FROM items WHERE id = ?').bind(itemId).first();
    if (!item || item.deleted_at) return c.html('');
    const stats = await itemStats(db, item);
    return c.html(itemRow(festival, item, stats, person, expanded, chatOpen));
}

items.post('/items/:itemId/edit', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `item-${loaded.item.id}` });
    const { item, festival } = loaded;
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();

    const before = { name: item.name, emoji: item.emoji, needed_qty: item.needed_qty, unit: item.unit, description: item.description };
    const after = {
        name: (body.name || '').toString().trim() || item.name,
        emoji: (body.emoji || '').toString().trim() || item.emoji,
        needed_qty: Number(body.needed_qty) || item.needed_qty,
        unit: (body.unit || '').toString() || null,
        description: (body.description || '').toString().trim() || null,
    };

    await db.prepare('UPDATE items SET name=?, emoji=?, needed_qty=?, unit=?, description=? WHERE id=?')
        .bind(after.name, after.emoji, after.needed_qty, after.unit, after.description, item.id).run();

    // One effect per CHANGED column only — undoing an old edit reverts just what it
    // touched, never blind-clobbering a newer edit (G5).
    const effects = fieldEffects('items', item.id, before, after);

    // Leave a trail in the comments so "why does this need 4 now?" is self-answering.
    const changes = [];
    if (before.name !== after.name) changes.push(`renamed it from "${before.name}" to "${after.name}"`);
    if (before.emoji !== after.emoji) changes.push(`changed the emoji to ${after.emoji}`);
    if (before.needed_qty !== after.needed_qty) changes.push(`changed how many are needed from ${before.needed_qty} to ${after.needed_qty}`);
    if (before.unit !== after.unit) changes.push(`changed the unit to "${after.unit || '(none)'}"`);

    if (changes.length) {
        // Drop an auto-note into the item's comment thread so the change is
        // self-explaining — but DON'T log it separately. Instead fold the note's
        // deleted_at into THIS edit's effects, so undoing the edit also hides the
        // now-false note ("changed 3 to 6" when it's back to 3) — closing G10.
        const noteBody = changes.join(', ');
        const noteResult = await db.prepare("INSERT INTO comments (target_type, target_id, person_id, body) VALUES ('item', ?, ?, ?)")
            .bind(item.id, person ? person.id : null, noteBody).run();
        effects.push(createEffect('comments', noteResult.meta.last_row_id, sqlNow()));
    }

    await logAction(c, {
        festivalId: festival.id, action: 'update', entityType: 'items', entityId: item.id,
        before, after, effects, reversible: true,
        summary: `${person ? person.display_name : 'someone'} changed ${after.name}`,
    });

    return itemRowResponse(c, festival, item.id, true, body.chat_open === '1');
});

items.post('/items/:itemId/delete', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `item-${loaded.item.id}` });
    const { item, festival } = loaded;
    const db = c.env.DB;
    const person = c.get('person');

    const stamp = sqlNow();
    await db.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').bind(stamp, item.id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'items', entityId: item.id,
        reversible: true, effects: [deleteEffect('items', item.id, stamp)],
        summary: `${person ? person.display_name : 'someone'} deleted ${item.emoji} ${item.name}`,
    });

    return c.html('');
});

items.post('/items/:itemId/vote', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `item-${item.id}` });
    const db = c.env.DB;
    const person = c.get('person');
    // The vote button sends the card's current open state so voting doesn't
    // collapse a card you'd expanded (or expand one you'd left collapsed).
    const voteBody = await c.req.parseBody().catch(() => ({}));
    const expanded = voteBody.expanded === '1';

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

    return itemRowResponse(c, festival, item.id, expanded);
});

items.post('/items/:itemId/pledge', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `item-${item.id}` });
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const qty = Math.max(1, Number(body.qty) || 1);

    // Re-pledging changes the amount on your existing pledge instead of stacking a second row.
    const existing = await db.prepare('SELECT * FROM pledges WHERE item_id = ? AND person_id = ? AND deleted_at IS NULL').bind(item.id, person.id).first();

    if (existing) {
        const newQty = qty;
        await db.prepare('UPDATE pledges SET qty = ? WHERE id = ?').bind(newQty, existing.id).run();
        await logAction(c, {
            festivalId: festival.id, action: 'update', entityType: 'pledges', entityId: existing.id,
            before: { qty: existing.qty }, after: { qty: newQty }, reversible: true,
            effects: fieldEffects('pledges', existing.id, { qty: existing.qty }, { qty: newQty }),
            summary: `${person.display_name} changed their pledge on ${item.emoji} ${item.name} to ${newQty}`,
        });
    } else {
        const result = await db.prepare('INSERT INTO pledges (item_id, person_id, qty) VALUES (?, ?, ?)')
            .bind(item.id, person.id, qty).run();
        await logAction(c, {
            festivalId: festival.id, action: 'create', entityType: 'pledges', entityId: result.meta.last_row_id,
            reversible: true, effects: [createEffect('pledges', result.meta.last_row_id, sqlNow())],
            summary: `${person.display_name} pledged ${qty} ${item.unit || ''} of ${item.emoji} ${item.name}`,
        });
    }

    // After the response — the click shouldn't wait on the email provider.
    c.executionCtx.waitUntil(notify(c.env, {
        festivalId: festival.id, targetPersonId: item.added_by, actorPersonId: person.id,
        heading: `${person.display_name} pledged your item`,
        body: `${person.display_name} pledged ${qty} of ${item.name} on ${festival.name}.`,
    }));

    return itemRowResponse(c, festival, item.id, true);
});

items.post('/pledges/:pledgeId/withdraw', async (c) => {
    const id = Number(c.req.param('pledgeId'));
    const db = c.env.DB;
    const pledge = await db.prepare('SELECT * FROM pledges WHERE id = ?').bind(id).first();
    if (!pledge) return c.notFound();
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `item-${pledge.item_id}` });
    const person = c.get('person');
    const item = await db.prepare('SELECT * FROM items WHERE id = ?').bind(pledge.item_id).first();
    const festival = await db.prepare('SELECT * FROM festivals WHERE id = ?').bind(item.festival_id).first();

    const stamp = sqlNow();
    await db.prepare('UPDATE pledges SET deleted_at = ? WHERE id = ?').bind(stamp, id).run();

    await logAction(c, {
        festivalId: festival.id, action: 'delete', entityType: 'pledges', entityId: id,
        reversible: true, effects: [deleteEffect('pledges', id, stamp)],
        summary: `${person ? person.display_name : 'someone'} withdrew their pledge on ${item.name}`,
    });

    return itemRowResponse(c, festival, item.id, true);
});

items.post('/items/:itemId/comments', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `item-${item.id}` });
    const person = c.get('person');
    return handleCommentPost(c, {
        festival, targetType: 'item', targetId: item.id,
        ownerPersonId: item.added_by,
        summary: `${person.display_name} commented on ${item.name}`,
        notifyHeading: `${person.display_name} commented on your item`,
        notifyBody: (text) => `${person.display_name} said "${text}" on ${item.name} (${festival.name}).`,
        respond: () => itemRowResponse(c, festival, item.id, true, true),
    });
});
