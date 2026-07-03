import { html } from 'hono/html';

// A floating, draggable Windows-XP popup window — dropped into #popup-layer via
// htmx (hx-swap="beforeend"), so multiple can stack and cascade on top of each
// other. Dragging (by the title bar) and the cascade offset are wired globally in
// the layout script. `id` should be unique per logical window so re-opening one
// replaces rather than duplicates (handled client-side on insert).
export function xpPopup({ title, body, id = '', wide = false, cls = '', onClose = '' }) {
    return html`
    <div class="xp-popup ${wide ? 'wide' : ''} ${cls}"${id ? html` data-popup-id="${id}"` : ''}>
      <div class="xp-popup-titlebar">
        <span class="xp-popup-title">${title}</span>
        <button type="button" class="xp-popup-close" aria-label="close" onclick="closePopup(this)${onClose ? ';' + onClose : ''}">✕</button>
      </div>
      <div class="xp-popup-body">${body}</div>
    </div>`;
}

// A reusable classic-XP message dialog rendered as a draggable popup window: an
// icon (warning/notify/question — a path under /public) sitting to the left of a
// message, vertically centered with it, plus a row of buttons. `big` doubles the
// icon. `buttons` is caller html (each can carry its own onclick / hx-* attrs).
export function xpDialogPopup({ title, icon = '', message, buttons, id = '', big = false, onClose = '' }) {
    return xpPopup({
        title, id, cls: 'dialog', onClose,
        body: html`
          <div class="xp-dialog-prompt">
            ${icon ? html`<img class="xp-dialog-icon ${big ? 'big' : ''}" src="${icon}" alt="" aria-hidden="true">` : ''}
            <div class="xp-dialog-msg">${message}</div>
          </div>
          <div class="dialog-buttons">${buttons}</div>`,
    });
}
