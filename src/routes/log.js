import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { undoAction } from '../lib/audit.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';

export const log = new Hono();

async function renderLogBody(c, festival) {
    const db = c.env.DB;
    const entries = (await db.prepare(`
        SELECT a.*, pe.display_name,
               CASE WHEN a.action = 'undo' THEN orig.undone_at ELSE a.undone_at END AS target_undone_at
        FROM audit_log a
        LEFT JOIN people pe ON pe.id = a.person_id
        LEFT JOIN audit_log orig ON orig.id = a.undo_of_id
        WHERE a.festival_id = ?
        ORDER BY a.created_at DESC LIMIT 200
    `).bind(festival.id).all()).results;

    return html`
    <div class="table-scroll">
    <table class="log-table">
      <tr><th>when</th><th>what</th><th>undo</th></tr>
      ${entries.map((e) => {
            const nextIsRedo = !!e.target_undone_at;
            const label = nextIsRedo ? 'redo' : 'undo';
            // "2026-07-02 14:33:12" -> "07-02 14:33" so the column stays narrow on phones.
            const when = (e.created_at || '').slice(5, 16);
            return html`
        <tr>
          <td class="log-when">${when}</td>
          <td class="log-what">${e.summary}${e.undone_at ? html` <i>(undone)</i>` : ''}</td>
          <td>
            ${e.reversible && !e.undone_at ? html`
              <form hx-post="/f/${festival.id}/log/${e.id}/undo" hx-target="#main" hx-swap="innerHTML" hx-confirm="${label} this?">
                <button class="btn" type="submit">${label}</button>
              </form>` : ''}
          </td>
        </tr>`;
        })}
    </table>
    </div>
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
    if (needsSignin(c)) return signinModalResponse(c);
    const auditId = Number(c.req.param('auditId'));

    await undoAction(c, auditId);

    return c.html(await renderLogBody(c, festival));
});
