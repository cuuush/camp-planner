/* All of camp planner's client-side JS. Loaded from <head> WITHOUT defer, so it
   runs before <body> exists: top-level code must bind listeners to `document`
   (never document.body — that's null here and the throw silently kills every
   listener declared after it). document.body inside callbacks is fine. */
function campConfetti(el) {
  if (!campConfettiOn()) return; // "visual effects" switched off in the control panel
  el.classList.add('pop');
  setTimeout(function () { el.classList.remove('pop'); }, 350);
  var rect = el.getBoundingClientRect();
  var bits = ['🎉','✨','🌟','💫','🎊'];
  for (var i = 0; i < 10; i++) {
    var span = document.createElement('span');
    span.className = 'confetti-piece';
    span.textContent = bits[Math.floor(Math.random() * bits.length)];
    span.style.left = (rect.left + rect.width / 2) + 'px';
    span.style.top = (rect.top + rect.height / 2) + 'px';
    span.style.fontSize = (12 + Math.random() * 10) + 'px';
    var angle = Math.random() * Math.PI * 2;
    var dist = 35 + Math.random() * 55;
    span.style.setProperty('--confetti-end', 'translate(' + (Math.cos(angle) * dist) + 'px,' + (Math.sin(angle) * dist - 25) + 'px)');
    span.style.setProperty('--confetti-spin', (Math.random() * 360) + 'deg');
    document.body.appendChild(span);
    setTimeout((function (s) { return function () { s.remove(); }; })(span), 750);
  }
}

// Render every emoji in the page with the UnifontEX pixel font by wrapping each
// emoji run in a <span class="pixmoji">. Runs on load and after each HTMX swap.
// Skips inputs/scripts and already-wrapped spans so it's safe to re-run.
var PIXMOJI_RE = /(?:\p{Extended_Pictographic}(?:️|‍|\p{Emoji_Modifier}|\p{Extended_Pictographic})*|[\u{1F1E6}-\u{1F1FF}]{2})/gu;
// True if UnifontEX has a real glyph for this codepoint (binary search over the
// injected coverage ranges). Emoji it lacks stay native so we don't show tofu.
function pixCovered(cp) {
  var r = window.PIXMOJI_RANGES;
  if (!r || !r.length) return true;
  var lo = 0, hi = (r.length >> 1) - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1, s = r[mid * 2], e = r[mid * 2 + 1];
    if (cp < s) hi = mid - 1;
    else if (cp > e) lo = mid + 1;
    else return true;
  }
  return false;
}
function pixmojify(root) {
  if (!root || root.nodeType === undefined || !document.createTreeWalker) return;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      PIXMOJI_RE.lastIndex = 0;
      if (!PIXMOJI_RE.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      var p = n.parentNode;
      if (!p) return NodeFilter.FILTER_REJECT;
      var t = p.nodeName;
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'TEXTAREA' || t === 'INPUT') return NodeFilter.FILTER_REJECT;
      if (p.classList && p.classList.contains('pixmoji')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  var nodes = [], n;
  while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(function (node) {
    var text = node.nodeValue, frag = document.createDocumentFragment(), last = 0, m;
    PIXMOJI_RE.lastIndex = 0;
    while ((m = PIXMOJI_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (pixCovered(m[0].codePointAt(0))) {
        var span = document.createElement('span');
        span.className = 'pixmoji';
        // Strip any variation selectors (0xFE0E/0xFE0F). We must NOT append a
        // text-presentation selector char: Unifont has a visible glyph for it, so
        // iOS Safari renders a box after every emoji. Dropping the color-forcing
        // 0xFE0F is enough — the explicit .pixmoji font-family (+ font-variant-emoji)
        // makes the pixel glyph win.
        var glyph = '';
        for (var ci = 0; ci < m[0].length; ci++) {
          var cc = m[0].charCodeAt(ci);
          if (cc !== 0xFE0F && cc !== 0xFE0E) glyph += m[0][ci];
        }
        span.textContent = glyph;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
}
// Keep password managers (1Password/LastPass/Bitwarden) from popping their autofill
// icon over our plain text fields — a field named "name"/"email" reads to them like a
// login. We tag every input so their inline menu stays out of the way. Safe to re-run.
function suppressPwManagers(root) {
  if (!root || !root.querySelectorAll) return;
  var inputs = root.querySelectorAll('input:not([data-1p-ignore]), textarea:not([data-1p-ignore])');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    el.setAttribute('data-1p-ignore', 'true');
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('data-bwignore', 'true');
    el.setAttribute('data-form-type', 'other');
    if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
  }
}
// After signing in via the "i'll bring this" prompt we come back with ?pledge=<id>
// — open that item's pledge dialog automatically so the flow just continues.
function campAutoOpenPledge() {
  try {
    var id = new URLSearchParams(window.location.search).get('pledge');
    if (!id) return;
    var modal = document.getElementById('pledge-modal-' + id);
    if (modal) { modal.style.display = 'flex'; var inp = modal.querySelector('input[name=qty]'); if (inp) inp.focus(); }
  } catch (e) {}
}
// ——— Local time + control-panel prefs (stored in localStorage, per device) ———
// Server timestamps are UTC (SQLite datetime). Anything wrapped in a
// .local-time[data-utc] span gets rewritten to the viewer's own time zone here,
// honoring the 12h/24h preference from the control panel.
function campTimeFmt() { try { return localStorage.getItem('campTimeFmt') || '12'; } catch (e) { return '12'; } }
function campConfettiOn() { try { return localStorage.getItem('campConfetti') !== 'off'; } catch (e) { return true; } }
function campFmtClock(d) {
  var h = d.getHours(), mi = d.getMinutes(), mm = (mi < 10 ? '0' : '') + mi;
  if (campTimeFmt() === '24') return (h < 10 ? '0' : '') + h + ':' + mm;
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + mm + ' ' + ap;
}
function campLocalizeTimes(root) {
  if (!root || !root.querySelectorAll) return;
  var els = root.querySelectorAll('.local-time[data-utc]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var m = (el.getAttribute('data-utc') || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) continue;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    var t = campFmtClock(d);
    if (el.getAttribute('data-fmt') === 'datetime') {
      var mo = d.getMonth() + 1, da = d.getDate();
      t = (mo < 10 ? '0' : '') + mo + '-' + (da < 10 ? '0' : '') + da + ' ' + t;
    }
    el.textContent = t;
  }
}
function campSetTimeFmt(v) {
  try { localStorage.setItem('campTimeFmt', v); } catch (e) {}
  campTickClock();
  campLocalizeTimes(document.body);
}
function campSetConfetti(on, el) {
  try { localStorage.setItem('campConfetti', on ? 'on' : 'off'); } catch (e) {}
  if (on && el) campConfetti(el); // a little celebratory proof it's back on
}
// The control panel's clock radios + effects checkbox reflect this device's
// prefs, which the server can't render — fill them in after the popup lands.
// (The email/notify checkbox is server-rendered state; leave it alone.)
function campInitSettings(root) {
  if (!root || !root.querySelectorAll) return;
  var radios = root.querySelectorAll('input[name="camp_time_fmt"]');
  for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === campTimeFmt();
  var fx = root.querySelector('#camp-fx-check');
  if (fx) fx.checked = campConfettiOn();
}

// After a swap, an item card carries data-complete="1|0" but may still be sitting
// in the wrong grouped section — e.g. editing needed_qty up flips a covered item
// back to incomplete. Move any such card to the section it belongs in, fix both
// section counts, then flash + scroll it into view so you SEE where it landed.
function campSectionCards(sec) { return sec ? sec.querySelectorAll(':scope > .item-card') : []; }
function campSyncSection(sec) {
  if (!sec) return;
  var n = campSectionCards(sec).length;
  var badge = sec.querySelector('.section-count');
  if (badge) badge.textContent = n;
  sec.classList.toggle('is-empty', n === 0);
}
function campReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function campEaseInOutQuad(p) {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}
// A hand-rolled smooth scroll to an absolute Y. We don't use scrollIntoView
// ({behavior:'smooth'}) because it's a silent no-op inside htmx's afterSwap (and
// in some automation contexts) — this rAF tween runs the same everywhere. Honors
// prefers-reduced-motion by jumping straight there.
function campSmoothScrollTo(targetY) {
  var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  var to = Math.max(0, Math.min(targetY, max));
  if (campReducedMotion()) { window.scrollTo(0, to); return; }
  var from = window.scrollY, dist = to - from, start = null, dur = 500;
  function step(ts) {
    if (start === null) start = ts;
    var p = Math.min(1, (ts - start) / dur);
    window.scrollTo(0, from + dist * campEaseInOutQuad(p));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
// The same tween, but for a scroll CONTAINER (both axes at once) rather than the
// page — the schedule grid scrolls sideways inside .sched-scroll. Same reason for
// hand-rolling it as campSmoothScrollTo.
function campSmoothScrollEl(el, targetLeft, targetTop) {
  var toL = Math.max(0, Math.min(targetLeft, Math.max(0, el.scrollWidth - el.clientWidth)));
  var toT = Math.max(0, Math.min(targetTop, Math.max(0, el.scrollHeight - el.clientHeight)));
  var fromL = el.scrollLeft, fromT = el.scrollTop;
  var dL = toL - fromL, dT = toT - fromT;
  if (!dL && !dT) return;
  if (campReducedMotion()) { el.scrollLeft = toL; el.scrollTop = toT; return; }
  var start = null, dur = 420;
  function step(ts) {
    if (start === null) start = ts;
    var p = Math.min(1, (ts - start) / dur);
    var e = campEaseInOutQuad(p);
    el.scrollLeft = fromL + dL * e;
    el.scrollTop = fromT + dT * e;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function campFlashMove(card) {
  card.classList.remove('item-moved');
  void card.offsetWidth; // force reflow so the animation restarts every move
  card.classList.add('item-moved');
  setTimeout(function () { card.classList.remove('item-moved'); }, 1600);
  // Defer a frame so layout has settled after the move, then glide the card to
  // the vertical center of the viewport so you see where it landed.
  requestAnimationFrame(function () {
    var rect = card.getBoundingClientRect();
    var targetY = window.scrollY + rect.top - (window.innerHeight - rect.height) / 2;
    campSmoothScrollTo(targetY);
  });
}
function campReflowItems() {
  var list = document.getElementById('stuff-list');
  if (!list) return;
  var want = { '1': document.getElementById('stuff-complete'), '0': document.getElementById('stuff-incomplete') };
  var cards = list.querySelectorAll('.item-card');
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    var target = want[card.getAttribute('data-complete') === '1' ? '1' : '0'];
    if (!target || card.parentElement === target) continue; // already in the right group
    var from = card.closest('.stuff-section');
    var header = target.querySelector('.stuff-section-header');
    if (header && header.nextSibling) target.insertBefore(card, header.nextSibling); // land at the top
    else target.appendChild(card);
    campSyncSection(from);
    campSyncSection(target);
    campFlashMove(card);
  }
}

document.addEventListener('DOMContentLoaded', function () { pixmojify(document.body); suppressPwManagers(document.body); campAutoOpenPledge(); campLocalizeTimes(document.body); campInitSettings(document.body); });
document.addEventListener('htmx:afterSwap', function (e) { pixmojify(e.target); suppressPwManagers(e.target); campLocalizeTimes(e.target); campInitSettings(e.target); campReflowItems(); });
// Out-of-band swaps (hx-swap-oob — the mine tab's #mine-floating, oob toasts,
// dialogs riding along into #popup-layer) fire oobAfterSwap, NOT afterSwap; without
// this hook their emoji silently lose the pixel font on every oob update.
document.addEventListener('htmx:oobAfterSwap', function (e) { pixmojify(e.target); suppressPwManagers(e.target); campLocalizeTimes(e.target); });

// Make the little "me"-tab XP windows draggable by their title bar. Position is
// tracked as an accumulated translate on each window (dataset.dx/dy) so repeated
// drags stack. Pressing a caption button doesn't start a drag. Document-level so it
// keeps working for windows re-rendered by HTMX swaps.
(function () {
  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest) return;
    var handle = e.target.closest('.xp-mini-titlebar, .xp-popup-titlebar');
    // Never start a drag (or pointer-capture!) from an interactive element — a
    // captured pointer retargets the follow-up click to the title bar, silently
    // eating ✕ taps. Match by tag, not class, so it survives markup renames.
    if (!handle || e.target.closest('button, a, input, select, label')) return;
    var win = handle.closest('.xp-mini, .xp-popup');
    if (!win) return;
    // Bring a clicked popup to the front of the stack.
    if (win.classList.contains('xp-popup')) win.style.zIndex = String(popupTop());
    var dx = parseFloat(win.dataset.dx || '0'), dy = parseFloat(win.dataset.dy || '0');
    drag = { win: win, sx: e.clientX, sy: e.clientY, bx: dx, by: dy };
    win.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var nx = drag.bx + (e.clientX - drag.sx), ny = drag.by + (e.clientY - drag.sy);
    drag.win.style.transform = 'translate(' + nx + 'px,' + ny + 'px)';
    drag.win.dataset.dx = nx; drag.win.dataset.dy = ny;
  });
  function endDrag() { if (drag) { drag.win.classList.remove('dragging'); drag = null; } }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
})();

// Floating XP popups: remove one, remove all, and figure out the next z-index.
function popupTop() {
  var wins = document.querySelectorAll('#popup-layer .xp-popup');
  var max = 1000;
  for (var i = 0; i < wins.length; i++) { var z = parseInt(wins[i].style.zIndex || '0', 10); if (z > max) max = z; }
  return max + 1;
}
function closePopup(el) { var w = el.closest('.xp-popup'); if (w) w.remove(); }
function closeAllPopups() { var l = document.getElementById('popup-layer'); if (l) l.innerHTML = ''; }

// Temporarily hide / bring back the sign-in modal when a takeover window (the
// name-taken warning) shows and is then dismissed — so they don't stack.
function campStashSignin() { var ov = document.getElementById('signin-modal-overlay'); if (ov) ov.style.display = 'none'; }
function campRestoreSignin() { var ov = document.getElementById('signin-modal-overlay'); if (ov) ov.style.display = ''; }

// Backdrop click-to-dismiss for the sign-in modal — but NOT when a second window
// (e.g. the name-taken warning) is open on top, and NOT when the user has typed
// something into the name or email field (don't throw away their input).
function campSigninBackdrop(e, backdrop) {
  if (e.target !== backdrop) return;
  var layer = document.getElementById('popup-layer');
  if (layer && layer.querySelector('.xp-popup')) return;
  var inputs = backdrop.querySelectorAll('input[name="name"], input[name="email"]');
  for (var i = 0; i < inputs.length; i++) { if ((inputs[i].value || '').trim()) return; }
  var overlay = document.getElementById('signin-modal-overlay');
  if (overlay) overlay.innerHTML = '';
}

// Schedule tab: tapping a set card's head expands it IN PLACE to reveal its
// buttons (no pop-out window). Only one card is open at a time; tapping the head
// again, tapping another card, tapping empty space, or pressing Escape collapses it.
//
// Must track the .sched-tile.expanded breakpoint in retro.css: below it the cards
// are thumb-sized and overlap each other, which is what the two rules below are for.
function campIsNarrow() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches);
}
function campToggleSetTile(head) {
  var tile = head.closest('.sched-tile');
  if (!tile) return;
  var open = tile.classList.contains('expanded');
  var other = document.querySelector('.sched-tile.expanded');

  // Phone rule: an open card floats over its neighbours, so a tap on a DIFFERENT
  // card is usually just "get this out of my way" — dismiss the open one and stop,
  // leaving the second tap to open what you actually want. But once you've dragged
  // the grid, you've gone looking for that other card on purpose, so open it right
  // away instead of making you tap twice.
  if (campIsNarrow() && other && other !== tile && !campTileDragged) {
    campCollapseSetTiles(null);
    return;
  }

  campCollapseSetTiles(tile);
  tile.classList.toggle('expanded', !open);
  campTileDragged = false;
  if (!open) campCenterSetTile(tile);
}
// Gently bring a just-opened card to the middle of the grid — it grows sideways
// and downwards as it expands, so near an edge it would otherwise open half
// off-screen. Phone only: on a wide screen the grid is roomy and yanking it around
// under the user would be worse than leaving it alone.
function campCenterSetTile(tile) {
  if (!campIsNarrow()) return;
  var scroller = tile.closest('.sched-scroll');
  if (!scroller) return;
  var t = tile.getBoundingClientRect();
  var s = scroller.getBoundingClientRect();
  campSmoothScrollEl(
    scroller,
    scroller.scrollLeft + (t.left - s.left) - (s.width - t.width) / 2,
    scroller.scrollTop + (t.top - s.top) - (s.height - t.height) / 2
  );
}
// Schedule import. The picture is turned into a data URL HERE, in the browser,
// and the Worker forwards that string to the vision model without ever touching the
// bytes.
//
// Why: a Worker on the free plan gets 10ms of CPU per request, and base64-encoding
// one 3MB photo measures ~9ms of it on its own — the whole budget, before the
// schedule has even been read. The browser has no such limit and does it instantly.
// FileReader also encodes natively, rather than the chunked fromCharCode + btoa
// dance a Worker has to do by hand.
function campFileToDataUrl(file) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () { resolve(r.result); };
    r.onerror = function () { reject(new Error('could not read ' + file.name)); };
    r.readAsDataURL(file);
  });
}
function campImportSchedule(e, form, url) {
  e.preventDefault();
  var input = form.querySelector('input[type=file]');
  var files = Array.prototype.slice.call((input && input.files) || []);
  if (!files.length) return false;

  var inner = document.getElementById('import-inner');
  var submit = form.querySelector('button[type=submit]');
  form.classList.add('is-reading');            // shows the "please wait" hint
  if (submit) submit.disabled = true;

  Promise.all(files.map(campFileToDataUrl))
    .then(function (images) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ images: images }),
      });
    })
    .then(function (r) { return r.text(); })
    .then(function (markup) {
      inner.innerHTML = markup;
      // The swapped-in preview has its own hx-post on it; htmx only wires up
      // markup it has seen, so hand it the new nodes.
      if (window.htmx) window.htmx.process(inner);
    })
    .catch(function () {
      form.classList.remove('is-reading');
      if (submit) submit.disabled = false;
      alert('Could not read that picture. Please try another one.');
    });
  return false;
}

// A touch device — where a link resolved mid-tap can't also be opened by that same
// tap, hence the "Click me!" handoff below. Not a width check: this is about how
// the browser treats window.open and app links, not how big the screen is.
function campIsTouch() {
  return !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
}

// "Play on Spotify" for an artist nobody has looked up yet: search, save the URL so
// every camp gets it for free from here on, and open it. Costs one search, once,
// for the first person to ever tap that artist.
//
// The awkward part: the URL doesn't exist until a request comes back, and by then
// the browser may have stopped trusting us to open anything. So we only ever open
// the REAL link — never a blank tab we redirect later, which showed the user an
// about:blank while they waited. Instead:
//
//  • Desktop — try window.open once the URL lands. Chrome/Firefox still count the
//    click as user activation for a few seconds, so a fast search sails through.
//  • Touch / a refused popup — a scripted open is both unreliable and won't hand
//    off to the Spotify app the way a real tap does. So don't fake it: ask for one
//    more tap on a genuine <a>, which opens the app properly.
//
// window.open returns null when the popup was refused, which is exactly the signal
// we need — but ONLY without 'noopener' (that makes it return null on success too),
// hence severing .opener by hand instead.
//
// The markup below mirrors spotifyAction() in src/routes/schedule.js, which renders
// these same end states server-side for everyone who arrives after caching.
function campSpotifyPlay(btn) {
  btn.disabled = true;
  btn.classList.add('is-finding');
  btn.textContent = 'Finding on Spotify';
  fetch(btn.getAttribute('data-resolve'), { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      btn.classList.remove('is-finding');
      // Carry the button's own classes over to whatever replaces it: the same
      // function drives the full-width button on a card AND the choice buttons in
      // the b2b picker dialog, which must NOT inherit the card's width:100%.
      var wide = btn.classList.contains('sched-act-btn') ? 'sched-act-btn ' : '';
      if (!d || d.status !== 'ok' || !d.url) {
        var s = document.createElement('span');
        s.className = wide + 'sched-spotify-none';
        s.textContent = (d && d.status === 'none') ? 'Not on Spotify' : "Spotify didn't answer";
        btn.replaceWith(s);
        return;
      }
      var opened = null;
      if (!campIsTouch()) {
        try {
          opened = window.open(d.url, '_blank');
          if (opened) { try { opened.opener = null; } catch (e) {} }
        } catch (e) { opened = null; }
      }
      var a = document.createElement('a');
      a.className = 'btn ' + wide + 'sched-spotify';
      a.href = d.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // Opened it for them: leave a plain link behind so a second click still works.
      // Didn't (touch, or the popup was refused): ask for the tap that will.
      if (opened) {
        a.textContent = 'Play on Spotify';
      } else {
        a.className += ' sched-spotify-ready';
        a.textContent = 'Click me!';
      }
      btn.replaceWith(a);
    })
    .catch(function () {
      btn.classList.remove('is-finding');
      btn.disabled = false;
      btn.textContent = 'Play on Spotify';
    });
}

// Did the user drag the grid since the open card was opened? Tracked from raw
// touch movement rather than scroll events on purpose: campCenterSetTile scrolls
// the container itself, and a programmatic scroll must not read as "the user
// scrolled away". The threshold keeps a wobbly tap from counting as a drag.
var campTileDragged = false;
var campTouchX = 0, campTouchY = 0;
document.addEventListener('touchstart', function (e) {
  var t = e.touches[0];
  if (t) { campTouchX = t.clientX; campTouchY = t.clientY; }
}, { passive: true });
document.addEventListener('touchmove', function (e) {
  var t = e.touches[0];
  if (!t) return;
  if (Math.abs(t.clientX - campTouchX) > 12 || Math.abs(t.clientY - campTouchY) > 12) campTileDragged = true;
}, { passive: true });
function campCollapseSetTiles(except) {
  var tiles = document.querySelectorAll('.sched-tile.expanded');
  for (var i = 0; i < tiles.length; i++) {
    if (tiles[i] === except) continue;
    tiles[i].classList.remove('expanded');
    campResetSpotifyPrompt(tiles[i]);
  }
}
// "Click me!" is asking for a tap RIGHT NOW — the link has just landed and only a
// real tap can hand off to the Spotify app. Dismiss the card and that moment is
// over, so reopening it should show the ordinary resolved button (which the link
// now is, for everyone) instead of still nagging.
function campResetSpotifyPrompt(tile) {
  var a = tile.querySelector('.sched-spotify-ready');
  if (!a) return;
  a.classList.remove('sched-spotify-ready');
  a.textContent = 'Play on Spotify';
}
// Tap/click anywhere that isn't inside a set card collapses the open one. A click
// inside any floating window isn't "away" — the card's own chat is one of those, and
// closing the card out from under it would be daft.
document.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  if (e.target.closest('.sched-tile')) return; // clicks inside a card are handled by it
  if (e.target.closest('.xp-popup')) return;
  if (!document.querySelector('.sched-tile.expanded')) return;
  campCollapseSetTiles(null);
});

// Same rule for the pop-out chat window: click away and it goes. The guard is the
// one thing a click-away must never do — throw away something you typed — so a chat
// with an unsent message in its box stays until you send it or close it yourself.
// Clicking the button that OPENS a chat is safe: htmx hasn't inserted the window
// yet when this fires, so there's nothing here to close.
document.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  if (e.target.closest('.xp-popup')) return; // inside a window, including this one
  var chats = document.querySelectorAll('#popup-layer .xp-popup.chat-popup');
  for (var i = 0; i < chats.length; i++) {
    var typed = chats[i].querySelector('.msn-compose input[name=body]');
    if (typed && (typed.value || '').trim()) continue;
    chats[i].remove();
  }
});

// When a popup is inserted (via htmx beforeend), give it a cascading position so
// stacked windows step down-and-right like real overlapping windows. If one with
// the same data-popup-id already exists, drop the old one first (re-open = move).
document.addEventListener('htmx:afterSwap', function (e) {
  var layer = document.getElementById('popup-layer');
  if (!layer) return;
  var fresh = layer.querySelectorAll('.xp-popup:not([data-placed])');
  for (var i = 0; i < fresh.length; i++) {
    (function (win) {
      var pid = win.getAttribute('data-popup-id');
      if (pid) {
        var dups = layer.querySelectorAll('.xp-popup[data-popup-id="' + pid + '"][data-placed]');
        for (var j = 0; j < dups.length; j++) dups[j].remove();
      }
      var n = layer.querySelectorAll('.xp-popup[data-placed]').length;
      win.setAttribute('data-placed', '1');
      // Center the first window; cascade any stacked on top of it down-and-right.
      var w = win.offsetWidth || 300, h = win.offsetHeight || 180;
      var cl = Math.max(10, (window.innerWidth - w) / 2);
      var ct = Math.max(10, (window.innerHeight - h) / 2 - 30);
      win.style.left = (cl + n * 28) + 'px';
      win.style.top = (ct + n * 28) + 'px';
      win.style.zIndex = String(popupTop());
      // The name-taken warning takes over from the sign-in form rather than stacking.
      if (pid === 'name-taken') campStashSignin();
      var input = win.querySelector('input[type=text], input:not([type])');
      if (input) input.focus();
    })(fresh[i]);
  }
});

// ppl-tab select mode: the "merge people" / "delete person" buttons reveal a
// checkbox on every row. Merge needs exactly 2; delete takes 1+. Both submit via
// htmx into #main. Delete is reversible, so we say so in the confirm.
function campSelBar() { var m = document.getElementById('main'); return m ? m.querySelector('.ppl-select-bar') : null; }
function campSelList() { var m = document.getElementById('main'); return m ? m.querySelector('.ppl-list') : null; }
function campSelChecked() {
  var list = campSelList(); if (!list) return [];
  return Array.prototype.slice.call(list.querySelectorAll('.ppl-select-check:checked'));
}
function campEnterSelect(btn, mode) {
  var bar = campSelBar(), list = campSelList();
  if (!bar || !list) return;
  bar.setAttribute('data-mode', mode);
  bar.hidden = false;
  list.classList.add('selecting');
  var checks = list.querySelectorAll('.ppl-select-check');
  for (var i = 0; i < checks.length; i++) checks[i].checked = false;
  campUpdateSelect();
}
function campCancelSelect() {
  var bar = campSelBar(), list = campSelList();
  if (list) { list.classList.remove('selecting'); var checks = list.querySelectorAll('.ppl-select-check'); for (var i = 0; i < checks.length; i++) checks[i].checked = false; }
  if (bar) bar.hidden = true;
}
function campUpdateSelect() {
  var bar = campSelBar(); if (!bar) return;
  var mode = bar.getAttribute('data-mode');
  var n = campSelChecked().length;
  var hint = bar.querySelector('.ppl-select-hint');
  var go = bar.querySelector('.ppl-select-go');
  if (mode === 'merge') {
    go.textContent = 'Merge Selected'; go.disabled = n !== 2;
    hint.textContent = 'Select the 2 entries that belong to the same camper — ' + n + ' of 2 selected.';
  } else if (mode === 'rename') {
    go.textContent = 'Rename Selected'; go.disabled = n !== 1;
    hint.textContent = 'Select the camper whose name you want to fix — ' + n + ' of 1 selected.';
  } else {
    go.textContent = 'Delete Selected'; go.disabled = n < 1;
    hint.textContent = 'Select the campers you want to remove ' + n + ' selected.';
  }
}
// How many rows a mode will let you tick. Delete takes any number, so it's absent.
function campSelectCap(mode) {
  if (mode === 'merge') return 2;
  if (mode === 'rename') return 1;
  return Infinity;
}
document.addEventListener('change', function (e) {
  if (!e.target.classList || !e.target.classList.contains('ppl-select-check')) return;
  var bar = campSelBar();
  if (bar && campSelChecked().length > campSelectCap(bar.getAttribute('data-mode'))) { e.target.checked = false; return; }
  campUpdateSelect();
});
// In select mode, clicking anywhere on a row toggles its checkbox (not just the box).
document.addEventListener('click', function (e) {
  var list = campSelList();
  if (!list || !list.classList.contains('selecting') || !e.target.closest) return;
  var row = e.target.closest('.ppl-row');
  if (!row || !list.contains(row)) return;
  if (e.target.closest('.ppl-select-box')) return; // clicking the box itself handles natively
  var cb = row.querySelector('.ppl-select-check');
  if (!cb) return;
  var bar = campSelBar();
  if (!cb.checked && bar && campSelChecked().length >= campSelectCap(bar.getAttribute('data-mode'))) return;
  cb.checked = !cb.checked;
  campUpdateSelect();
});
function campRunSelect(go) {
  var bar = campSelBar(); if (!bar) return;
  var mode = bar.getAttribute('data-mode'), fest = bar.getAttribute('data-fest');
  var checked = campSelChecked();
  var ids = checked.map(function (c) { return c.value; });
  // Both actions now confirm through an authentic XP message dialog (server-rendered
  // into #popup-layer, names/counts looked up server-side) instead of a native
  // confirm() box — its Yes button owns the real POST. See people.js *-window routes.
  if (mode === 'merge') {
    if (ids.length !== 2) return;
    htmx.ajax('GET', '/f/' + fest + '/people/merge-window?ids=' + encodeURIComponent(ids.join(',')), { target: '#popup-layer', swap: 'beforeend' });
  } else if (mode === 'rename') {
    // Rename isn't a confirm — it's a form. Same popup plumbing, one id not a list.
    if (ids.length !== 1) return;
    htmx.ajax('GET', '/f/' + fest + '/people/rename-window?id=' + encodeURIComponent(ids[0]), { target: '#popup-layer', swap: 'beforeend' });
  } else {
    if (!ids.length) return;
    htmx.ajax('GET', '/f/' + fest + '/people/delete-window?ids=' + encodeURIComponent(ids.join(',')), { target: '#popup-layer', swap: 'beforeend' });
  }
}

// Car-roster remove mode — the same "reveal a checkbox on every row, pick some,
// confirm" flow as the ppl tab, but scoped to the ONE expanded car card the button
// lives in (a page shows many cars at once, so nothing here is global). Unlike ppl,
// the final confirm is an authentic XP dialog: campCarConfirmRemove hands the picked
// seat ids to the server, which renders the xpDialogPopup and owns the actual delete.
function campCarCard(el) { return el.closest('.car-details'); }
function campCarChecks(card) { return card.querySelectorAll('.car-select-check'); }
function campCarChecked(card) {
  return Array.prototype.slice.call(card.querySelectorAll('.car-select-check:checked'));
}
function campCarSelect(btn) {
  var card = campCarCard(btn); if (!card) return;
  var roster = card.querySelector('.car-roster'), bar = card.querySelector('.car-select-bar');
  if (!roster || !bar) return;
  // Remove mode and edit mode are mutually exclusive — opening one closes the other
  // so their panels never stack/overlap. (The Edit label's onclick calls the cancel
  // side.) Close the edit panel by un-checking its CSS toggle.
  var editToggle = card.querySelector('.edit-toggle-checkbox');
  if (editToggle) editToggle.checked = false;
  roster.classList.add('selecting');
  bar.hidden = false;
  var checks = campCarChecks(card);
  for (var i = 0; i < checks.length; i++) checks[i].checked = false;
  campCarSelUpdate(card);
}
function campCarSelCancel(btn) {
  var card = campCarCard(btn); if (!card) return;
  var roster = card.querySelector('.car-roster'), bar = card.querySelector('.car-select-bar');
  if (roster) roster.classList.remove('selecting');
  var checks = campCarChecks(card);
  for (var i = 0; i < checks.length; i++) checks[i].checked = false;
  if (bar) bar.hidden = true;
}
function campCarSelUpdate(card) {
  var bar = card.querySelector('.car-select-bar'); if (!bar) return;
  var n = campCarChecked(card).length;
  var go = bar.querySelector('.car-select-go'), hint = bar.querySelector('.car-select-hint');
  go.disabled = n < 1;
  hint.textContent = 'Pick who to remove, ' + n + ' selected.';
}
function campCarConfirmRemove(go) {
  var card = campCarCard(go); if (!card) return;
  var ids = campCarChecked(card).map(function (c) { return c.value; });
  if (!ids.length) return;
  var carId = (card.id || '').replace('car-', '');
  htmx.ajax('GET', '/cars/' + carId + '/seats/remove-window?ids=' + ids.join(','), { target: '#popup-layer', swap: 'beforeend' });
}
// Driver picker on the post-a-car form: choosing "someone who hasn't signed up"
// reveals a name field (and focuses it); any real person hides it again. The name
// only matters when __new__ is selected — the server ignores it otherwise.
function campDriverPick(sel) {
  var form = sel.closest('form'); if (!form) return;
  var row = form.querySelector('.new-driver-row'); if (!row) return;
  var isNew = sel.value === '__new__';
  row.hidden = !isNew;
  var input = row.querySelector('input[name=new_driver_name]');
  if (input) { input.required = isNew; if (isNew) input.focus(); }
}

// Set Meeting Spot popup: clicking a place-search result copies its exact
// name/address/maps-link (carried in data- attributes by the server) into the
// form fields and dismisses the result list.
function campMeetPick(btn) {
  var form = btn.closest('form'); if (!form) return;
  var set = function (name, val) {
    var input = form.querySelector('[name=' + name + ']');
    if (input) input.value = val || '';
  };
  set('meet_name', btn.dataset.name);
  set('meet_address', btn.dataset.address);
  set('meet_maps_url', btn.dataset.url);
  var results = form.querySelector('#meet-search-results');
  if (results) results.innerHTML = '';
}

// "idk yet" seat toggle (post + edit car forms): checking it greys out the number
// field — a disabled input isn't submitted, so the server only sees seats_unknown=1
// and leaves the placeholder count untouched.
function campSeatsUnknown(cb) {
  var wrap = cb.closest('.seats-input'); if (!wrap) return;
  var num = wrap.querySelector('input[name=seats_total]');
  if (num) num.disabled = cb.checked;
}

// Same delegated toggles the ppl list uses, for the car roster's own checkboxes.
document.addEventListener('change', function (e) {
  if (!e.target.classList || !e.target.classList.contains('car-select-check')) return;
  var card = campCarCard(e.target); if (card) campCarSelUpdate(card);
});
document.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  var roster = e.target.closest('.car-roster');
  if (!roster || !roster.classList.contains('selecting')) return;
  var row = e.target.closest('.roster-row'); if (!row) return;
  if (e.target.closest('.car-select-box')) return; // the box toggles itself natively
  var cb = row.querySelector('.car-select-check'); if (!cb) return;
  cb.checked = !cb.checked;
  var card = campCarCard(row); if (card) campCarSelUpdate(card);
});

// MSN emoticon toolbar: append the typed emoticon into the chat's compose box.
function msnEmote(el, txt) {
  var chat = el.closest('.msn-chat');
  var input = chat && chat.querySelector('input[name=body]');
  if (input) { input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + txt; }
}

// Expand-all / collapse-all toggle above the stuff list. Expands every card if
// any is collapsed; otherwise collapses them all. Chats are deliberately left
// closed in bulk — expanding every conversation at once is too much noise.
function campToggleExpandAll(btn) {
  var list = document.getElementById('stuff-list');
  var dets = list ? list.querySelectorAll('.item-details') : [];
  var anyClosed = false;
  for (var i = 0; i < dets.length; i++) { if (!dets[i].open) { anyClosed = true; break; } }
  for (var j = 0; j < dets.length; j++) {
    // Close the chat cleanly FIRST (removeAttribute avoids a ghost-painted nested
    // <details> that shows expanded-but-empty), then set the card's state. Bulk
    // expand/collapse always leaves chats closed.
    var chat = dets[j].querySelector('.msn-chat');
    if (chat) chat.removeAttribute('open');
    dets[j].open = anyClosed;
  }
  btn.textContent = anyClosed ? '⊟ Collapse All' : '⊞ Expand All';
}

// Opening a single item card (by clicking its header) pops its chat open too, so
// one expanded tile shows the whole conversation. Bulk expand-all skips this.
document.addEventListener('click', function (e) {
  if (!e.target.closest) return;
  var summary = e.target.closest('.item-summary');
  if (!summary) return;
  var card = summary.parentElement; // .item-details
  setTimeout(function () {
    var chat = card.querySelector('.msn-chat');
    if (chat) chat.open = card.open;
  }, 0);
});

// Live "hey, that name's taken" heads-up as you type — never blocks submission,
// just a nudge in case you didn't mean to pick an existing name.
var campNameCheckTimer;
document.addEventListener('input', function (e) {
  if (!e.target.classList || !e.target.classList.contains('signin-name-input')) return;
  var input = e.target;
  var notice = (input.closest('form') || input.parentElement).querySelector('.name-taken-notice');
  if (!notice) return;
  clearTimeout(campNameCheckTimer);
  var val = input.value.trim();
  if (!val) { notice.textContent = ''; return; }
  campNameCheckTimer = setTimeout(function () {
    fetch('/signin/check-name?name=' + encodeURIComponent(val))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (input.value.trim() !== val) return;
        notice.textContent = data.taken
          ? ('The name "' + data.display_name + '" is already in use. If this is you, you will be signed in as them. If not, choose a name that is more identifiable.')
          : '';
      })
      .catch(function () {});
  }, 350);
});

// ——— XP taskbar: Start menu + tray clock ———————————————————————————
function campToggleStart(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  var m = document.getElementById('xp-startmenu');
  if (m) m.hidden = !m.hidden;
}
function campCloseStart() {
  var m = document.getElementById('xp-startmenu');
  if (m) m.hidden = true;
}
// Click anywhere outside the menu (or press Escape) closes it, like real Windows.
document.addEventListener('click', function (e) {
  var m = document.getElementById('xp-startmenu');
  if (!m || m.hidden || !e.target.closest) return;
  if (e.target.closest('#xp-startmenu') || e.target.closest('.xp-start-btn')) return;
  m.hidden = true;
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { campCloseStart(); campCollapseSetTiles(null); } });

// The little tray clock. No seconds, and it follows the 12h/24h preference
// from the control panel (XP default: 12-hour).
function campTickClock() {
  var el = document.getElementById('xp-clock');
  if (!el) return;
  el.textContent = campFmtClock(new Date());
}
document.addEventListener('DOMContentLoaded', campTickClock);
setInterval(campTickClock, 15000);

// ——— Rover's secret. He asked you nicely not to. ————————————————————
// Five quick pets (clicks) on the dog = an authentic XP Stop error. Any key,
// click, or tap brings the site back — no harm done, exactly like the real
// thing except the opposite.
var dogPets = 0, dogPetTimer = null;
document.addEventListener('click', function (e) {
  if (!e.target.classList || !e.target.classList.contains('dog-img')) return;
  clearTimeout(dogPetTimer);
  dogPets++;
  e.target.classList.remove('petted');
  void e.target.offsetWidth; // restart the wiggle animation on every pet
  e.target.classList.add('petted');
  if (dogPets >= 5) { dogPets = 0; campBsod(); return; }
  dogPetTimer = setTimeout(function () { dogPets = 0; }, 1600);
});
function campBsod() {
  if (document.getElementById('xp-bsod')) return;
  var lines = [
    'A problem has been detected and camp planner has been shut down to prevent',
    'damage to your festival.',
    '',
    'DOG_PETTED_TOO_MANY_TIMES',
    '',
    "If this is the first time you've seen this Stop error screen, restart your",
    'browser. If this screen appears again, follow these steps:',
    '',
    'Check to make sure your tent is properly staked and your cooler is',
    'adequately iced. If this is a new festival, ask the group chat for any',
    'updates you might need.',
    '',
    'If problems continue, disable or remove any recently added campers. If you',
    'need to use Safe Mode to remove or disable components, restart your',
    'computer, press F8 to select Advanced Startup Options, and then select',
    'Safe Mode.',
    '',
    'Technical information:',
    '',
    '*** STOP: 0x0000D06E (0xC0FFEE00, 0x00000005, 0x0BADD06E, 0x00000000)',
    '',
    '***  rover.sys - Address 0x0BADD06E base at 0xC0FFEE00, DateStamp 10/25/2001',
    '',
    'Beginning dump of physical memory',
    'Physical memory dump complete.',
    'Contact your camp administrator or the dog for further assistance.',
    'He told you not to do that.',
    '',
    'Press any key (or tap) to continue ',
  ];
  var d = document.createElement('div');
  d.id = 'xp-bsod';
  d.className = 'xp-bsod';
  d.textContent = lines.join('\n');
  var cur = document.createElement('span');
  cur.className = 'xp-bsod-cursor';
  cur.textContent = '_';
  d.appendChild(cur);
  function dismiss() {
    d.remove();
    document.removeEventListener('keydown', dismiss);
  }
  // Arm dismissal a beat later so the fifth pet-click doesn't close it instantly.
  setTimeout(function () {
    d.addEventListener('click', dismiss);
    document.addEventListener('keydown', dismiss);
  }, 400);
  document.body.appendChild(d);
}