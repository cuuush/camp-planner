// Checks the Stuff tab's per-card controls against the rules they're supposed to
// follow, for every card on the page at once:
//   • a covered item keeps an empty overage check box hidden until its card opens
//   • ticked only when YOU are down for some of it
//   • tapping asks "how many" when more than one is left, or when adding an overage
//   • a dialog-opening check box always has its modal, and no unreachable modals ship
//   • like/check controls hand back expanded + chat_open so a tap can't collapse the card
//   • every card carries one "check off for someone else" button, and no card ships
//     the roster it picks from
// The window behind that button, and what it writes, is scripts/check-check-off.mjs.
// Usage: node scripts/check-stuff-controls.mjs [festivalId] [cookie]
const fest = process.argv[2] || '1';
const cookie = process.argv[3] || '';
const h = await (await fetch(`http://localhost:8787/f/${fest}/stuff`, cookie ? { headers: { cookie } } : undefined)).text();

const cards = [...h.matchAll(/id="item-(\d+)"([\s\S]*?)(?=<div class="card item-card|<div class="stuff-section|<\/main>)/g)];
const bad = [];
const tally = { dialog: 0, post: 0, none: 0, ticked: 0, signin: 0, checkOff: 0 };

for (const [, id, seg] of cards) {
    const t = seg.match(/class="item-tally">\s*(\d+)\/(\d+)/);
    if (!t) continue;
    const [pledged, needed] = [+t[1], +t[2]];
    const remaining = Math.max(1, needed - pledged); // mirrors itemRow()
    // The class list is built conditionally (pledge-check-overage), so it may carry
    // a second class or a trailing space. Matching class="pledge-check" exactly used
    // to find NOTHING and report every card as having no check box at all.
    const btn = (seg.match(/<button type="button" class="pledge-check[^"]*"[\s\S]*?<\/button>/) || [null])[0];
    const hasModal = seg.includes(`id="pledge-modal-${id}"`);
    const ticked = !!btn && btn.includes('xp-checkbox checked');
    const opensDialog = !!btn && btn.includes('campOpenPledge');
    const overage = !!btn && btn.includes('pledge-check-overage');
    if (ticked) tally.ticked++;
    if (overage && pledged < needed) bad.push(`item ${id}: overage box shown before the item is covered`);
    if (overage && ticked) bad.push(`item ${id}: overage box is unexpectedly ticked`);
    if (pledged >= needed && !ticked && !overage) bad.push(`item ${id}: covered item has no overage box`);

    if (!btn) {
        tally.none++;
        if (pledged < needed) bad.push(`item ${id}: no check box but only ${pledged}/${needed} covered`);
        if (hasModal) bad.push(`item ${id}: unreachable modal shipped (no check box)`);
    } else if (btn.includes('/signin/modal')) {
        // Signed out: the box asks you to sign in, and the flow resumes on the
        // reloaded page — so it carries no qty and needs no dialog of its own.
        tally.signin++;
        if (hasModal) bad.push(`item ${id}: unreachable modal shipped (signed out)`);
        if (ticked) bad.push(`item ${id}: ticked box for a signed-out visitor`);
    } else if (opensDialog) {
        tally.dialog++;
        if (!hasModal) bad.push(`item ${id}: check box opens a dialog that isn't in the DOM`);
        if (overage && !seg.includes('Specify Additional Quantity')) bad.push(`item ${id}: overage dialog has the wrong prompt`);
        // Ticked means the dialog is there to let you bring your own pledge down, so
        // it's only warranted when that pledge is worth more than one. Your share is
        // the tally's total minus what the dialog says everyone else has pledged.
        const others = +(seg.match(/data-others="(-?\d+)"/) || [])[1];
        const mine = pledged - others;
        if (ticked && !(mine > 1)) bad.push(`item ${id}: asks when unticking a pledge of ${mine}`);
        if (!ticked && !overage && remaining <= 1) bad.push(`item ${id}: asks "how many" with only ${remaining} left to cover`);
    } else {
        tally.post++;
        if (hasModal) bad.push(`item ${id}: unreachable modal shipped (check box posts directly)`);
        const qty = (btn.match(/qty: (-?\d+)/) || [])[1];
        if (ticked && qty !== '0') bad.push(`item ${id}: ticked box should untick (qty 0), sends ${qty}`);
        if (!ticked && remaining > 1) bad.push(`item ${id}: ${remaining} left to cover but the box doesn't ask`);
        if (!ticked && qty !== String(remaining)) bad.push(`item ${id}: should pledge the ${remaining} outstanding, sends ${qty}`);
    }
    for (const attr of ['expanded:', 'chat_open:']) {
        if (btn && btn.includes('hx-post') && !btn.includes(attr)) bad.push(`item ${id}: check box drops ${attr.slice(0, -1)} state`);
    }

    // "Check Off for Someone Else…" — one per card, signed in or out (signed out it
    // still opens; the window route is what pops the sign-in modal). The roster it
    // picks from is deliberately NOT drawn into the card: 80 cards times a dozen
    // names is a thousand nodes for a list nobody has opened (gotcha 21).
    const offBtns = seg.match(/<button type="button" class="btn check-off-btn"[\s\S]*?<\/button>/g) || [];
    if (offBtns.length !== 1) bad.push(`item ${id}: ${offBtns.length} check-off buttons, expected 1`);
    else {
        if (!offBtns[0].includes(`hx-get="/items/${id}/check-off-window"`)) bad.push(`item ${id}: check-off button doesn't open its own window`);
        if (!offBtns[0].includes('hx-target="#popup-layer"')) bad.push(`item ${id}: check-off button doesn't open into the popup layer`);
        if (seg.includes(`id="check-off-list-${id}"`)) bad.push(`item ${id}: the check-off roster shipped inside the card`);
    }
    tally.checkOff += offBtns.length;
}

const like = (h.match(/class="btn btn-primary like-btn[\s\S]*?<\/button>/g) || []);
for (const [i, b] of like.entries()) {
    if (!b.includes('expanded:') || !b.includes('chat_open:')) bad.push(`like button #${i}: drops open/closed state`);
    if (/👍|🙂/.test(b)) bad.push(`like button #${i}: still has an emoji`);
    if (!/like \(<span class="vote-count">\d+<\/span>\)/.test(b)) bad.push(`like button #${i}: count not in parentheses`);
}

console.log(`${cards.length} cards — ${tally.dialog} ask how many, ${tally.post} tick straight through, `
    + `${tally.signin} prompt sign-in, ${tally.none} have no box, ${tally.ticked} ticked`);
console.log(`${like.length} like buttons checked, ${tally.checkOff} check-off buttons`);
console.log(bad.length ? `FAIL:\n  ${bad.join('\n  ')}` : 'OK — every control matches the rules');
process.exit(bad.length ? 1 : 0);
