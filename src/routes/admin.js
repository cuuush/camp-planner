import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { verifyUnsubscribeToken } from '../lib/unsubscribe.js';

export const admin = new Hono();

admin.get('/admin', async (c) => {
    const db = c.env.DB;
    const people = (await db.prepare('SELECT * FROM people ORDER BY last_seen_at DESC').all()).results;

    const rows = [];
    for (const p of people) {
        const lastEvent = await db.prepare(`
            SELECT geo_city, geo_country, user_agent, created_at FROM audit_log
            WHERE person_id = ? ORDER BY created_at DESC LIMIT 1
        `).bind(p.id).first();
        rows.push({ p, lastEvent });
    }

    const body = html`
    <div class="divider">★ everyone who's ever signed in ★</div>
    <p>we totally log your ip, fyi, lol. (hidden here — only kept around in case of fraud shenanigans.)</p>
    <table>
      <tr><th>name</th><th>email?</th><th>joined</th><th>last seen</th><th>last location</th><th>last device</th></tr>
      ${rows.map(({ p, lastEvent }) => html`
        <tr>
          <td>${p.display_name}</td>
          <td>${p.email ? 'yes' : 'no'}</td>
          <td>${p.created_at}</td>
          <td>${p.last_seen_at}</td>
          <td>${lastEvent && (lastEvent.geo_city || lastEvent.geo_country) ? `${lastEvent.geo_city || '?'}, ${lastEvent.geo_country || '?'}` : '?'}</td>
          <td style="font-size:0.75em">${lastEvent ? (lastEvent.user_agent || '').slice(0, 40) : ''}</td>
        </tr>`)}
    </table>
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
