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

document.addEventListener('DOMContentLoaded', function () { pixmojify(document.body); suppressPwManagers(document.body); campAutoOpenPledge(); campLocalizeTimes(document.body); campInitSettings(document.body); });
document.addEventListener('htmx:afterSwap', function (e) { pixmojify(e.target); suppressPwManagers(e.target); campLocalizeTimes(e.target); campInitSettings(e.target); });

// Make the little "me"-tab XP windows draggable by their title bar. Position is
// tracked as an accumulated translate on each window (dataset.dx/dy) so repeated
// drags stack. Pressing a caption button doesn't start a drag. Document-level so it
// keeps working for windows re-rendered by HTMX swaps.
(function () {
  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest) return;
    var handle = e.target.closest('.xp-mini-titlebar, .xp-popup-titlebar');
    if (!handle || e.target.closest('.xp-tb-btn, .xp-popup-close')) return;
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
  } else {
    go.textContent = 'Delete Selected'; go.disabled = n < 1;
    hint.textContent = 'Select the campers you want to remove (this can be undone) — ' + n + ' selected.';
  }
}
document.addEventListener('change', function (e) {
  if (!e.target.classList || !e.target.classList.contains('ppl-select-check')) return;
  var bar = campSelBar();
  if (bar && bar.getAttribute('data-mode') === 'merge' && campSelChecked().length > 2) { e.target.checked = false; return; }
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
  if (!cb.checked && bar && bar.getAttribute('data-mode') === 'merge' && campSelChecked().length >= 2) return;
  cb.checked = !cb.checked;
  campUpdateSelect();
});
function campRunSelect(go) {
  var bar = campSelBar(); if (!bar) return;
  var mode = bar.getAttribute('data-mode'), fest = bar.getAttribute('data-fest');
  var checked = campSelChecked();
  var ids = checked.map(function (c) { return c.value; });
  if (mode === 'merge') {
    if (ids.length !== 2) return;
    var names = checked.map(function (c) { return c.getAttribute('data-name'); });
    if (!confirm('Are you sure you want to merge ' + names.join(' and ') + '? Everything they brought, pledged, and said will be combined into one camper. (The real, signed-in account wins.)')) return;
    htmx.ajax('POST', '/f/' + fest + '/people/merge', { target: '#main', swap: 'innerHTML', values: { person_ids: ids.join(',') } });
  } else {
    if (!ids.length) return;
    if (!confirm('Are you sure you want to remove ' + ids.length + ' ' + (ids.length === 1 ? 'person' : 'people') + '? This action can be undone from the log tab, which restores everything they did.')) return;
    htmx.ajax('POST', '/f/' + fest + '/people/delete', { target: '#main', swap: 'innerHTML', values: { person_ids: ids.join(',') } });
  }
}

// MSN emoticon toolbar: append the typed emoticon into the chat's compose box.
function msnEmote(el, txt) {
  var chat = el.closest('.msn-chat');
  var input = chat && chat.querySelector('input[name=body]');
  if (input) { input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + txt; input.focus(); }
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
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') campCloseStart(); });

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