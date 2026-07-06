import { html, raw } from 'hono/html';

// MSN Messenger name colors — hash a name to a stable hue so "chris says:" is
// always the same color for chris.
export function nameColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return `hsl(${h}, 60%, 38%)`;
}

// Pull HH:MM out of a SQLite "YYYY-MM-DD HH:MM:SS" datetime for MSN-style message
// timestamps. Best-effort — blank if we can't find one. This is the UTC no-JS
// fallback; the .local-time span rewrites it to the viewer's zone client-side.
export function fmtTime(dt) {
    const m = (dt || '').toString().match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '';
}

// Classic MSN Messenger emoticons (retro 8-bit PNGs in /msn/). Each row is
// [filename, text-shortcut, emoji-equivalent]; typing either the old shortcut
// (":)", "(Y)") or its modern emoji ("🙂", "👍") in the chat renders the real
// MSN graphic, exactly like Messenger did. Art: github.com/bernzrdo/msn-emoticons.
const MSN_EMOTICONS = [
    ['smile', ':)', '🙂'], ['open-mouthed-smile', ':D', '😀'], ['winking-smile', ';)', '😉'],
    ['surprised-smile', ':-O', '😲'], ['smile-with-tongue-out', ':P', '😛'], ['hot-smile', '(H)', '😎'],
    ['angry-smile', ':@', '😡'], ['embarrassed-smile', ':$', '😳'], ['confused-smile', ':S', '😕'],
    ['sad-smile', ':(', '☹️'], ['crying-face', ":'(", '😢'], ['disappointed-smile', ':|', '😐'],
    ['devil', '(6)', '😈'], ['angel', '(A)', '😇'], ['red-heart', '(L)', '❤️'],
    ['broken-heart', '(U)', '💔'], ['messenger', '(M)', '👥'], ['cat-face', '(@)', '😺'],
    ['dog-face', '(&)', '🐶'], ['sleeping-half-moon', '(S)', '🌜'], ['star', '(*)', '⭐'],
    ['filmstrip', '(~)', '🎞️'], ['note', '(8)', '🎵'], ['e-mail', '(E)', '✉️'],
    ['red-rose', '(F)', '🌹'], ['wilted-rose', '(W)', '🥀'], ['clock', '(O)', '🕑'],
    ['red-lips', '(K)', '👄'], ['gift-with-a-bow', '(G)', '🎁'], ['birthday-cake', '(^)', '🎂'],
    ['camera', '(P)', '📷'], ['light-bulb', '(I)', '💡'], ['coffee-cup', '(C)', '☕'],
    ['telephone-receiver', '(T)', '📞'], ['left-hug', '({)', '🫂'], ['beer-mug', '(B)', '🍺'],
    ['martini-glass', '(D)', '🍸'], ['boy', '(Z)', '👦'], ['girl', '(X)', '👧'],
    ['thumbs-up', '(Y)', '👍'], ['thumbs-down', '(N)', '👎'], ['vampire-bat', ':[', '🦇'],
    ['goat', '(nnh)', '🐐'], ['sun', '(#)', '☀️'], ['rainbow', '(R)', '🌈'],
    ['dont-tell-anyone-smile', ':-#', '🤐'], ['baring-teeth-smile', '8o|', '😬'], ['nerd-smile', '8-|', '🤓'],
    ['sarcastic-smile', '^o)', '🤨'], ['sick-smile', '+o(', '🤢'], ['snail', '(sn)', '🐌'],
    ['turtle', '(tu)', '🐢'], ['plate', '(pl)', '🍽️'], ['bowl', '(||)', '🥣'],
    ['pizza', '(pi)', '🍕'], ['soccer-ball', '(so)', '⚽'], ['auto', '(au)', '🚗'],
    ['airplane', '(ap)', '✈️'], ['umbrella', '(um)', '☂️'], ['island-with-a-palm-tree', '(ip)', '🏝️'],
    ['computer', '(co)', '🖥️'], ['mobile-phone', '(mp)', '📱'], ['storm-cloud', '(st)', '🌧️'],
    ['high-five', '(h5)', '🙏'], ['money', '(mo)', '🪙'], ['black-sheep', '(bah)', '🐑'],
    ['thinking-smile', '*-)', '🤔'], ['lightning', '(li)', '🌩️'], ['party-smile', '<:o)', '🥳'],
    ['eye-rolling-smile', '8-)', '🙄'], ['sleepy-smile', '|-)', '🥱'], ['bunny', "('.')", '🐰'],
];

// The subset shown as clickable buttons on the compose toolbar (all quote/backslash
// free so they insert cleanly). Order = display order.
const MSN_TOOLBAR = [
    'smile', 'open-mouthed-smile', 'winking-smile', 'smile-with-tongue-out', 'sad-smile',
    'surprised-smile', 'hot-smile', 'angry-smile', 'thumbs-up', 'thumbs-down',
    'red-heart', 'party-smile', 'star', 'coffee-cup', 'pizza',
].map((file) => MSN_EMOTICONS.find((e) => e[0] === file));

const MSN_TOKEN_TO_FILE = {};
for (const [file, code, emoji] of MSN_EMOTICONS) {
    if (code && !(code in MSN_TOKEN_TO_FILE)) MSN_TOKEN_TO_FILE[code] = file;
    if (emoji && !(emoji in MSN_TOKEN_TO_FILE)) MSN_TOKEN_TO_FILE[emoji] = file;
}
// Longest tokens first so ":-O" wins over ":(" etc.
const MSN_TOKENS = Object.keys(MSN_TOKEN_TO_FILE).sort((a, b) => b.length - a.length);
const MSN_RE = new RegExp(MSN_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

export function escapeHtml(s) {
    return (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Escape a chat message for HTML, then swap any MSN shortcut/emoji tokens for the
// emoticon <img>. Returns a raw HTML string (already fully escaped around the imgs).
export function msnify(text) {
    const src = (text || '').toString();
    let out = '';
    let last = 0;
    for (const match of src.matchAll(MSN_RE)) {
        const idx = match.index;
        out += escapeHtml(src.slice(last, idx));
        const file = MSN_TOKEN_TO_FILE[match[0]];
        out += `<img class="msn-emoticon" src="/msn/${file}.png" alt="${escapeHtml(match[0])}">`;
        last = idx + match[0].length;
    }
    out += escapeHtml(src.slice(last));
    return out;
}

// The full MSN Messenger chat window (title bar, menu bar, contact bar, message
// log, emoticon toolbar, compose box). Shared by item comments and car comments.
// opts: { title, dpEmoji, toLabel, comments, postUrl, target, chatOpen, id }
export function msnChat({ title, dpEmoji, toLabel, comments, postUrl, target, chatOpen = false, id }) {
    return html`
    <details class="msn-chat" ${id ? `id="${id}"` : ''} ${chatOpen ? 'open' : ''}>
      <summary class="msn-titlebar">
        <span class="msn-title-text">${title}</span>
        <span class="msn-winbtns">
          <span class="msn-winbtn min" aria-hidden="true">_</span>
          <span class="msn-winbtn max" aria-hidden="true">▢</span>
          <span class="msn-winbtn close" aria-hidden="true">✕</span>
        </span>
      </summary>
      <div class="msn-window-body">
        <div class="msn-menubar">
          <span class="msn-menu-item">File</span>
          <span class="msn-menu-item">Edit</span>
          <span class="msn-menu-item">Actions</span>
          <span class="msn-menu-item">Tools</span>
          <span class="msn-menu-item">Help</span>
        </div>
        <div class="msn-contactbar">
          <div class="msn-to">${raw(toLabel)}</div>
          <div class="msn-dp">${dpEmoji}</div>
        </div>
        <div class="msn-log">
          ${comments.length
              ? comments.map((cm) => html`<div class="msn-msg"><span class="msn-name" style="color:${nameColor(cm.display_name)}">${cm.display_name} says:</span><span class="msn-time local-time" data-utc="${cm.created_at}">${fmtTime(cm.created_at)}</span><span class="msn-body">${raw(msnify(cm.body))}</span></div>`)
              : html`<div class="msn-empty">no messages yet — say something!</div>`}
        </div>
        <div class="msn-toolbar">
          ${MSN_TOOLBAR.map(([file, code]) => html`<button type="button" class="msn-tool" title="${code}" onclick="msnEmote(this,'${code}')"><img class="msn-emoticon" src="/msn/${file}.png" alt="${code}"></button>`)}
        </div>
        <form class="msn-compose" hx-post="${postUrl}" hx-target="${target}" hx-swap="outerHTML">
          <input type="text" name="body" placeholder="type a message..." autocomplete="off">
          <button class="btn btn-primary" type="submit">Send</button>
        </form>
      </div>
    </details>`;
}
