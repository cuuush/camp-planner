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

// An item's name dropped into the middle of a sentence ("How many tapestries…").
// Names are typed sentence-case, so the leading capital has to come off — but only
// when it's an ordinary word: "LED strips" and "EZ-Ups" are spelled that way on
// purpose, and a first word that's shouting is left alone.
function midSentence(name) {
    const s = (name || '').toString().trim();
    const first = s.split(/\s+/)[0] || '';
    if (first.length > 1 && first === first.toUpperCase()) return s;
    return s.charAt(0).toLowerCase() + s.slice(1);
}

// Rough English plural for the LAST word of an item's name, used when the name is
// standing in for a missing unit: "How many broom are you bringing?" is worse than
// anything this can get wrong. Names are typed however people type them, so it's
// deliberately conservative — already ends in an s (Tapestries, Spare chairs), or
// doesn't end in a letter at all ("Ice (bagged)"), and it's left alone.
function pluralize(name) {
    const m = (name || '').match(/^(.*?)([A-Za-z]+)$/);
    if (!m) return name;
    const [, head, word] = m;
    const lower = word.toLowerCase();
    if (lower.endsWith('s')) return name;
    if (/(x|z|ch|sh)$/.test(lower)) return `${head}${word}es`;
    if (/[^aeiou]y$/.test(lower)) return `${head}${word.slice(0, -1)}ies`;
    return `${head}${word}s`;
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

// The item rows AND the whole list's stats in ONE D1 round trip: five
// festival-wide statements in a single db.batch(), instead of four queries PER
// item (the old N+1: a 20-item page spent ~80 sequential D1 round trips here
// alone) and then instead of items-first-then-stats (the stats only need the
// festival id, never the rows, so waiting for the rows was a wasted hop).
// Returns { rows, statsById } — statsById has the same shape itemStats() produces.
async function loadItemsWithStats(db, festivalId) {
    const [items, pledges, votes, comments, adders] = (await db.batch([
        db.prepare('SELECT * FROM items WHERE festival_id = ? AND deleted_at IS NULL').bind(festivalId),
        db.prepare(`
            SELECT p.id, p.qty, p.person_id, p.item_id, pe.display_name FROM pledges p
            JOIN people pe ON pe.id = p.person_id
            JOIN items i ON i.id = p.item_id
            WHERE i.festival_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at
        `).bind(festivalId),
        db.prepare(`
            SELECT v.item_id, v.person_id FROM votes v
            JOIN items i ON i.id = v.item_id
            WHERE i.festival_id = ? AND v.deleted_at IS NULL
        `).bind(festivalId),
        // Mirrors loadComments() (columns + INNER JOIN people + created_at order),
        // just fetched for every item of the fest at once.
        db.prepare(`
            SELECT cm.id, cm.body, cm.created_at, cm.target_id, pe.display_name FROM comments cm
            JOIN people pe ON pe.id = cm.person_id
            JOIN items i ON i.id = cm.target_id
            WHERE cm.target_type = 'item' AND i.festival_id = ? AND cm.deleted_at IS NULL
            ORDER BY cm.created_at
        `).bind(festivalId),
        db.prepare(`
            SELECT i.id AS item_id, pe.display_name FROM items i
            JOIN people pe ON pe.id = i.added_by
            WHERE i.festival_id = ?
        `).bind(festivalId),
    ])).map((r) => r.results);

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
    return { rows: items, statsById: byItem };
}

function itemRow(festival, item, stats, person, expanded = false, chatOpen = false) {
    const { pledges, pledgedQty, voteCount, voterIds, comments, adderName } = stats;
    const pctOf = (q) => (item.needed_qty > 0 ? Math.min(100, Math.round((q / item.needed_qty) * 100)) : 0);
    const pct = pctOf(pledgedQty);
    const unclaimed = pledgedQty === 0;
    const iVoted = person && voterIds.includes(person.id);
    const myPledge = person && pledges.find((p) => p.person_id === person.id);
    const remaining = Math.max(1, item.needed_qty - pledgedQty);
    const requestedBy = item.is_seed ? (item.seed_label || '') : `requested by ${adderName || 'someone'}`;

    // The header check box is a promise, not a vote: ticked only when YOU are down
    // for some of this. Once an item is fully covered there's nothing left to tick,
    // so the empty box disappears — unless you're one of the people bringing it, in
    // which case the ticked box stays as the way to back out again.
    const covered = pledgedQty >= item.needed_qty;
    const showCheck = !covered || !!myPledge;
    // The dialog only earns its interruption when there's a real question to ask, and
    // that's only ever on the way IN: how many of the OUTSTANDING amount are you
    // taking? One left to cover and the answer can only be "one", so don't ask.
    // Note it's REMAINING, not needed_qty: an item wanting six with five spoken for
    // behaves exactly like a one-of item.
    //
    // Unticking never asks. A ticked box means "I'm bringing some of this", so the
    // only thing clicking it can mean is "no I'm not" — it drops your pledge whole,
    // whatever the number was. It used to reopen the dialog to let you talk the
    // figure down instead, which put a question in front of the one gesture on the
    // card that reads as instant. Changing your mind about the amount is now
    // untick → tick, and the second tick asks you the number again.
    // Also gates whether the modal is rendered at all: every card used to carry a
    // hidden dialog it had no way to raise, ~19% of the page's HTML for nothing.
    // Needs a signed-in person and a visible check box, or there's no way to open
    // the dialog on this page at all: signed out, the box goes to the sign-in
    // window instead, and the sign-in round trip re-renders the card anyway.
    const askQty = !!person && showCheck && !myPledge && remaining > 1;
    // The dialog's own notes, kept here rather than as HTML comments inside it:
    // min=0 on the qty field is deliberate — it's the same as Cancel, and posting a 0
    // is harmless (you weren't down for any). It carries no autofocus attribute
    // because that does nothing on a dialog that starts hidden — campOpenPledge
    // focuses it on the way in; and the bar can't move while the box is merely
    // opening a dialog, so the optimistic update runs on OK instead, off
    // data-others (everyone else's pledged qty, which plus what you type is the
    // new total).
    const openPledgeDialog = `campOpenPledge(${item.id})`;
    // What the dialog counts in. Most items get a unit from the LLM ("cases", "bags"),
    // but plenty don't — and "How many are you bringing?" beside a bare number box is
    // a worse question than the item's own name answers: for Tapestries, tapestries.
    const pledgeUnit = item.unit || pluralize(midSentence(item.name));
    // Every control in the card swaps the WHOLE card out, so each one has to hand
    // back the two bits of open/closed state the server can't know: whether the card
    // is expanded and whether its comments window is open. Miss either and liking
    // something slams the comments shut under you.
    const expandedVal = `document.getElementById("item-${item.id}").querySelector(".item-details").open ? "1" : "0"`;
    const chatOpenVal = `document.getElementById("chat-item-${item.id}")?.open ? "1" : "0"`;
    // The "(n)" after a name in the tally is only worth printing when there's a
    // number to disambiguate: on a one-of item "1/1 chris (1)" says "one" three
    // times. Kept if someone somehow pledged more than the single one asked for.
    const pledgeLabel = (p) => (item.needed_qty === 1 && p.qty === 1 ? p.display_name : `${p.display_name} (${p.qty})`);
    // NB: keep prose OUT of the html`` templates below — an HTML comment inside a
    // per-card template ships to the browser once per card (72× on this page). Every
    // note here is a JS comment for exactly that reason. See AGENTS.md gotcha 21.

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
                ${pledges.length ? html` - ${pledges.map(pledgeLabel).join(', ')}` : ''}
              </div>
            </div>
            ${!showCheck ? '' : !person
                ? html`<button type="button" class="pledge-check" role="checkbox" aria-checked="false" aria-label="i'll bring this"
                    hx-get="/signin/modal?next=${encodeURIComponent(`/f/${festival.id}/stuff?expand=item-${item.id}&pledge=${item.id}`)}"
                    hx-target="#signin-modal-overlay" hx-swap="innerHTML"
                    onclick="event.stopPropagation();">
                    <span class="xp-checkbox"></span>
                  </button>`
                : askQty
                    // There's a number to settle — hand it to the dialog. The tick
                    // itself waits for OK (campPledgeDialogOptimistic), so cancelling
                    // leaves the box exactly as it was. Always an EMPTY box: askQty is
                    // the ticking direction only, so you can't be pledged here.
                    ? html`<button type="button" class="pledge-check" role="checkbox" aria-checked="false" aria-label="i'll bring this"
                        onclick="event.stopPropagation(); ${openPledgeDialog}">
                        <span class="xp-checkbox"></span>
                      </button>`
                    // Nothing to ask: one left to cover, or you're unticking. Straight
                    // through — ticking puts you down for whatever's outstanding, and
                    // unticking posts qty 0, which takes your whole pledge off however
                    // many you were down for.
                    // The two bar widths this tick moves between, handed over so the
                    // client can run the bar the instant it's tapped instead of
                    // waiting on the round trip. Off = what everyone else has
                    // pledged. On = full when ticking covers the last of it, and
                    // simply where the bar already is for a box that's ticked now
                    // (only reachable by double-tapping ahead of the swap).
                    : html`<button type="button" class="pledge-check" role="checkbox" aria-checked="${myPledge ? 'true' : 'false'}" aria-label="i'll bring this"
                        data-pct-on="${myPledge ? pct : 100}" data-pct-off="${pctOf(pledgedQty - (myPledge ? myPledge.qty : 0))}"
                        hx-post="/items/${item.id}/pledge" hx-target="#item-${item.id}" hx-swap="outerHTML"
                        hx-vals='js:{qty: ${myPledge ? 0 : remaining}, expanded: ${expandedVal}, chat_open: ${chatOpenVal}}'
                        onclick="event.stopPropagation(); if (!this.querySelector('.xp-checkbox').classList.contains('checked')) campConfetti(this); campPledgeOptimistic(this);">
                        <span class="xp-checkbox ${myPledge ? 'checked' : ''}"></span>
                      </button>`}
          </div>
        </summary>

        <div class="item-actions">
          <div class="action-buttons">
            <button type="button" class="btn btn-primary like-btn ${iVoted ? 'voted' : ''}"
              hx-post="/items/${item.id}/vote" hx-target="#item-${item.id}" hx-swap="outerHTML"
              hx-vals='js:{expanded: ${expandedVal}, chat_open: ${chatOpenVal}}'
              onclick="if (!this.classList.contains('voted')) campConfetti(this); campVoteOptimistic(this);">
              like (<span class="vote-count">${voteCount}</span>)
            </button>

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
                title: `Comments (${comments.length})`,
                dpEmoji: item.emoji,
                toLabel: `To: <b>${escapeHtml(item.name)}</b> &lt;everyone@camp&gt;`,
                comments,
                postUrl: `/items/${item.id}/comments`,
                target: `#item-${item.id}`,
                chatOpen,
                id: `chat-item-${item.id}`,
            })}
          </div>
        </div>
      </details>

      ${!askQty ? '' : html`
      <div class="modal-backdrop pledge-modal" id="pledge-modal-${item.id}" style="display:none;" onclick="if(event.target===this) this.style.display='none'">
        <div class="modal-box xp-dialog">
          <div class="xp-dialog-title">
            <span class="xp-dialog-title-text">Confirm Quantity</span>
            ${xpCaptionBtns({ min: false, max: false, onClose: `document.getElementById('pledge-modal-${item.id}').style.display='none'` })}
          </div>
          <div class="xp-dialog-body">
            <form hx-post="/items/${item.id}/pledge" hx-target="#item-${item.id}" hx-swap="outerHTML"
              hx-vals='js:{expanded: ${expandedVal}, chat_open: ${chatOpenVal}}'
              onsubmit="campPledgeDialogOptimistic(this)"
              data-item-id="${item.id}" data-needed="${item.needed_qty}"
              data-others="${pledgedQty}">
              <div class="pledge-prompt">
                <img class="xp-dialog-icon" src="/xp/dlg-question.png" alt="" aria-hidden="true">
                <div class="pledge-field-col">
                  <label class="pledge-label">How many ${pledgeUnit} are you bringing?</label>
                  <div class="pledge-input-row">
                    <input type="number" name="qty" value="${remaining}" min="0" class="pledge-modal-input">
                  </div>
                </div>
              </div>
              <div class="dialog-buttons">
                <button class="btn" type="button" onclick="document.getElementById('pledge-modal-${item.id}').style.display='none'">Cancel</button>
                <button class="btn btn-primary" type="submit">OK</button>
              </div>
            </form>
          </div>
        </div>
      </div>`}
    </div>`;
}

// Just the item rows — this is what #stuff-list actually contains, and the only
// thing mutation endpoints targeting #stuff-list should ever return.
async function itemListFragment(c, festival) {
    const db = c.env.DB;
    const person = c.get('person');
    const sort = c.req.query('sort') || 'votes';
    const expand = c.req.query('expand') || '';

    const { rows, statsById } = await loadItemsWithStats(db, festival.id);
    const withStats = rows.map((item) => ({ item, stats: statsById.get(item.id) }));

    const bySort = (a, b) => (sort === 'name'
        ? a.item.name.localeCompare(b.item.name)
        : b.stats.voteCount - a.stats.voteCount);
    // Half-done beats not-started: an item someone has already put their name to is
    // the one closest to being finished, so it ranks above everything else in the
    // list regardless of the chosen sort — which only breaks ties within a band.
    const started = (x) => (x.stats.pledgedQty > 0 ? 0 : 1);
    const byProgress = (a, b) => (started(a) - started(b)) || bySort(a, b);

    // Anything covered drops to the bottom no matter how new it is — "just added"
    // is for things still needing a name against them.
    const complete = withStats.filter((x) => x.stats.pledgedQty >= x.item.needed_qty).sort(bySort);
    const outstanding = withStats.filter((x) => x.stats.pledgedQty < x.item.needed_qty);

    // items.created_at is SQLite's datetime('now'): UTC, space-separated, and with
    // no zone marker — which Date.parse would read as LOCAL time and put an hour or
    // more out. Hand it a real ISO string instead. A row with an unparseable date
    // gives NaN, every comparison against it is false, and it lands in "still need
    // these" — the right way to fail.
    const addedMs = (x) => Date.parse(`${(x.item.created_at || '').replace(' ', 'T')}Z`);
    const cutoff = Date.now() - 60 * 60 * 1000;
    const justAdded = outstanding.filter((x) => addedMs(x) > cutoff).sort((a, b) => addedMs(b) - addedMs(a));
    const incomplete = outstanding.filter((x) => !(addedMs(x) > cutoff)).sort(byProgress);

    // "expand" carries the id of an item that should open (e.g. after a sign-in
    // redirect replays a comment that was blocked mid-action) — and opens its chat.
    const row = ({ item, stats }) => itemRow(festival, item, stats, person, expand === `item-${item.id}`, expand === `item-${item.id}`);

    if (!withStats.length) return html`<p class="stuff-empty">There are no items in this view — add the first thing!</p>`;

    // XP Explorer "show in groups" style: three grouped sections with a header rule.
    // The split is decided HERE and then left alone — a card that fills up mid-session
    // stays put (bar full, ticked) and only lands in "all covered" on the next load,
    // because relocating cards under a tapping finger made the list jump around. Same
    // for an item ageing out of "just added": it moves on the next render, and adding
    // an item re-renders the whole list, so a fresh one shows up in place immediately.
    const section = (id, headerClass, label, group) => html`
      <div class="stuff-section ${group.length ? '' : 'is-empty'}" id="${id}">
        <div class="stuff-section-header ${headerClass}">${label} <span class="section-count">${group.length}</span></div>
        ${group.map(row)}
      </div>`;

    return html`
      ${section('stuff-new', 'fresh', 'just added', justAdded)}
      ${section('stuff-incomplete', '', 'still need these', incomplete)}
      ${section('stuff-complete', 'done', 'all covered', complete)}
    `;
}

async function renderStuffBody(c, festival) {
    const list = await itemListFragment(c, festival);
    const sort = c.req.query('sort') || 'votes';

    return html`
    <div class="meet-task-head task-head-inline">
      <img src="/xp/desk-stuff.png" alt="" width="30" height="30">
      <div class="meet-task-text">
        <b>What are you bringing?</b>
        <span>Select the check box at the right of an item to put your name down for it, or click the item's name for more options.</span>
      </div>
    </div>

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
    // Unawaited: renderPage runs its own batch alongside these queries.
    const body = renderStuffBody(c, festival);
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
    // The like button sends the card's current open state so liking doesn't
    // collapse a card you'd expanded (or expand one you'd left collapsed), nor
    // shut the comments window you were reading.
    const voteBody = await c.req.parseBody().catch(() => ({}));
    const expanded = voteBody.expanded === '1';
    const chatOpen = voteBody.chat_open === '1';

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

    return itemRowResponse(c, festival, item.id, expanded, chatOpen);
});

items.post('/items/:itemId/pledge', async (c) => {
    const loaded = await loadItem(c);
    if (!loaded) return c.notFound();
    const { item, festival } = loaded;
    if (needsSignin(c)) return signinModalResponse(c, { expandId: `item-${item.id}` });
    const db = c.env.DB;
    const person = c.get('person');
    const body = await c.req.parseBody();
    const qty = Math.max(0, Math.floor(Number(body.qty) || 0));
    // Both the header check box and the dialog form report the card's current state,
    // so a pledge never changes what's open. Default OFF, not on: this used to
    // default to expanded on the theory that the dialog could only be opened from an
    // already-open card, which stopped being true the moment the check box (up in
    // the summary) started raising it — every quantity confirm sprang the card open.
    const expanded = body.expanded === '1';
    const chatOpen = body.chat_open === '1';

    // Re-pledging changes the amount on your existing pledge instead of stacking a second row.
    const existing = await db.prepare('SELECT * FROM pledges WHERE item_id = ? AND person_id = ? AND deleted_at IS NULL').bind(item.id, person.id).first();

    // 0 means "take my name off it" — unticking the check box, or typing 0 in the
    // dialog. This is the only way to withdraw now that the button is gone.
    if (existing && qty === 0) {
        const stamp = sqlNow();
        await db.prepare('UPDATE pledges SET deleted_at = ? WHERE id = ?').bind(stamp, existing.id).run();
        await logAction(c, {
            festivalId: festival.id, action: 'delete', entityType: 'pledges', entityId: existing.id,
            reversible: true, effects: [deleteEffect('pledges', existing.id, stamp)],
            summary: `${person.display_name} withdrew their pledge on ${item.name}`,
        });
        return itemRowResponse(c, festival, item.id, expanded, chatOpen);
    }

    // Not down for it and asking for 0 — nothing to do, just re-render.
    if (!existing && qty === 0) return itemRowResponse(c, festival, item.id, expanded, chatOpen);

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

    return itemRowResponse(c, festival, item.id, expanded, chatOpen);
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
