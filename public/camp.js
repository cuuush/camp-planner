/* All of camp planner's client-side JS. Loaded from <head> with defer, so it no
   longer blocks the HTML parse — which matters, because the stuff page is a lot of
   HTML. It still runs before DOMContentLoaded, so the listener below fires as
   normal. Keep binding top-level listeners to `document` rather than document.body:
   it costs nothing, and it's what kept this file working back when it ran before
   <body> existed (a throw on a null body silently killed every listener declared
   after it). Anything that needs the DOM belongs in a callback. */
// Optimistic vote count. htmx CANNOT do this on its own — it only paints what the
// server sends back, so on a phone the number sat still for a whole round trip and
// the tap felt broken. So: flip the button's own state the instant it's pressed,
// then let the htmx swap land on top with the authoritative count a moment later.
// Deliberately dumb — no request tracking, no rollback. The swap is the source of
// truth and always wins, so the worst case for a failed request is a number that's
// briefly off by one and corrects itself on the next render.
function campVoteOptimistic(btn) {
  var out = btn.querySelector('.vote-count');
  if (!out) return;
  var voted = btn.classList.contains('voted');
  var n = parseInt(out.textContent, 10);
  if (isNaN(n)) return;
  out.textContent = Math.max(0, n + (voted ? -1 : 1));
  btn.classList.toggle('voted', !voted);
}
// Same trick for the item header's "i'm bringing this" check box: flip the drawn
// tick the instant it's tapped so the box doesn't sit there looking dead for a
// round trip. The swap that follows carries the real state and always wins.
function campPledgeOptimistic(btn) {
  var box = btn.querySelector('.xp-checkbox');
  if (!box) return;
  var checked = box.classList.toggle('checked');
  btn.setAttribute('aria-checked', checked ? 'true' : 'false');
  // Run the progress bar at the same time. Both widths come from the server on the
  // button itself (data-pct-on/off) because the client can't work out the untick
  // width on its own — it'd have to know which name in the tally is yours.
  var card = btn.closest('.item-card');
  var fill = card && card.querySelector('.progress-fill');
  var pct = btn.getAttribute(checked ? 'data-pct-on' : 'data-pct-off');
  if (!fill || pct === null) return;
  campStepProgress(fill, parseFloat(pct));
}
// Packing Mode: same trick again for ticking something off the list.
// Flip the drawn tick, the row's packed styling AND the status bar's count, because
// the swap that carries the real numbers is a whole round trip away and this is a
// control people tap down a list of ten things in a row.
function campPackOptimistic(btn) {
  var box = btn.querySelector('.xp-checkbox');
  var row = btn.closest('.bringing-row');
  if (!box || !row) return;
  var packed = box.classList.toggle('checked');
  row.classList.toggle('packed', packed);
  var win = row.closest('.xp-mini-body');
  var out = win && win.querySelector('.bringing-packed-n');
  if (!out) return;
  var n = parseInt(out.textContent, 10);
  if (!isNaN(n)) out.textContent = Math.max(0, n + (packed ? 1 : -1));
}
// Move a progress bar to `pct`, advancing one green block at a time like the XP
// file-copy dialog instead of gliding smoothly. The bar's block pitch comes from
// --progress-block (set beside the gradient that draws them, so the two can't drift
// apart); the number of blocks between here and there becomes the step count, and
// the duration follows it so a long fill takes longer than a short one without
// dragging. Leaving the timing alone under prefers-reduced-motion lets the
// stylesheet's `transition: none` win and the bar simply snaps.
// The dialog branch of the same idea. Tapping a check box that only opens the "how
// many" dialog mustn't move anything — nothing is decided yet — so the optimistic
// tick and bar run here, on OK, once there's an amount to show. Hides the dialog
// first: the animation is pointless behind a modal backdrop. Runs before htmx's own
// submit handler (inline attributes are bound at parse time, htmx binds later) and
// deliberately doesn't preventDefault, so the POST goes out as normal — a hidden
// form still serializes fine, only disabled fields are dropped.
function campPledgeDialogOptimistic(form) {
  var input = form.querySelector('input[name=qty]');
  var qty = input ? parseInt(input.value, 10) : NaN;
  if (input) input.blur(); // drop the phone keyboard with the dialog
  var modal = form.closest('.modal-backdrop');
  if (modal) modal.style.display = 'none';
  var card = document.getElementById('item-' + form.getAttribute('data-item-id'));
  if (!card || isNaN(qty) || qty < 0) return;

  var check = card.querySelector('.pledge-check');
  var box = check && check.querySelector('.xp-checkbox');
  if (box) box.classList.toggle('checked', qty > 0);
  if (check) check.setAttribute('aria-checked', qty > 0 ? 'true' : 'false');

  var needed = parseFloat(form.getAttribute('data-needed')) || 0;
  var others = parseFloat(form.getAttribute('data-others')) || 0;
  var fill = card.querySelector('.progress-fill');
  // Same rounding as the server's pctOf(), so the optimistic width and the one that
  // lands with the swap agree to the pixel.
  if (fill && needed > 0) campStepProgress(fill, Math.min(100, Math.round(((others + qty) / needed) * 100)));
}

// htmx swaps the WHOLE card out, and the replacement bar paints at its final width
// the instant it lands — so whenever the response beat the animation (i.e. almost
// always) the block-by-block fill was cut off part-way and jumped to the end. Fix:
// note where the outgoing bar had actually got to, then start the incoming one from
// there and let it walk the rest of the way. The server's width is still what it
// animates TO, so this only restores the motion, never the value.
var campBarResume = {};
document.addEventListener('htmx:beforeSwap', function (e) {
  var t = (e.detail && e.detail.target) || e.target;
  if (!t || !t.querySelectorAll) return;
  // Only bars actually mid-walk are marked, so this measures one element in
  // practice — reading every card's geometry here would force a full layout on
  // list-wide swaps for nothing.
  var fills = t.querySelectorAll('.progress-fill[data-stepping]');
  for (var i = 0; i < fills.length; i++) {
    var fill = fills[i];
    var card = fill.closest('.item-card');
    var bar = fill.parentNode;
    var track = bar ? bar.clientWidth - 4 : 0;
    if (!card || !card.id || track <= 0) continue;
    campBarResume[card.id] = (fill.getBoundingClientRect().width / track) * 100;
  }
});
// A bar that has arrived is no longer mid-walk.
document.addEventListener('transitionend', function (e) {
  var el = e.target;
  if (el && el.classList && el.classList.contains('progress-fill')) el.removeAttribute('data-stepping');
});
// Every swap flushes the whole map, so nothing lingers if a card was deleted or a
// request failed between the two events.
function campResumeBars() {
  for (var id in campBarResume) {
    var from = campBarResume[id];
    delete campBarResume[id];
    var card = document.getElementById(id);
    var fill = card && card.querySelector('.progress-fill');
    if (!fill) continue;
    var to = parseFloat(fill.style.width) || 0;
    if (Math.abs(to - from) < 0.5) continue; // wasn't mid-animation — leave it alone
    fill.style.transition = 'none';
    fill.style.width = from + '%';
    void fill.offsetWidth;      // commit that start position before re-enabling motion
    fill.style.transition = ''; // back to the stylesheet's transition
    campStepProgress(fill, to);
  }
}
function campStepProgress(fill, pct) {
  if (!campReducedMotion()) {
    var bar = fill.parentNode;
    var block = parseFloat(getComputedStyle(fill).getPropertyValue('--progress-block')) || 8;
    // clientWidth includes the trough's 2px padding on each side; the fill only
    // ever spans the content box, so take that off before converting % to px.
    var track = bar ? Math.max(0, bar.clientWidth - 4) : 0;
    var fromPx = fill.getBoundingClientRect().width;
    var blocks = Math.max(1, Math.round(Math.abs(track * (pct / 100) - fromPx) / block));
    fill.style.transitionTimingFunction = 'steps(' + blocks + ', end)';
    fill.style.transitionDuration = Math.min(700, blocks * 55) + 'ms';
    // Marks this bar as mid-walk so a swap landing on top of it knows to resume
    // rather than let the replacement snap to the end (see campBarResume).
    fill.setAttribute('data-stepping', '1');
  }
  fill.style.width = pct + '%';
}
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
  // Off (the default) → don't wrap at all, rather than wrap and then style the
  // pixel font away. No wrapping means no flash of pixel emoji on load and none of
  // the spans on the page (the stuff tab alone has hundreds).
  if (!campPixmojiOn()) return;
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
// --- how much screen is ACTUALLY visible right now -------------------------
// The layout viewport lies once a keyboard is up: it keeps its full height, the
// keyboard is simply drawn on top of it, and position:fixed still spans the whole
// thing. So a "centred" dialog centres against a box whose bottom half you can't
// see, and it ends up crowded down by the keyboard and iOS's floating URL bar.
// 100dvh doesn't help — on iOS it tracks the toolbars, not the keyboard.
//
// window.visualViewport is the thing that actually knows: .height is the region
// being shown to you (keyboard, toolbars and URL bar all excluded) and .offsetTop
// is where that region starts inside the layout viewport. We publish both as CSS
// custom properties on <html>; .modal-backdrop sizes itself to them, and ordinary
// centring then puts a dialog in the middle of the free space by construction.
// Nothing has to know a keyboard exists.
//
// Kept always-on rather than switched on when a dialog opens: a stale value would
// show up as a visible jump on the frame a dialog appears. The cost is two custom
// property writes, only when the rounded numbers actually change — visualViewport
// fires on keyboard show/hide, rotation, pinch-zoom pans and the iOS URL bar
// collapsing mid-scroll, which is why the writes are rAF-throttled and diffed.
var campVVFrame = 0, campVVLastH = -1, campVVLastT = -1;
function campApplyViewport() {
  campVVFrame = 0;
  var vv = window.visualViewport;
  // Round: iOS reports fractional heights that jitter by hundredths mid-scroll,
  // and every distinct value would otherwise cost a style recalculation.
  var h = Math.round(vv.height), t = Math.round(vv.offsetTop);
  if (h === campVVLastH && t === campVVLastT) return;
  campVVLastH = h;
  campVVLastT = t;
  var s = document.documentElement.style;
  s.setProperty('--vv-height', h + 'px');
  s.setProperty('--vv-top', t + 'px');
}
function campQueueViewport() {
  if (!campVVFrame) campVVFrame = requestAnimationFrame(campApplyViewport);
}
function campTrackViewport() {
  var vv = window.visualViewport;
  if (!vv) return;                 // pre-iOS-13; CSS falls back to the full viewport
  campApplyViewport();
  vv.addEventListener('resize', campQueueViewport);
  vv.addEventListener('scroll', campQueueViewport);
}
campTrackViewport();

// Open an item's "how many are you bringing" dialog with the field already live,
// so the iOS keyboard comes straight up instead of costing a second tap. The
// focus() MUST happen synchronously inside the tap handler — iOS only raises the
// keyboard for a focus that's part of a real user gesture, so deferring it (a
// setTimeout, a rAF, an animation callback) leaves the caret blinking with the
// keyboard still down. focus() alone is what raises it; no selection required.
//
// Then park the caret AFTER the number rather than selecting it — a highlighted
// value is hard to read, and this way typing extends the suggested number instead
// of replacing it. setSelectionRange() is the obvious tool and it throws on
// type=number, so instead we lean on the spec'd behaviour of the value setter:
// assigning a DIFFERENT value moves the text entry cursor to the end. Assigning
// the same string back is allowed to be a no-op, hence the round trip through ''.
function campOpenPledge(id) {
  var modal = document.getElementById('pledge-modal-' + id);
  if (!modal) return;
  modal.style.display = 'flex';
  var input = modal.querySelector('input[name=qty]');
  if (!input) return;
  input.focus();
  try {
    var v = input.value;
    input.value = '';
    input.value = v;
  } catch (e) {}
}
// After signing in via the "i'll bring this" check box we come back with
// ?pledge=<id> — pick that item's tick back up where it left off. Which means
// doing whatever the check box itself would have done: for an item they want
// several of, open the "how many" dialog; for a one-of item, just tick it, since
// the box never asks there and landing on a dialog would be a surprise.
// Put a card on screen without yanking the page around if it's already there.
// Called on the way back from sign-in: the #item-N anchor is meant to do this, but
// the browser's fragment scroll happens as the element is parsed and then late
// layout (fonts, images, a long list) shifts everything under it, so you end up
// back at the top with a dialog floating over a list you can't place yourself in.
function campScrollItemIntoView(el) {
  if (!el || !el.getBoundingClientRect) return;
  var vh = window.innerHeight || 0;
  var r = el.getBoundingClientRect();
  if (r.top >= 0 && r.bottom <= vh) return; // already fully visible — leave it alone
  window.scrollTo(0, Math.max(0, window.scrollY + r.top - Math.max(12, (vh - r.height) / 2)));
}
function campAutoOpenPledge() {
  try {
    var id = new URLSearchParams(window.location.search).get('pledge');
    if (!id) return;
    var card = document.getElementById('item-' + id);
    campScrollItemIntoView(card);
    // Once more when the page has actually settled: `load` (unlike DOMContentLoaded)
    // has waited for stylesheets and images, so the card has stopped moving. The
    // in-view check above makes this a no-op if the first pass held, so it can't
    // steal the scroll from someone who has already started moving around.
    window.addEventListener('load', function () { campScrollItemIntoView(card); }, { once: true });
    var check = document.querySelector('#item-' + id + ' .pledge-check');
    if (check && check.getAttribute('hx-post')) { check.click(); return; }
    campOpenPledge(id);
  } catch (e) {}
}
// Sign-in is a full-page redirect (it has to work without JS), so it comes back to
// ?expand=item-5&pledge=5 to reopen whatever you were in the middle of. Those are
// plumbing: by the time this runs the server has already rendered the card open and
// campAutoOpenPledge has resumed the tick, so wipe them out of the address bar
// rather than leave them to be looked at, bookmarked or shared. replaceState adds no
// history entry, and the #item-5 anchor stays — that one is a real anchor and
// :target styling reads it. MUST run after campAutoOpenPledge, which needs ?pledge.
function campTidyUrl() {
  try {
    if (!window.history || !history.replaceState) return;
    var url = new URL(window.location.href);
    var plumbing = ['expand', 'pledge'];
    var dirty = false;
    for (var i = 0; i < plumbing.length; i++) {
      if (url.searchParams.has(plumbing[i])) { url.searchParams.delete(plumbing[i]); dirty = true; }
    }
    if (!dirty) return; // don't touch ?sort= and friends — those are the user's own
    var qs = url.searchParams.toString();
    history.replaceState(history.state, '', url.pathname + (qs ? '?' + qs : '') + url.hash);
  } catch (e) {}
}
// ——— Local time + control-panel prefs (stored in localStorage, per device) ———
// Server timestamps are UTC (SQLite datetime). Anything wrapped in a
// .local-time[data-utc] span gets rewritten to the viewer's own time zone here,
// honoring the 12h/24h preference from the control panel.
function campTimeFmt() { try { return localStorage.getItem('campTimeFmt') || '12'; } catch (e) { return '12'; } }
function campConfettiOn() { try { return localStorage.getItem('campConfetti') !== 'off'; } catch (e) { return true; } }
// Pixel emoji are OPT-IN (Control Panel → Appearance). Off by default means the
// tree walk never runs, no .pixmoji spans land on the page, and the two Unifont
// faces are never used — so the browser never downloads them.
function campPixmojiOn() { try { return localStorage.getItem('campPixmoji') === 'on'; } catch (e) { return false; } }
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
  campLocalizeSchedule(root);
}
// Schedule times are stored as minutes-from-midnight, not a UTC instant (see
// src/lib/schedule.js), so they need their own wrap/format logic rather than
// riding campFmtClock's Date-based path. Server renders 12-hour text as the
// no-JS fallback; data-*-min carries the raw minutes so the toggle can rewrite
// it here without a round trip.
function campWrapMin(min) { return ((Math.round(Number(min)) % 1440) + 1440) % 1440; }
function campFmtSetTime(min) {
  if (min == null || min === '' || !isFinite(Number(min))) return '';
  var wrapped = campWrapMin(min);
  var h = Math.floor(wrapped / 60), mi = wrapped % 60, mm = (mi < 10 ? '0' : '') + mi;
  if (campTimeFmt() === '24') return (h < 10 ? '0' : '') + h + ':' + mm;
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + mm + ' ' + ap;
}
function campFmtSetRange(startMin, endMin) {
  var a = campFmtSetTime(startMin), b = campFmtSetTime(endMin);
  if (a && b) return a + ' – ' + b;
  return a || b || '';
}
function campFmtHourLabel(min) {
  if (min == null || min === '' || !isFinite(Number(min))) return '';
  var wrapped = campWrapMin(min);
  var h = Math.floor(wrapped / 60);
  if (campTimeFmt() === '24') return (h < 10 ? '0' : '') + h;
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ' ' + ap;
}
function campLocalizeSchedule(root) {
  if (!root || !root.querySelectorAll) return;
  var ranges = root.querySelectorAll('[data-start-min]');
  for (var i = 0; i < ranges.length; i++) {
    var el = ranges[i];
    el.textContent = campFmtSetRange(el.getAttribute('data-start-min'), el.getAttribute('data-end-min'));
  }
  var hours = root.querySelectorAll('[data-hour-min]');
  for (var j = 0; j < hours.length; j++) {
    var hEl = hours[j];
    hEl.textContent = campFmtHourLabel(hEl.getAttribute('data-hour-min'));
  }
  campInitScheduleScroll(root);
}
// The grid runs top→bottom as evening→late-night, so the headliners sit at the very
// BOTTOM of the poster. Open it scrolled there — bottom-left — so the acts people
// actually came for are the first thing on screen, not the afternoon openers. Once
// per grid instance (the data flag): it never fights a manual scroll, and it doesn't
// re-fire when only a tile's buttons swap (that swap's subtree has no .sched-scroll).
// FALLBACK ONLY: .sched-start-here + scroll-initial-target (retro.css) is the real
// mechanism. This covers browsers without it — and must not repeat the bug it used
// to have, which was flagging itself done before it had actually moved anything.
function campInitScheduleScroll(root) {
  if (!root || !root.querySelectorAll) return;
  var scrollers = root.querySelectorAll('.sched-scroll');
  for (var i = 0; i < scrollers.length; i++) {
    var sc = scrollers[i];
    if (sc.getAttribute('data-init-scroll')) continue;
    // THE BUG: this runs at DOMContentLoaded, which can fire before retro.css has
    // applied (it's last in <head> with no script after it, so nothing blocks on
    // it). Until it applies there's no overflow cap, so scrollHeight ===
    // clientHeight and scrollTop silently clamps to 0 — and the old code still
    // marked it done, so nothing ever retried. Symptom: never worked on dev (CSS
    // revalidates over the network every load), worked ~half the time on prod
    // (usually cached). If it isn't scrollable yet, it isn't ready: leave the flag
    // off and let a later pass have it.
    if (sc.scrollHeight <= sc.clientHeight) continue;
    sc.setAttribute('data-init-scroll', '1');
    sc.scrollLeft = 0;
    sc.scrollTop = sc.scrollHeight; // browser clamps to the max, i.e. the bottom
  }
}
// The later passes. `load` waits for stylesheets, so by then the grid is real; the
// ResizeObserver catches the case where layout settles later still (a slow font or
// a late reflow) without polling. Both no-op once the flag is set, so neither can
// yank the grid out from under someone who has already scrolled it.
window.addEventListener('load', function () { campInitScheduleScroll(document.body); });
if (typeof ResizeObserver === 'function') {
  var campSchedRO = new ResizeObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var sc = entries[i].target;
      if (sc.getAttribute('data-init-scroll')) { campSchedRO.unobserve(sc); continue; }
      if (sc.scrollHeight > sc.clientHeight) {
        sc.setAttribute('data-init-scroll', '1');
        sc.scrollLeft = 0;
        sc.scrollTop = sc.scrollHeight;
        campSchedRO.unobserve(sc);
      }
    }
  });
  document.addEventListener('DOMContentLoaded', function () { campWatchSchedScroll(document.body); });
  document.addEventListener('htmx:afterSwap', function (e) { campWatchSchedScroll(e.target); });
}
function campWatchSchedScroll(root) {
  if (!campSchedRO || !root || !root.querySelectorAll) return;
  var scrollers = root.querySelectorAll('.sched-scroll');
  for (var i = 0; i < scrollers.length; i++) {
    if (!scrollers[i].getAttribute('data-init-scroll')) campSchedRO.observe(scrollers[i]);
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
// Pixel emoji on/off, applied to the page you're looking at so the Control Panel
// shows its own effect. Turning it OFF can't just stop wrapping — the spans are
// already in the DOM — so the pixel font is disabled from a root class; turning it
// back ON drops that class and wraps whatever landed while it was off. Same
// per-device localStorage shape as the clock and confetti prefs.
function campSetPixmoji(on) {
  try { localStorage.setItem('campPixmoji', on ? 'on' : 'off'); } catch (e) {}
  document.documentElement.classList.toggle('no-pixmoji', !on);
  if (on) pixmojify(document.body);
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
  var px = root.querySelector('#camp-pixmoji-check');
  if (px) px.checked = campPixmojiOn();
}

function campReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function campEaseInOutQuad(p) {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}
// A hand-rolled smooth scroll for a scroll CONTAINER (both axes at once) — the
// schedule grid scrolls sideways inside .sched-scroll. We don't use scrollIntoView
// ({behavior:'smooth'}) because it's a silent no-op inside htmx's afterSwap (and in
// some automation contexts) — this rAF tween runs the same everywhere. Honors
// prefers-reduced-motion by jumping straight there.
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

// NOTE: cards deliberately do NOT move between the "still need these" and "all
// covered" sections while you're on the page. Ticking something used to relocate
// its card (and scroll after it), so a few taps sent the list jumping around under
// your finger. A completed item now just sits where it is, filled bar and all, and
// lands in "all covered" on the next load. The grouping is a snapshot of when the
// page rendered — hence the two sections keep their server-rendered counts too.

document.addEventListener('DOMContentLoaded', function () { pixmojify(document.body); suppressPwManagers(document.body); campAutoOpenPledge(); campTidyUrl(); campLocalizeTimes(document.body); campInitSettings(document.body); campFillMsnToolbars(document); });
// campInitScheduleScroll is in here as well as on `load` because switching to the
// Schedule tab is now an htmx swap of #desktop, and `load` fires once per DOCUMENT
// — it will never fire again for a swap. Browsers WITH ResizeObserver are already
// covered (campWatchSchedScroll below observes the fresh grid and observe() itself
// delivers a first callback), so this is the fallback path for those without it,
// which would otherwise land on the schedule scrolled to the wrong end.
document.addEventListener('htmx:afterSwap', function (e) { pixmojify(e.target); suppressPwManagers(e.target); campLocalizeTimes(e.target); campInitSettings(e.target); campFillMsnToolbars(e.target); campResumeBars(); campInitScheduleScroll(e.target); });
// Out-of-band swaps (hx-swap-oob — the mine tab's #mine-floating, oob toasts,
// dialogs riding along into #popup-layer) fire oobAfterSwap, NOT afterSwap; without
// this hook their emoji silently lose the pixel font on every oob update.
document.addEventListener('htmx:oobAfterSwap', function (e) { pixmojify(e.target); suppressPwManagers(e.target); campLocalizeTimes(e.target); campFillMsnToolbars(e.target); });

// Make the floating XP popups draggable by their title bar. Position is tracked as
// an accumulated translate on each window (dataset.dx/dy) so repeated drags stack.
// Pressing a caption button doesn't start a drag. Document-level so it keeps working
// for windows re-rendered by HTMX swaps. The "me"-tab mini windows are deliberately
// NOT draggable: they're laid out in a two-column grid that they'd only fall out of.
(function () {
  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest) return;
    var handle = e.target.closest('.xp-popup-titlebar');
    // Never start a drag (or pointer-capture!) from an interactive element — a
    // captured pointer retargets the follow-up click to the title bar, silently
    // eating ✕ taps. Match by tag, not class, so it survives markup renames.
    if (!handle || e.target.closest('button, a, input, select, label')) return;
    var win = handle.closest('.xp-popup');
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

// Zoom the meeting-spot map. The map is OpenStreetMap's export/embed.html in a
// cross-origin iframe, so its own +/− buttons are unreachable to us — we can't
// script them, style them, or fix the one that doesn't work. What we CAN set is the
// bbox in the embed URL, so zooming = widening or narrowing that box around its own
// centre and reloading the frame. dir is +1 to zoom out, -1 to zoom in.
// Clamped either way so it can't be zoomed down to a single pixel of asphalt or out
// to the whole planet.
var CAMP_MAP_STEP = 1.8, CAMP_MAP_MIN_SPAN = 0.0009, CAMP_MAP_MAX_SPAN = 1.2;
function campMapZoom(btn, dir) {
  var pane = btn.closest('.st-map');
  var frame = pane && pane.querySelector('.st-map-frame');
  if (!frame) return;
  var url;
  try { url = new URL(frame.src); } catch (err) { return; }
  var bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some(isNaN)) return;
  // bbox is west,south,east,north — hold the centre, scale the spans.
  var cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  var f = dir > 0 ? CAMP_MAP_STEP : 1 / CAMP_MAP_STEP;
  var w = (bbox[2] - bbox[0]) * f, h = (bbox[3] - bbox[1]) * f;
  if (w < CAMP_MAP_MIN_SPAN || h < CAMP_MAP_MIN_SPAN / 1.5) return;
  if (w > CAMP_MAP_MAX_SPAN || h > CAMP_MAP_MAX_SPAN / 1.5) return;
  url.searchParams.set('bbox', [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2].join(','));
  frame.src = url.toString();
}

// Floating XP popups: remove one, remove all, and figure out the next z-index.
function popupTop() {
  var wins = document.querySelectorAll('#popup-layer .xp-popup');
  var max = 1000;
  for (var i = 0; i < wins.length; i++) { var z = parseInt(wins[i].style.zIndex || '0', 10); if (z > max) max = z; }
  return max + 1;
}
function closePopup(el) { var w = el.closest('.xp-popup'); if (w) w.remove(); }

// Backdrop click-to-dismiss for the sign-in modal — but NOT when a second window
// is open on top of it, and NOT when the user has typed something into the name or
// email field (don't throw away their input).
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

function campClearSetHints() {
  var hints = document.querySelectorAll('.sched-tile-hint');
  for (var i = 0; i < hints.length; i++) hints[i].remove();
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

// Desktop: hand a click on a resolved Spotify link straight to the installed
// app via its own spotify: URI, instead of opening the web player in a tab.
// Touch stays on the plain href — its universal-link handoff still falls back
// to the web page when the app isn't installed, a safety net the spotify: URI
// doesn't have, so touch keeps the href it already had. Shared by the
// server-rendered anchor (spotifyLink() in src/routes/schedule.js, called via
// its inline onclick) and the one campSpotifyPlay builds below.
function campSpotifyLinkClick(a, e) {
  var uri = a.getAttribute('data-spotify-uri');
  if (!uri || campIsTouch()) return true;
  e.preventDefault();
  window.location.href = uri;
  return false;
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
//  • Desktop with a spotify: URI — jump straight there via location.href once
//    the URL lands, so it hands off to the desktop app instead of a browser tab.
//    Same activation grace period as window.open, just no popup involved.
//  • Desktop, no URI (unrecognized link shape) — try window.open once the URL
//    lands. Chrome/Firefox still count the click as user activation for a few
//    seconds, so a fast search sails through.
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
          if (d.uri) {
            window.location.href = d.uri;
            opened = true;
          } else {
            opened = window.open(d.url, '_blank');
            if (opened) { try { opened.opener = null; } catch (e) {} }
          }
        } catch (e) { opened = null; }
      }
      var a = document.createElement('a');
      a.className = 'btn ' + wide + 'sched-spotify';
      a.href = d.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // Leftover link keeps handing off to the app on a later click too.
      if (d.uri) {
        a.setAttribute('data-spotify-uri', d.uri);
        a.addEventListener('click', function (e) { campSpotifyLinkClick(a, e); });
      }
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
// Fill in the emoticon palettes of any chat that's actually visible, cloning from
// the single #msn-toolbar-tpl in the page shell (see msnToolbarTemplate). Chats
// ship with an empty .msn-toolbar because a stuff page carries ~70 of them and
// building every palette up front cost thousands of nodes nobody looked at.
// Called on load, after every swap, and when a chat is opened.
function campFillMsnToolbars(root) {
  var tpl = document.getElementById('msn-toolbar-tpl');
  if (!tpl) return;
  var scope = root && root.querySelectorAll ? root : document;
  var sel = '.msn-chat.windowed, details.msn-chat[open]';
  var chats = [].slice.call(scope.querySelectorAll(sel));
  // An outerHTML swap can hand us the chat itself as the root, and querySelectorAll
  // never matches its own root — so check it directly too.
  if (scope.matches && scope.matches(sel)) chats.push(scope);
  for (var i = 0; i < chats.length; i++) {
    var bar = chats[i].querySelector('.msn-toolbar');
    if (bar && !bar.children.length) bar.appendChild(tpl.content.cloneNode(true));
  }
}
// <details> fires `toggle` and it does NOT bubble, so this listens in the capture
// phase — which still sees events on descendants — rather than missing them all.
document.addEventListener('toggle', function (e) {
  var t = e.target;
  if (t && t.classList && t.classList.contains('msn-chat') && t.open) campFillMsnToolbars(t.parentNode || document);
}, true);

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

// ——— Sign-in: pick your user name off the list, XP Welcome-screen style ————
// The fest's roster ships embedded in data-names (guard.js), so filtering is pure
// local string work — the list is up on the first keystroke, no fetch, no spinner.
// The overwhelmingly common sign-in is a regular who lost their session, and a typo
// doesn't fail loudly: it quietly opens a SECOND account. Clicking beats typing.
function campSigninNames(input) {
  var raw = input.getAttribute('data-names');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (err) { return []; }
}
function campSigninBox(input) { return input.parentElement.querySelector('.signin-suggest'); }

// Prefix matches first, then anywhere-in-the-string; capped so the list stays a
// list and not a directory. An empty box offers NOTHING — the list is an assist for
// someone already typing their name, not a roster to browse, and dropping it open
// over the form the moment the field takes focus (autofocus does that on load) put
// it in the way of people who were only ever going to type.
function campSigninMatches(names, q) {
  var v = q.trim().toLowerCase();
  if (!v) return [];
  var starts = [], contains = [];
  for (var i = 0; i < names.length; i++) {
    var low = names[i].toLowerCase();
    if (low.indexOf(v) === 0) starts.push(names[i]);
    else if (low.indexOf(v) > -1) contains.push(names[i]);
  }
  return starts.concat(contains).slice(0, 8);
}

function campSigninRender(input) {
  var box = campSigninBox(input);
  if (!box) return;
  var typed = input.value.trim();
  var matches = campSigninMatches(campSigninNames(input), input.value);
  // Nothing to offer once they've typed the whole name — the list would just be
  // covering the field with what's already in it.
  var exact = matches.length === 1 && matches[0].toLowerCase() === typed.toLowerCase();
  if (!matches.length || exact) { box.hidden = true; box.innerHTML = ''; return; }
  // Last row is what they've actually typed, with a trailing "…" — otherwise a list
  // of other people's names reads as a closed menu you have to pick from, and a
  // newcomer whose name happens to share letters with a regular's can't tell that
  // just carrying on typing is allowed. Picking it keeps exactly what's in the box.
  var picks = matches.slice();
  var labels = matches.slice();
  picks.push(typed);
  labels.push(typed + '…');
  var out = '';
  for (var i = 0; i < picks.length; i++) {
    out += '<button type="button" class="signin-suggest-row' + (i === matches.length ? ' signin-suggest-new' : '') + '" tabindex="-1">'
      + '<img src="/xp/cp-accounts.png" alt="" class="signin-suggest-ico">'
      + '<span class="signin-suggest-name"></span></button>';
  }
  box.innerHTML = out;
  // Names go in as TEXT, never as markup — a display_name is user-supplied, and so
  // is the typed row. The value a row applies is carried separately from its label,
  // since the "…" is decoration and must not end up in the field.
  var rows = box.querySelectorAll('.signin-suggest-row');
  for (var j = 0; j < rows.length; j++) {
    rows[j].setAttribute('data-value', picks[j]);
    rows[j].querySelector('.signin-suggest-name').textContent = labels[j];
  }
  box.hidden = false;
}

function campSigninHide(input) {
  var box = campSigninBox(input);
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

function campSigninPick(input, name) {
  input.value = name;
  campSigninHide(input);
  input.focus();
}

// Open the list when the field is focused, even empty — that's the whole point.
document.addEventListener('focusin', function (e) {
  if (!e.target.classList || !e.target.classList.contains('signin-name-input')) return;
  campSigninRender(e.target);
});
// mousedown, not click: the row is a button, so focusing it would blur the input
// and close the list out from under the click.
document.addEventListener('mousedown', function (e) {
  if (!e.target.closest) return;
  var row = e.target.closest('.signin-suggest-row');
  if (row) {
    e.preventDefault();
    campSigninPick(row.closest('.signin-namebox').querySelector('.signin-name-input'),
      row.getAttribute('data-value'));
    return;
  }
  // A click anywhere else dismisses an open list.
  var open = document.querySelectorAll('.signin-suggest:not([hidden])');
  for (var i = 0; i < open.length; i++) {
    if (e.target.closest('.signin-namebox') === open[i].parentElement) continue;
    campSigninHide(open[i].parentElement.querySelector('.signin-name-input'));
  }
});
// Keyboard: ↓/↑ walk the list, Enter takes the highlighted row (and must NOT submit
// the form on that press), Escape closes it and leaves what they typed alone.
document.addEventListener('keydown', function (e) {
  if (!e.target.classList || !e.target.classList.contains('signin-name-input')) return;
  var input = e.target;
  var box = campSigninBox(input);
  if (!box || box.hidden) {
    if (e.key === 'ArrowDown') { campSigninRender(input); e.preventDefault(); }
    return;
  }
  var rows = box.querySelectorAll('.signin-suggest-row');
  if (!rows.length) return;
  var cur = -1;
  for (var i = 0; i < rows.length; i++) if (rows[i].classList.contains('active')) cur = i;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    var next = e.key === 'ArrowDown' ? cur + 1 : cur - 1;
    if (next < 0) next = rows.length - 1;
    if (next >= rows.length) next = 0;
    for (var j = 0; j < rows.length; j++) rows[j].classList.toggle('active', j === next);
  } else if (e.key === 'Enter' && cur > -1) {
    e.preventDefault();
    campSigninPick(input, rows[cur].getAttribute('data-value'));
  } else if (e.key === 'Escape') {
    campSigninHide(input);
  }
});

document.addEventListener('input', function (e) {
  if (!e.target.classList || !e.target.classList.contains('signin-name-input')) return;
  campSigninRender(e.target);
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
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { campCloseStart(); campCollapseSetTiles(null); campToggleDog(false); } });

// The little tray clock. No seconds, and it follows the 12h/24h preference
// from the control panel (XP default: 12-hour).
function campTickClock() {
  var el = document.getElementById('xp-clock');
  if (!el) return;
  el.textContent = campFmtClock(new Date());
}
document.addEventListener('DOMContentLoaded', campTickClock);
setInterval(campTickClock, 15000);

// ——— Rover, bottom right. Click = read his message. ————————————————————
// He only renders when there's something outstanding, and his balloon starts
// collapsed, so the click both opens it and (still) counts as a pet: TEN quick
// ones in a row are an authentic XP Stop error. Any key, click, or tap brings the
// site back — no harm done, exactly like the real thing except the opposite.
var DOG_PETS_TO_BSOD = 10;
function campToggleDog(open) {
  var wrap = document.getElementById('dog-assistant');
  if (!wrap) return;
  var want = open === undefined ? !wrap.classList.contains('open') : !!open;
  wrap.classList.toggle('open', want);
  var btn = wrap.querySelector('.dog-btn');
  if (btn) btn.setAttribute('aria-expanded', want ? 'true' : 'false');
}
var dogPets = 0, dogPetTimer = null;
document.addEventListener('click', function (e) {
  var btn = e.target.closest && e.target.closest('.dog-btn');
  if (!btn) return;
  campToggleDog();
  clearTimeout(dogPetTimer);
  dogPets++;
  if (dogPets >= DOG_PETS_TO_BSOD) { dogPets = 0; campBsod(); return; }
  dogPetTimer = setTimeout(function () { dogPets = 0; }, 1600);
});

// ——— Rover leaves on foot ——————————————————————————————————————————————
// Ticking off the last thing he was nagging about deletes him from the server's
// answer, so the #dog-slot OOB swap simply blinked him out of existence. Now he
// hops off to the right and over the edge of the screen instead. Un-tick the box and
// he turns around and hops home — never in mid-air, and never mid-sit: he lands,
// sits out his 250ms, and only then goes back the way he came, so a turn looks like
// a decision he made rather than a rewind. The whole trip is ONE Web Animation on
// ONE element and turning around is just a playback-rate flip, so he picks up from
// exactly where he is; the only state a turn needs is which hop he's on, and the
// animation is already holding it. Toggle as fast as you like: there is never a
// second dog on screen, and never a jump cut. The element he flies with is the SAME
// element that was in the slot (moved to <body> before the swap can destroy it) — a
// clone would have to be reconciled with the server's markup later, and a reversal
// would have nothing to reverse.
var DOG_HOP_MS = 200;                       // one hop, through the air
var DOG_LAND_MS = 250;                      // ...then he sits there this long
var DOG_HOP_STOPS = [0.18, 0.38, 0.6, 1];   // where each of the four hops lands
var DOG_HOP_SAMPLES = 8;                    // points plotted along each arc
var DOG_SHRINK_MS = 160;                    // matches dog-unpop in retro.css
// At most one trip is ever in progress: { el, anim, ground, total, want (the
// direction he's been ASKED for), closeTimer (balloon still folding), turnTimer
// (a turn waiting on him to land) }.
var dogFly = null;
var dogArriving = false;                    // a dog is landing in the slot this swap

// The path, in the dog's own local pixels: four arcs to the right with a sit-down
// between them, the last one carrying him clear of the screen. Measured at takeoff
// rather than hard-coded, so a phone's smaller dog and a rotated window both get a
// trip that actually ends off-screen.
function campDogFlightPath(el) {
  var r = el.getBoundingClientRect();
  // Far enough right that every pixel of him — plus his drop shadow — is past the edge.
  var dist = (window.innerWidth - r.right) + r.width + 16;
  var last = DOG_HOP_STOPS.length - 1;
  var total = DOG_HOP_STOPS.length * DOG_HOP_MS + last * DOG_LAND_MS;
  // Every stretch of the trip where his feet are down, as [start, end] on the same
  // clock: the dock he starts on, the three sit-downs, and the spot off the edge he
  // ends on. Turning around is only allowed inside one of these.
  var ground = [[0, 0]];
  var frames = [], t = 0, from = 0;
  for (var h = 0; h <= last; h++) {
    var to = DOG_HOP_STOPS[h] * dist;
    var apex = h === last ? 38 : 26;        // the hop that has to clear the edge jumps highest
    for (var s = 0; s <= DOG_HOP_SAMPLES; s++) {
      var u = s / DOG_HOP_SAMPLES;
      // x is linear in time, y is a parabola over it: constant forward speed with
      // gravity on the vertical. Plotted as frames rather than eased because an
      // easing curve bends both axes together, and only one of them should bend.
      frames.push({
        offset: (t + u * DOG_HOP_MS) / total,
        transform: 'translate(' + (from + (to - from) * u).toFixed(2) + 'px,' +
          (-apex * 4 * u * (1 - u)).toFixed(2) + 'px)'
      });
    }
    var landed = t + DOG_HOP_MS;
    t = landed;
    if (h < last) { t += DOG_LAND_MS; frames.push({ offset: t / total, transform: 'translate(' + to.toFixed(2) + 'px,0px)' }); }
    ground.push([landed, t]);
    from = to;
  }
  return { frames: frames, total: total, ground: ground };
}

// When he may turn round, given where he is (`t`) and which way he's going: at the
// FAR end of the sit-down he's in — or of the one he's about to land in. So a turn
// asked for in mid-hop lands him first, and one asked for while he's sat down lets
// him finish sitting. Either way he sits exactly one full DOG_LAND_MS and then goes
// back, rather than cutting the sit short or doing it twice.
//   .at   — the moment the sit is over and he's free to go
//   .back — the other end of that same sit, where his clock is moved to when he does.
//           The two ends are the same PLACE (he's sat still between them), so moving
//           the clock across is invisible, and it's what stops the sit playing twice.
function campDogTurnGate(ground, t, rate) {
  var pick = null, i, edge;
  for (i = 0; i < ground.length; i++) {
    edge = rate > 0 ? ground[i][1] : ground[i][0];
    if (rate > 0 ? edge < t - 1 : edge > t + 1) continue;
    if (!pick || (rate > 0 ? edge < pick.at : edge > pick.at)) {
      pick = { at: edge, back: rate > 0 ? ground[i][0] : ground[i][1] };
    }
  }
  return pick;
}

// The one entry point: rate > 0 sends him for the edge, rate < 0 brings him home.
// The animation is built once per flight and then only ever has its playback rate
// flipped, which is the whole trick — a flip keeps his exact position and the hop
// he's on. Turning is gated on a SIT, though (campDogTurnGate): ask for one while
// he's in the air and he finishes the arc; ask while he's sat down and he finishes
// sitting. He is never yanked backwards out of mid-air, and never sits twice.
function campDogGo(rate) {
  var f = dogFly;
  if (!f) return;
  f.want = rate;
  if (f.turnTimer) { clearTimeout(f.turnTimer); f.turnTimer = null; }
  if (f.closeTimer) {
    // Still folding the balloon away, so he hasn't moved a pixel yet.
    if (rate > 0) return;                              // ...which is already the plan
    clearTimeout(f.closeTimer); f.closeTimer = null;
    f.el.classList.remove('closing');
    campDogSettle();                                   // never launched: he just stays
    return;
  }
  if (!f.anim) {
    var path = campDogFlightPath(f.el);
    f.anim = f.el.animate(path.frames, { duration: path.total, fill: 'both' });
    f.anim.onfinish = campDogLanded;
    f.ground = path.ground;
    f.total = path.total;
    if (rate < 0) f.anim.currentTime = path.total;     // arriving: start him off-screen
    f.anim.playbackRate = rate;
    f.anim.play();
    return;
  }
  if (f.anim.playbackRate === rate) return;            // already going that way
  var t = f.anim.currentTime;
  var gate = campDogTurnGate(f.ground, t, f.anim.playbackRate);
  if (!gate) return;                                   // nothing ahead; onfinish has it
  if (Math.abs(gate.at - t) < 1) { campDogTurn(f, rate, gate.back); return; }
  // He finishes the hop he's on and the sit at the end of it first. `want` is already
  // recorded, so if the clock runs out before the gate (the leap over the edge, or the
  // hop into the dock) the finish handler turns him instead of putting him away.
  f.turnTimer = setTimeout(function () { campDogTurn(f, rate, gate.back); }, Math.abs(gate.at - t));
}

// He's done sitting: send him the other way. The clock moves to the far side of the
// sit he just finished, which is the same PLACE he's already standing in — so this is
// seamless, and the sit doesn't replay on the way back.
function campDogTurn(f, rate, back) {
  if (dogFly !== f) return;
  if (f.turnTimer) { clearTimeout(f.turnTimer); f.turnTimer = null; }
  // The two ends of the whole trip are ground as well, and there's nothing to play out
  // from them — he's simply arrived. (play() at either end, with the rate pointing off
  // the end of the timeline, makes WAAPI seek to the OTHER end, which would teleport
  // him the width of the screen.)
  if (rate < 0 && back <= 0) { campDogSettle(); return; }
  if (rate > 0 && back >= f.total) { campDogVanish(); return; }
  f.anim.currentTime = back;
  f.anim.playbackRate = rate;
  f.anim.play();
}

// The clock ran out at one end of the trip or the other.
function campDogLanded() {
  var f = dogFly;
  if (!f) return;
  // A turn was asked for while he was in the air and the air has now run out: he's
  // standing on something (the far side of the edge, or his own dock), so he may turn.
  if (f.anim && f.want && (f.want > 0) !== (f.anim.playbackRate > 0)) {
    if (f.turnTimer) { clearTimeout(f.turnTimer); f.turnTimer = null; }
    f.anim.playbackRate = f.want;
    f.anim.play();
    return;
  }
  if (f.anim && f.anim.playbackRate > 0) campDogVanish(); else campDogSettle();
}

// Home. Back into the slot he came out of, so the next OOB swap can replace him
// normally and the click handlers find him by id again.
function campDogSettle() {
  var f = campDogEndFlight();
  if (!f) return;
  f.el.classList.remove('hopping');
  f.el.id = 'dog-assistant';
  var slot = document.getElementById('dog-slot');
  if (slot) slot.appendChild(f.el); else f.el.remove();
}

// Gone: off the edge for good, or dropped mid-trip so the server's markup can stand
// (reduced motion, no Web Animations).
function campDogVanish() {
  var f = campDogEndFlight();
  if (f) f.el.remove();
}

function campDogEndFlight() {
  var f = dogFly;
  if (!f) return null;
  dogFly = null;
  clearTimeout(f.closeTimer);
  clearTimeout(f.turnTimer);
  if (f.anim) { f.anim.onfinish = null; f.anim.cancel(); }
  return f;
}

function campDogDepart(el) {
  document.body.appendChild(el);            // out of the slot before the swap eats it
  el.removeAttribute('id');                 // the slot may hold a dog again before he lands
  el.classList.add('hopping');
  var f = dogFly = { el: el, anim: null, ground: null, total: 0, closeTimer: null, turnTimer: null, want: 1 };
  if (!el.classList.contains('open')) { campDogGo(1); return; }
  // He can't hop off mid-sentence: the balloon shrinks back into his head first,
  // the same four steps it grew in, and then he goes.
  el.classList.remove('open');
  el.classList.add('closing');
  var btn = el.querySelector('.dog-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  f.closeTimer = setTimeout(function () {
    if (dogFly !== f) return;
    f.closeTimer = null;
    el.classList.remove('closing');
    campDogGo(1);
  }, DOG_SHRINK_MS);
}

// A desktop tab response starts swapping #desktop before htmx processes its OOB
// #dog-slot. Start the schedule nag's trip at that first, authoritative swap event
// so clicking the Schedule desktop icon cannot let the later empty-slot swap blink
// Rover out first. This is deliberately keyed to both the response path and the
// nag: a pass reminder remains on Schedule, and a failed request never gets here.
document.addEventListener('htmx:beforeSwap', function (e) {
  var d = e.detail;
  if (!d || !d.shouldSwap || !d.target || d.target.id !== 'desktop') return;
  var path = d.pathInfo && (d.pathInfo.finalRequestPath || d.pathInfo.requestPath || d.pathInfo.responsePath);
  if (!/^\/f\/\d+\/schedule(?:[/?#]|$)/.test(path || '')) return;
  var parked = document.querySelector('#dog-slot .dog-assistant[data-dog-nag="schedule"]');
  if (!parked || dogFly || campReducedMotion() || typeof parked.animate !== 'function') return;
  campDogDepart(parked);
});

// Every #dog-slot swap boils down to "he should be here" or "he shouldn't"; this
// turns that into a direction of travel. Tab switches count: they swap #desktop and
// re-send the slot with it, and the "you haven't picked any sets" nag is silenced ON
// the schedule tab — so opening Schedule sends him hopping off, and leaving it hops
// him back in. That works because he flies from <body>, outside the swapped #desktop.
document.addEventListener('htmx:oobBeforeSwap', function (e) {
  var d = e.detail;
  if (!d || !d.target || d.target.id !== 'dog-slot' || !d.fragment || !d.fragment.querySelector) return;
  dogArriving = false;
  var incoming = d.fragment.querySelector('.dog-assistant');
  var parked = document.querySelector('#dog-slot .dog-assistant');
  if (campReducedMotion() || !document.body.animate) { campDogVanish(); return; }

  if (incoming && dogFly) {
    // Wanted back while he's still out there: turn HIM around instead of landing a
    // second dog in the slot. The freshest words win, though — what he's nagging
    // about can change while he's away (pass ticked, then a car posted).
    var said = incoming.querySelector('.dog-bubble'), his = dogFly.el.querySelector('.dog-bubble');
    if (said && his) his.innerHTML = said.innerHTML;
    incoming.remove();
    campDogGo(-1);
  } else if (incoming && !parked) {
    dogArriving = true;                     // the element doesn't exist yet — see below
  } else if (!incoming && parked) {
    campDogDepart(parked);
  } else if (!incoming && dogFly) {
    campDogGo(1);                           // he was heading home; send him back out
  }
});

// A dog who wasn't on screen at all arrives the same way he left, in reverse. He
// only exists once the swap has run, so this half waits for it.
document.addEventListener('htmx:oobAfterSwap', function (e) {
  if (!dogArriving || !e.detail || !e.detail.target || e.detail.target.id !== 'dog-slot') return;
  dogArriving = false;
  var el = document.querySelector('#dog-slot .dog-assistant');
  if (!el) return;
  el.removeAttribute('id');
  el.classList.add('hopping');
  document.body.appendChild(el);
  dogFly = { el: el, anim: null, ground: null, total: 0, closeTimer: null, turnTimer: null, want: -1 };
  campDogGo(-1);
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
    // Second parameter is the pet count that did it, in hex, like a real bugcheck.
    '*** STOP: 0x0000D06E (0xC0FFEE00, 0x0000000A, 0x0BADD06E, 0x00000000)',
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
