import { Hono } from 'hono';
import { html } from 'hono/html';
import { renderPage } from '../render/layout.js';
import { loadFestival } from '../lib/festival.js';
import { undoAction } from '../lib/audit.js';
import { needsSignin, signinModalResponse } from '../lib/guard.js';
import { xpDialogPopup } from '../render/popup.js';

export const log = new Hono();

// The "some of it couldn't be undone" message dialog. The engine hands us a plain,
// human message (built in effects.js) explaining what it left alone and why; we
// wrap it in the classic XP notify dialog so the honesty is impossible to miss.
function partialUndoDialog(message) {
    return xpDialogPopup({
        title: 'Undo',
        id: 'partial-undo',
        icon: 'info',
        message,
        buttons: html`<button class="btn btn-primary" type="button" onclick="closePopup(this)">OK</button>`,
    });
}

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
            // "2026-07-02 14:33:12" -> "07-02 14:33" so the column stays narrow on
            // phones. That's the UTC no-JS fallback; the .local-time span rewrites
            // it into the viewer's own time zone (and 12h/24h pref) client-side.
            const when = (e.created_at || '').slice(5, 16);
            // An undo entry may carry a partial-restore note (some effects were
            // skipped) stashed in after_json — surface it as a quiet hint so the log
            // is honest about what didn't come back.
            let skipHint = '';
            if (e.action === 'undo' && e.after_json) {
                try { skipHint = (JSON.parse(e.after_json) || {}).skipped || ''; } catch (err) { skipHint = ''; }
            }
            return html`
        <tr>
          <td class="log-when"><span class="local-time" data-utc="${e.created_at}" data-fmt="datetime">${when}</span></td>
          <td class="log-what">${e.summary}${e.undone_at ? html` <i>(undone)</i>` : ''}${skipHint ? html`<div class="log-skip-hint">⚠ ${skipHint}</div>` : ''}</td>
          <td>
            ${e.reversible && !e.undone_at ? html`
              <form hx-post="/f/${festival.id}/log/${e.id}/undo" hx-target="#main" hx-swap="innerHTML" hx-confirm="Are you sure you want to ${label} this?">
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

    // An entry can only be undone through its OWN festival's log — otherwise any
    // signed-in user could forge undos of another fest's actions through their own
    // fest's URL (G6). undoAction re-checks this, but 404 here before doing anything.
    const result = await undoAction(c, auditId, festival.id);
    if (result.error === 'wrong_festival' || result.error === 'not_found') return c.notFound();

    const body = await renderLogBody(c, festival);
    // When some effects couldn't be applied (row changed since, would duplicate an
    // active row, …) the engine reports them — surface an honest XP dialog rather
    // than silently pretending the whole thing undid. The log (#main) still swaps
    // normally; the dialog rides along out-of-band, appended into #popup-layer where
    // the afterSwap handler centers it (same layer nameTakenWarning uses).
    if (result.skippedMessage) {
        return c.html(html`${body}<div hx-swap-oob="beforeend:#popup-layer">${partialUndoDialog(result.skippedMessage)}</div>`);
    }
    return c.html(body);
});
