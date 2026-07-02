import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { undoAction } from '../lib/audit.js';

export const log = new Hono();

async function renderLogBody(c, festival) {
    const db = c.env.DB;
    const entries = (await db.prepare(`
        SELECT a.*, pe.display_name FROM audit_log a
        LEFT JOIN people pe ON pe.id = a.person_id
        WHERE a.festival_id = ?
        ORDER BY a.created_at DESC LIMIT 200
    `).bind(festival.id).all()).results;

    return html`
    <div class="divider">★ action log — everything, undoable, google-sheets-style ★</div>
    <table>
      <tr><th>when</th><th>who</th><th>what</th><th></th></tr>
      ${entries.map((e) => html`
        <tr>
          <td>${e.created_at}</td>
          <td>${e.display_name || 'someone'}</td>
          <td>${e.summary}${e.undone_at ? html` <i>(undone)</i>` : ''}</td>
          <td>
            ${e.reversible && !e.undone_at ? html`
              <form hx-post="/f/${festival.id}/log/${e.id}/undo" hx-target="#main" hx-swap="innerHTML" hx-confirm="undo this?">
                <button class="btn" type="submit">undo</button>
              </form>` : ''}
          </td>
        </tr>`)}
    </table>
  `;
}

log.get('/f/:id/log', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const body = await renderLogBody(c, festival);
    return c.html(await renderPage(c, { title: `${festival.name} — log`, festival, activeTab: 'log', body }));
});

log.post('/f/:id/log/:auditId/undo', async (c) => {
    const festival = await loadFestival(c);
    if (!festival) return c.notFound();
    const auditId = Number(c.req.param('auditId'));

    await undoAction(c, auditId);

    return c.html(await renderLogBody(c, festival));
});
