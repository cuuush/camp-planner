import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { verifyUnsubscribeToken } from '../lib/unsubscribe.js';
import { getItemMeta } from '../lib/emoji.js';

export const admin = new Hono();

// One-time-ever cleanup: re-ask the LLM about items stuck on the 📦 fallback.
// Small batches because each name costs an LLM fetch + a few D1 calls, and a
// Worker request has a subrequest budget — the page says "Run Again" until done.
const REEMOJI_BATCH = 10;

admin.get('/admin', async (c) => {
    const db = c.env.DB;
    const people = (await db.prepare('SELECT * FROM people ORDER BY last_seen_at DESC').all()).results;
    // For annotating merged-away identities with where they went.
    const nameById = new Map(people.map((p) => [p.id, p.display_name]));

    const rows = [];
    for (const p of people) {
        const lastEvent = await db.prepare(`
            SELECT geo_city, geo_country, user_agent, created_at FROM audit_log
            WHERE person_id = ? ORDER BY created_at DESC LIMIT 1
        `).bind(p.id).first();
        rows.push({ p, lastEvent });
    }

    const body = html`
    <p>we totally log your ip, fyi, lol. (hidden here — only kept around in case of fraud shenanigans.)</p>
    <table>
      <tr><th>name</th><th>email?</th><th>joined</th><th>last seen</th><th>last location</th><th>last device</th></tr>
      ${rows.map(({ p, lastEvent }) => html`
        <tr>
          <td>${p.display_name}${p.merged_into ? html` <span style="color:#888">(merged into ${nameById.get(p.merged_into) || `#${p.merged_into}`})</span>` : ''}</td>
          <td>${p.email ? 'yes' : 'no'}</td>
          <td>${p.created_at}</td>
          <td>${p.last_seen_at}</td>
          <td>${lastEvent && (lastEvent.geo_city || lastEvent.geo_country) ? `${lastEvent.geo_city || '?'}, ${lastEvent.geo_country || '?'}` : '?'}</td>
          <td style="font-size:0.75em">${lastEvent ? (lastEvent.user_agent || '').slice(0, 40) : ''}</td>
        </tr>`)}
    </table>

    <div class="card" style="margin-top:1em">
      <h3>Add or Remove Package Emoji</h3>
      <p>Some items were labeled 📦 because the suggestion service was unavailable.
      Click the button below to have Windows look up better emoji for them.
      Items that really are boxes will keep 📦. This is a one-time maintenance task;
      if there are many items, you may be asked to run it more than once.</p>
      <form method="post" action="/admin/reemoji"
            onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Please wait…'">
        <button type="submit">Fix Package Emoji</button>
      </form>
    </div>
  `;

    return c.html(await renderPage(c, { title: 'admin', body }));
});

admin.post('/admin/reemoji', async (c) => {
    const db = c.env.DB;
    const formBody = await c.req.parseBody();
    // Names the LLM keeps as 📦 stay in this query's result set, so later
    // batches must skip past them — `skip` carries the kept-so-far count
    // between clicks (changed names drop out of the WHERE on their own).
    const skip = Math.max(0, Number(formBody.skip) || 0);

    // One row per distinct (normalized) name still wearing the fallback box.
    const rows = (await db.prepare(`
        SELECT lower(trim(name)) AS key, MIN(name) AS name FROM items
        WHERE emoji = '📦' AND deleted_at IS NULL
        GROUP BY key ORDER BY key LIMIT ? OFFSET ?
    `).bind(REEMOJI_BATCH, skip).all()).results;

    const changed = [];
    const kept = [];
    for (const row of rows) {
        // getItemMeta treats a cached 📦 as a miss, so this genuinely re-asks
        // the LLM (and re-caches any better answer it gives).
        const { emoji } = await getItemMeta(c.env, row.name);
        if (emoji && emoji !== '📦') {
            await db.prepare(`
                UPDATE items SET emoji = ? WHERE lower(trim(name)) = ? AND emoji = '📦' AND deleted_at IS NULL
            `).bind(emoji, row.key).run();
            changed.push(row.name + ' → ' + emoji);
        } else {
            kept.push(row.name);
        }
    }

    const newSkip = skip + kept.length;
    const remaining = (await db.prepare(`
        SELECT COUNT(DISTINCT lower(trim(name))) AS n FROM items
        WHERE emoji = '📦' AND deleted_at IS NULL
    `).first()).n - newSkip;

    const body = html`
    <div class="card">
      <h3>Add or Remove Package Emoji</h3>
      ${rows.length === 0
        ? html`<p>There are no items with the 📦 label in this view. No changes were made.</p>`
        : html`
          <p>Windows has finished looking up emoji for ${rows.length} item name${rows.length === 1 ? '' : 's'}.</p>
          ${changed.length ? html`<p><b>Updated:</b> ${changed.join(', ')}</p>` : ''}
          ${kept.length ? html`<p><b>Kept 📦</b> (no better emoji was found): ${kept.join(', ')}</p>` : ''}
        `}
      ${remaining > 0 ? html`
        <p>${remaining} item name${remaining === 1 ? ' still needs' : 's still need'} attention.</p>
        <form method="post" action="/admin/reemoji"
              onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Please wait…'">
          <input type="hidden" name="skip" value="${newSkip}">
          <button type="submit">Run Again</button>
        </form>
      ` : html`<p>All done. You may now close this window.</p>`}
      <p><a href="/admin">Back to admin</a></p>
    </div>
  `;

    return c.html(await renderPage(c, { title: 'admin', body }));
});

admin.get('/unsubscribe/:personId/:token', async (c) => {
    const db = c.env.DB;
    const personId = Number(c.req.param('personId'));
    const token = c.req.param('token');
    const person = await db.prepare('SELECT * FROM people WHERE id = ?').bind(personId).first();

    let msg;
    if (!person || !(await verifyUnsubscribeToken(c.env, person, token))) {
        msg = html`<p>hmm, that link doesn't check out.</p>`;
    } else {
        await db.prepare('UPDATE people SET email_unsubscribed = 1 WHERE id = ?').bind(personId).run();
        msg = html`<p>done — ${person.display_name} won't get any more emails from camp planner.</p>`;
    }

    return c.html(await renderPage(c, { title: 'unsubscribed', body: html`<div class="card">${msg}</div>` }));
});
