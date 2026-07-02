import { html, raw } from 'hono/html';

const RETRO_CSS = `
  body { background: #000080 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Crect width='4' height='4' fill='%23000080'/%3E%3Crect width='2' height='2' fill='%23000066'/%3E%3C/svg%3E"); color: #00ff00; font-family: Verdana, Geneva, sans-serif; margin: 0; }
  a { color: #00ffff; }
  a:visited { color: #ff00ff; }
  .marquee-wrap { background: #000; border-bottom: 4px double #ffff00; overflow: hidden; white-space: nowrap; padding: 4px 0; }
  .marquee { display: inline-block; padding-left: 100%; animation: marquee 30s linear infinite; color: #ffff00; font-weight: bold; }
  @keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-100%); } }
  header.site { background: #c0c0c0; border-bottom: 4px ridge #808080; padding: 8px; color: #000; }
  .fest-picker { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .fest-picker select, .fest-picker a.button, button, input[type=submit] { font-family: inherit; }
  h1.title { text-align: center; font-size: 2em; letter-spacing: 2px; color: #ffff00; text-shadow: 2px 2px #ff00ff; margin: 8px 0; }
  nav.tabs { display: flex; background: #808080; border-bottom: 4px ridge #404040; }
  nav.tabs a { flex: 1; text-align: center; padding: 10px 4px; text-decoration: none; color: #fff; font-weight: bold; border-right: 2px solid #404040; }
  nav.tabs a.active { background: #000080; color: #ffff00; }
  main { max-width: 900px; margin: 0 auto; padding: 12px; background: #000000cc; min-height: 60vh; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  td, th { border: 1px solid #444; padding: 4px 6px; }
  th { background: #000080; color: #ffff00; }
  .btn, button, input[type=submit] { background: #c0c0c0; border: 2px outset #fff; color: #000; padding: 4px 10px; cursor: pointer; font-weight: bold; }
  .btn:active, button:active { border-style: inset; }
  .rainbow { background: linear-gradient(90deg,red,orange,yellow,green,blue,violet); -webkit-background-clip: text; background-clip: text; color: transparent; font-weight: bold; }
  .new-burst { color: #ff0000; font-weight: bold; animation: none; }
  .card { background: #111; border: 2px groove #808080; margin: 6px 0; padding: 6px 10px; }
  .unclaimed { border-color: #ff0000; box-shadow: 0 0 6px #ff0000; }
  .progress-bar { background: #333; border: 1px solid #000; height: 10px; width: 100%; }
  .progress-fill { background: #00ff00; height: 100%; }
  .divider { text-align: center; color: #ffff00; margin: 12px 0; }
  footer.site { background: #c0c0c0; color: #000; padding: 12px; text-align: center; margin-top: 20px; }
  .badge-row { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; margin: 10px 0; }
  .badge-row .badge { width: 88px; height: 31px; background: #333; border: 1px solid #000; display: flex; align-items: center; justify-content: center; font-size: 8px; color: #aaa; }
  .webring { margin-top: 10px; font-size: 0.9em; }
  .hitcounter { font-family: 'Courier New', monospace; background: #000; color: #0f0; padding: 2px 6px; border: 1px inset #444; letter-spacing: 2px; }
  input[type=text], input[type=number], input[type=email], select, textarea { background: #fff; border: 2px inset #808080; padding: 3px; font-family: inherit; }
  .comment { border-top: 1px dotted #444; padding: 4px 0; font-size: 0.85em; }
  @media (max-width: 600px) { nav.tabs a { font-size: 0.8em; padding: 8px 2px; } h1.title { font-size: 1.4em; } }
`;

export function tickerHtml(entries) {
    if (!entries || !entries.length) return html`<div class="marquee-wrap"><span class="marquee">★ NEWS ★ nothing's happened yet... be the first! ★</span></div>`;
    const text = entries.map((e) => e.summary).join('   ·   ');
    return html`<div class="marquee-wrap"><span class="marquee">★ NEWS ★ ${text} ★ NEWS ★ ${text}</span></div>`;
}

function festPicker(c, festival, festivals) {
    const person = c.get('person');
    if (!person) return html``;
    return html`
    <div class="fest-picker">
      <div>
        ${festival
            ? html`<form method="get" action="/f/${festival.id}" style="display:inline"><b>📍 ${festival.name}</b></form>
               <select onchange="if(this.value) window.location='/f/'+this.value">
                 <option value="">switch fest...</option>
                 ${(festivals || []).map((f) => html`<option value="${f.id}" ${f.id === festival.id ? 'selected' : ''}>${f.name}</option>`)}
               </select>`
            : html`<b>choose a fest below</b>`}
        <a class="btn" href="/fests/new">+ add a fest</a>
      </div>
      <div>
        signed in as <b>${person.display_name}</b> · <a href="/signout">sign out</a>
      </div>
    </div>`;
}

export async function renderPage(c, { title, activeTab = '', body, festival = null }) {
    const db = c.env.DB;
    const person = c.get('person');

    let festivals = [];
    try {
        festivals = (await db.prepare('SELECT id, name FROM festivals WHERE deleted_at IS NULL ORDER BY name').all()).results;
    } catch (e) { /* ok */ }

    let ticker = [];
    if (festival) {
        try {
            ticker = (await db.prepare(`
                SELECT summary FROM audit_log
                WHERE festival_id = ? AND action != 'undo'
                ORDER BY created_at DESC LIMIT 15
            `).bind(festival.id).all()).results;
        } catch (e) { /* ok */ }
    }

    const tabs = festival
        ? [
            ['stuff', `/f/${festival.id}/stuff`, 'stuff'],
            ['ppl', `/f/${festival.id}/ppl`, 'ppl'],
            ['rides', `/f/${festival.id}/rides`, 'rides'],
            ['mine', `/f/${festival.id}/mine`, 'mine'],
            ['log', `/f/${festival.id}/log`, 'log'],
        ]
        : [];

    return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} :: camp planner</title>
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <style>${raw(RETRO_CSS)}</style>
</head>
<body>
  ${tickerHtml(ticker)}
  <header class="site">
    ${festPicker(c, festival, festivals)}
  </header>
  <h1 class="title">${festival ? festival.name : 'camp planner'} <span class="new-burst">NEW!</span></h1>
  ${festival ? html`<nav class="tabs">${tabs.map(([label, href, key]) => html`<a href="${href}" class="${key === activeTab ? 'active' : ''}">${label}</a>`)}</nav>` : ''}
  <main id="main">
    ${body}
  </main>
  <footer class="site">
    <div class="badge-row">
      ${['under construction', 'best viewed IE/Netscape', 'valid html', 'NEW!', 'mailbox', 'rave on'].map((label) => html`<div class="badge">${label}</div>`)}
    </div>
    <div class="webring">← <a href="/webring/${festival ? festival.id : ''}/prev">prev</a> | <a href="/webring/${festival ? festival.id : ''}/random">random</a> | <a href="/webring/${festival ? festival.id : ''}/next">next</a> →</div>
    <div style="margin-top:8px;font-size:0.8em;"><a href="/admin">admin</a> · we totally log your ip, fyi, lol</div>
  </footer>
</body>
</html>`;
}
