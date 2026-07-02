import { html } from 'hono/html';

export function needsSignin(c) {
    return !c.get('person');
}

function hiddenFields({ next, expandId, replayPath, replayBody }) {
    return html`
      <input type="hidden" name="next" value="${next}">
      <input type="hidden" name="expand" value="${expandId || ''}">
      <input type="hidden" name="replay_path" value="${replayPath || ''}">
      <input type="hidden" name="replay_body" value="${replayBody || ''}">`;
}

// The sign-in form, shown inside the modal. Submits via htmx back into the same
// overlay slot — so a "someone's already signed in as X" reply below can replace
// it in place instead of navigating to a separate screen.
export function modalFormMarkup(ctx) {
    return html`
    <div class="modal-backdrop" onclick="if(event.target===this)document.getElementById('signin-modal-overlay').innerHTML=''">
      <div class="modal-box xp-dialog">
        <div class="xp-dialog-title">
          <span class="xp-dialog-title-text">Sign In</span>
          <button type="button" class="xp-dialog-close" onclick="document.getElementById('signin-modal-overlay').innerHTML=''">✕</button>
        </div>
        <div class="xp-dialog-body">
          <form hx-post="/signin" hx-target="#signin-modal-overlay" hx-swap="innerHTML">
            ${hiddenFields(ctx)}
            <input type="text" name="name" class="signin-name-input" placeholder="your name" required autofocus>
            <div class="name-taken-notice"></div>
            <p class="signin-hint">takes 2 seconds, no password. if u think someone else might use this name, pick something more identifiable haha</p>
            <input type="email" name="email" placeholder="email (optional, just for notifications)">
            <button class="btn btn-primary" type="submit" style="width:100%; margin-top:12px;">sign in &amp; continue</button>
          </form>
        </div>
      </div>
    </div>`;
}

// Shown in place of the form (same overlay slot) when the name's already taken —
// trust-based reclaim, no separate page.
export function modalReclaimMarkup(reclaimName, ctx) {
    return html`
    <div class="modal-backdrop" onclick="if(event.target===this)document.getElementById('signin-modal-overlay').innerHTML=''">
      <div class="modal-box xp-dialog">
        <div class="xp-dialog-title">
          <span class="xp-dialog-title-text">Camp Planner</span>
          <button type="button" class="xp-dialog-close" onclick="document.getElementById('signin-modal-overlay').innerHTML=''">✕</button>
        </div>
        <div class="xp-dialog-body">
          <p>there's already an account named <b>${reclaimName}</b> — is that yours?</p>
          <form hx-post="/signin/reclaim" hx-target="#signin-modal-overlay" hx-swap="innerHTML">
            <input type="hidden" name="name" value="${reclaimName}">
            ${hiddenFields(ctx)}
            <button class="btn btn-primary" type="submit" style="width:100%;">yep, that's mine</button>
          </form>
          <button type="button" class="btn" style="width:100%; margin-top:8px;" onclick="document.getElementById('signin-modal-overlay').innerHTML=''">nevermind, that's not me</button>
        </div>
      </div>
    </div>`;
}

function captureReplay(c) {
    return {
        next: c.req.header('referer') || '/',
        replayPath: c.req.path,
    };
}

// Used by htmx-driven mutation endpoints: retarget the swap into a full-screen
// sign-in modal instead of clobbering whatever fragment the form would've updated.
// Captures the exact request (path + body) so it can be replayed for real once
// they're signed in — the action they were trying to do just... happens.
export async function signinModalResponse(c, { expandId } = {}) {
    c.header('HX-Retarget', '#signin-modal-overlay');
    c.header('HX-Reswap', 'innerHTML');

    const { next, replayPath } = captureReplay(c);
    let replayBody = '';
    try {
        replayBody = await c.req.raw.clone().text();
    } catch (e) { /* no body to replay */ }

    return c.html(modalFormMarkup({ next, expandId, replayPath, replayBody }));
}

// Used by plain (non-htmx) form posts that mutate state — full navigation to a
// dedicated sign-in page, replaying the original submission once they're in.
export async function signinRedirect(c) {
    const { next, replayPath } = captureReplay(c);
    let replayBody = '';
    try {
        replayBody = await c.req.raw.clone().text();
    } catch (e) { /* no body to replay */ }

    const params = new URLSearchParams({ next, replay_path: replayPath, replay_body: replayBody });
    return c.redirect(`/signin?${params.toString()}`);
}
