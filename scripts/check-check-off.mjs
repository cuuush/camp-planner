// Checks the item card's "Check Off for Someone Else" control — the one place on a
// Stuff card that records a pledge for somebody who isn't you — against the rules
// it's supposed to follow:
//   • every card carries the button, signed in AND out, and it opens the window
//   • signed out, the window route pops the sign-in modal instead (HX-Retarget)
//   • the window lists the whole roster EXCEPT you, ticked exactly where the card's
//     own tally says that person is down for some of it
//   • a ticked row posts qty 0 (unticking never asks), an unticked one takes the
//     window's Quantity box, and every row hands back expanded + chat_open so the
//     swap can't collapse the card (gotcha 17)
//   • the round trip really writes: the card comes back with the name in its tally,
//     the window's list rides along out-of-band with the row now ticked, the log
//     line says who marked it, and the entry undoes cleanly
//   • a person_id that isn't on this fest's roster is refused
// Mutations are made and then put back, so this leaves the DB as it found it.
// Usage: node scripts/check-check-off.mjs [festivalId] [cookie]
const fest = process.argv[2] || '1';
const cookie = process.argv[3] || '';
const base = 'http://localhost:8787';

const bad = [];
const fail = (msg) => bad.push(msg);
const done = () => {
    console.log(bad.length ? `FAIL:\n  ${bad.join('\n  ')}` : 'OK — the check-off control matches the rules');
    process.exit(bad.length ? 1 : 0);
};

const get = (path, auth = true) => fetch(base + path, auth && cookie ? { headers: { cookie } } : undefined);
const post = (path, params) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(params).toString(),
});

// One card's markup, sliced out the same way check-stuff-controls does it: from its
// id up to wherever the next card or section starts. Also has to stop at the
// out-of-band list and at the end of the string, because half of what's parsed here
// is a one-card htmx fragment rather than the whole page.
const cardsOf = (h) => new Map([...h.matchAll(/id="item-(\d+)"([\s\S]*?)(?=<div class="card item-card|<div class="stuff-section|<div id="check-off-list-|<\/main>|$)/g)]
    .map(([, id, seg]) => [id, seg]));
// "2/4 chairs - Cush (2), lejf" -> the names only.
const tallyNames = (seg) => {
    const m = seg.match(/class="item-tally">\s*(\d+)\/(\d+)[^<]*/);
    if (!m) return null;
    const rest = m[0].split(' - ')[1];
    return rest ? rest.split(',').map((s) => s.replace(/\s*\(\d+\)\s*$/, '').trim()).filter(Boolean) : [];
};
const pledgedOf = (seg) => {
    const m = seg.match(/class="item-tally">\s*(\d+)\/(\d+)/);
    return m ? { pledged: +m[1], needed: +m[2] } : null;
};
const rowsOf = (h) => [...h.matchAll(/<button type="button" class="pick-row check-off-row"[\s\S]*?<\/button>/g)].map((m) => m[0]);
const rowName = (row) => (row.match(/class="pick-name">([^<]*)/) || [, ''])[1].trim();
const rowChecked = (row) => row.includes('aria-checked="true"');

// --- signed out: the button ships, and the window asks you to log on -------------

const anon = await (await get(`/f/${fest}/stuff`, false)).text();
const anonCards = cardsOf(anon);
if (!anonCards.size) fail('signed out: no item cards on the stuff page at all');
for (const [id, seg] of anonCards) {
    const btn = (seg.match(/<button type="button" class="btn check-off-btn"[\s\S]*?<\/button>/) || [null])[0];
    if (!btn) { fail(`item ${id}: no check-off button (signed out)`); continue; }
    if (!btn.includes(`hx-get="/items/${id}/check-off-window"`)) fail(`item ${id}: check-off button doesn't open its own window`);
    if (!btn.includes('hx-target="#popup-layer"') || !btn.includes('hx-swap="beforeend"')) fail(`item ${id}: check-off button doesn't open into the popup layer`);
}

const firstId = [...anonCards.keys()][0];
const anonWin = await get(`/items/${firstId}/check-off-window`, false);
const anonWinBody = await anonWin.text();
if (anonWin.headers.get('hx-retarget') !== '#signin-modal-overlay') fail('signed out: the check-off window does not retarget to the sign-in modal');
if (!/Log On to /.test(anonWinBody)) fail('signed out: the check-off window is not the sign-in form');
if (/pick-row check-off-row/.test(anonWinBody)) fail('signed out: the check-off window leaked the roster');

if (!cookie) {
    console.log(`${anonCards.size} cards checked signed out — pass a cookie as argv[3] for the signed-in half`);
    done();
}

// --- signed in: the window's list agrees with the card ---------------------------

const page = await (await get(`/f/${fest}/stuff`)).text();
const cards = cardsOf(page);
const me = (page.match(/class="xp-startmenu-name">([^<]*)/) || [, ''])[1].trim();
if (!me) fail('signed in: could not read the signed-in name off the page (bad cookie?)');

const ppl = await (await get(`/f/${fest}/ppl`)).text();
const roster = [...ppl.matchAll(/class="ppl-name">([^<]*)/g)].map((m) => m[1].trim());
if (roster.length < 2) fail(`this fest has ${roster.length} people on it — not enough to check anything`);

for (const [id, seg] of cards) {
    if (!/<button type="button" class="btn check-off-btn"/.test(seg)) fail(`item ${id}: no check-off button (signed in)`);
}

// Sample the first few cards rather than opening 80 windows: the markup is one
// template, so a handful proves it, and the page-wide button check above is what
// actually needs to be exhaustive.
const sample = [...cards.keys()].slice(0, 5);
for (const id of sample) {
    const win = await (await get(`/items/${id}/check-off-window`)).text();
    const rows = rowsOf(win);
    const names = rows.map(rowName);
    if (names.includes(me)) fail(`item ${id}: the window offers to check the item off for yourself (${me})`);
    const missing = roster.filter((n) => n !== me && !names.includes(n));
    if (missing.length) fail(`item ${id}: window is missing ${missing.join(', ')}`);
    if (!win.includes(`id="check-off-list-${id}"`)) fail(`item ${id}: window has no swappable list wrapper`);

    const stats = pledgedOf(cards.get(id));
    const hasQtyBox = win.includes(`id="check-off-qty-${id}"`);
    if (hasQtyBox !== stats.needed > 1) fail(`item ${id}: quantity box ${hasQtyBox ? 'shown' : 'missing'} on an item needing ${stats.needed}`);

    // Ticked in the window <=> named in the card's tally. Two independent renders of
    // the same fact, so a drift in either one shows up here.
    const down = (tallyNames(cards.get(id)) || []).filter((n) => n !== me);
    for (const row of rows) {
        const n = rowName(row);
        const checked = rowChecked(row);
        if (checked !== down.includes(n)) fail(`item ${id}: ${n} is ${checked ? 'ticked' : 'unticked'} in the window but ${down.includes(n) ? 'is' : 'is not'} in the card's tally`);
        if (!row.includes(`hx-target="#item-${id}"`) || !row.includes('hx-swap="outerHTML"')) fail(`item ${id}: ${n}'s row doesn't swap the card`);
        for (const attr of ['expanded:', 'chat_open:']) {
            if (!row.includes(attr)) fail(`item ${id}: ${n}'s row drops ${attr.slice(0, -1)} state`);
        }
        if (checked && !/qty: 0\b/.test(row)) fail(`item ${id}: ${n} is ticked but their row doesn't untick (qty 0)`);
        if (!checked && !row.includes(`qty: campCheckOffQty(${id})`)) fail(`item ${id}: ${n}'s row doesn't take the window's quantity`);
    }
}

// --- the round trip: check someone off, put it back ------------------------------

// An item that still needs something, and someone on the roster not already down
// for it, so the write is a plain new pledge either way.
const target = [...cards].find(([, seg]) => {
    const s = pledgedOf(seg);
    return s && s.pledged < s.needed;
}) || [...cards][0];
const [tid, tseg] = target;
const before = pledgedOf(tseg);
const beforeNames = tallyNames(tseg) || [];
const victim = roster.find((n) => n !== me && !beforeNames.includes(n));
if (!victim) fail('everyone on the roster is already down for the test item — nothing to check off');

if (victim) {
    const winBefore = await (await get(`/items/${tid}/check-off-window`)).text();
    const victimId = (rowsOf(winBefore).find((r) => rowName(r) === victim) || '').match(/person_id: (\d+)/);
    if (!victimId) fail(`could not find ${victim}'s row in item ${tid}'s window`);

    const pid = victimId && victimId[1];
    const after = await (await post(`/items/${tid}/pledge`, { person_id: pid, qty: '1', expanded: '1', chat_open: '0' })).text();
    const afterCard = cardsOf(after).get(tid);
    if (!afterCard) fail('checking off for someone did not return the item card');
    else {
        if (!(tallyNames(afterCard) || []).includes(victim)) fail(`${victim} was checked off but isn't in the card's tally`);
        if (pledgedOf(afterCard).pledged !== before.pledged + 1) fail(`checking off 1 for ${victim} moved the total from ${before.pledged} to ${pledgedOf(afterCard).pledged}`);
        if (!afterCard.includes('<details class="item-details" open')) fail('checking someone off collapsed the card it was opened from');
    }
    if (!after.includes(`id="check-off-list-${tid}" hx-swap-oob="innerHTML"`)) fail('the window\'s list did not ride back out-of-band, so it would show stale ticks');
    const afterRow = rowsOf(after).find((r) => rowName(r) === victim);
    if (!afterRow || !rowChecked(afterRow)) fail(`${victim}'s row did not come back ticked`);

    // The log has to name BOTH people: whose pledge it is, and who marked it.
    const logHtml = await (await get(`/f/${fest}/log`)).text();
    const entry = (logHtml.match(/<td class="log-what">([\s\S]*?)<\/td>/) || [, ''])[1];
    if (!entry.includes(victim) || !entry.includes(`(marked by ${me})`)) fail(`the log's newest line doesn't read as "${victim} … (marked by ${me})": ${entry.trim().slice(0, 120)}`);
    const undoId = (logHtml.match(/hx-post="\/f\/\d+\/log\/(\d+)\/undo"/) || [, ''])[1];
    if (!undoId) fail('checking someone off did not leave an undoable log entry');

    // Refusing a stranger: an id that isn't on this fest's roster writes nothing.
    const forged = await (await post(`/items/${tid}/pledge`, { person_id: '999999', qty: '2', expanded: '1', chat_open: '0' })).text();
    const forgedCard = cardsOf(forged).get(tid);
    if (forgedCard && pledgedOf(forgedCard).pledged !== before.pledged + 1) fail('a person_id that is not on the roster was allowed to pledge');

    // Undo puts it back, exactly like every other mutation in the app.
    if (undoId) {
        await post(`/f/${fest}/log/${undoId}/undo`, {});
        const restored = cardsOf(await (await get(`/f/${fest}/stuff`)).text()).get(tid);
        if ((tallyNames(restored) || []).includes(victim)) fail(`undo did not take ${victim} back off the item`);
        if (pledgedOf(restored).pledged !== before.pledged) fail(`undo left the total at ${pledgedOf(restored).pledged}, not ${before.pledged}`);
    }
}

console.log(`${anonCards.size} cards checked signed out, ${cards.size} signed in as ${me}; `
    + `${sample.length} windows opened against a roster of ${roster.length}; round trip on item ${tid}`);
done();
