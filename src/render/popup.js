import { html } from 'hono/html';

// The Luna caption buttons (minimize / maximize / close) — ONE implementation for
// every title bar in the app. There used to be five hand-rolled copies (.xp-tb-btn,
// .msn-winbtn, .xp-popup-close, .xp-dialog-close, .st-winbtn), each with its own
// size, gradient, and glyph CHARACTER (_ vs –, ❐ vs ▢ vs □) — which is exactly why
// no two title bars matched. The glyphs are now drawn in CSS (see .xp-caption-btn
// in retro.css), so they're pixel-identical everywhere regardless of font.
//
// Decorative by default (inert spans, aria-hidden — the app window can't really
// minimize). Pass `onClose` (a JS snippet) to make ✕ a real working button; pass
// min/max: false for dialog-style bars that only get a ✕, like real XP dialogs.
export function xpCaptionBtns({ min = true, max = true, onClose = '' } = {}) {
    return html`<span class="xp-caption-btns">
      ${min ? html`<span class="xp-caption-btn min" aria-hidden="true"></span>` : ''}
      ${max ? html`<span class="xp-caption-btn max" aria-hidden="true"></span>` : ''}
      ${onClose
          ? html`<button type="button" class="xp-caption-btn close" aria-label="Close" onclick="${onClose}"></button>`
          : html`<span class="xp-caption-btn close" aria-hidden="true"></span>`}
    </span>`;
}

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
        ${xpCaptionBtns({ min: false, max: false, onClose: `closePopup(this)${onClose ? ';' + onClose : ''}` })}
      </div>
      <div class="xp-popup-body">${body}</div>
    </div>`;
}

// The six authentic Windows XP message-box glyphs, so callers can ask for a
// dialog "kind" by name (icon: 'warning') instead of hard-coding a path. These
// are the real system icons from the XP high-res pack (see scripts/make-xp-icons.sh):
//   error    — the red Critical "X" roundel   (destructive / something failed)
//   warning  — the yellow triangle            ("are you sure?" / caution)
//   question — the blue speech-bubble "?"      (a choice with no danger)
//   info     — the blue "i" bubble             (FYI, nothing to decide)
//   success  — the green check roundel         (it worked)
//   security — the yellow/blue shield          (sign-in / permission prompts)
const DIALOG_ICONS = {
    error: '/xp/dlg-error.png',
    warning: '/xp/dlg-warning.png',
    question: '/xp/dlg-question.png',
    info: '/xp/dlg-info.png',
    success: '/xp/dlg-success.png',
    security: '/xp/dlg-security.png',
};

// A reusable classic-XP message dialog rendered as a draggable popup window: an
// icon sitting to the left of a message, vertically centered with it, plus a row
// of buttons. `icon` is either one of the DIALOG_ICONS kind-names above
// ('warning', 'error', 'question', 'info', 'success', 'security') or a raw path
// under /public. `big` doubles the icon. `buttons` is caller html (each can carry
// its own onclick / hx-* attrs).
// `centerMobile` vertically centres the dialog on phones instead of pinning it near
// the top. OPT-IN, and only ever for a dialog with NO text field: the top pin exists
// because the on-screen keyboard shoves a centred window off the top of the screen
// (see the note on the mobile rules in retro.css). A pure question-and-buttons box
// never summons a keyboard, so it can sit where a dialog belongs. Don't set this on
// anything a user can type into.
export function xpDialogPopup({ title, icon = '', message, buttons, id = '', big = false, onClose = '', centerMobile = false }) {
    icon = DIALOG_ICONS[icon] || icon;
    return xpPopup({
        title, id, cls: `dialog${centerMobile ? ' center-mobile' : ''}`, onClose,
        body: html`
          <div class="xp-dialog-prompt">
            ${icon ? html`<img class="xp-dialog-icon ${big ? 'big' : ''}" src="${icon}" alt="" aria-hidden="true">` : ''}
            <div class="xp-dialog-msg">${message}</div>
          </div>
          <div class="dialog-buttons">${buttons}</div>`,
    });
}
