// Checks the Stuff tab's three groups hold together:
//   • "just added" and "still need these" only ever hold items still short of their
//     needed qty; anything covered sits in "all covered", however new it is
//   • inside "still need these", partly-pledged items rank above untouched ones
//   • no card appears in two groups, and each header's count matches its cards
// The 1-hour cutoff for "just added" is decided server-side from items.created_at,
// which the markup doesn't carry, so that boundary isn't checked here — see
// itemListFragment. Usage: node scripts/check-stuff-order.mjs [festivalId]
const fest = process.argv[2] || '1';
const base = process.argv[3] || 'http://localhost:8787';

const page = await (await fetch(`${base}/f/${fest}/stuff`)).text();

// Each card carries its tally as "<pledged>/<needed> <unit>" in .item-tally.
function cardsIn(sectionId, nextId) {
    const seg = page.split(`id="${sectionId}"`)[1]?.split(`id="${nextId}"`)[0] ?? '';
    const count = +(seg.match(/section-count">(\d+)/) || [])[1];
    const cards = [...seg.matchAll(/id="item-(\d+)"[\s\S]*?class="item-tally">\s*(\d+)\/(\d+)/g)]
        .map(([, id, pledged, needed]) => ({ id, pledged: +pledged, needed: +needed }));
    return { count, cards };
}

const fresh = cardsIn('stuff-new', 'stuff-incomplete');
const need = cardsIn('stuff-incomplete', 'stuff-complete');
const done = cardsIn('stuff-complete', 'THE-END');
const bad = [];

for (const [label, group] of [['just added', fresh], ['still need these', need], ['all covered', done]]) {
    if (group.count !== group.cards.length) bad.push(`"${label}" header says ${group.count}, holds ${group.cards.length}`);
    for (const c of group.cards) {
        const covered = c.pledged >= c.needed;
        if (label === 'all covered' && !covered) bad.push(`item ${c.id} (${c.pledged}/${c.needed}) is in "all covered" but isn't`);
        if (label !== 'all covered' && covered) bad.push(`item ${c.id} (${c.pledged}/${c.needed}) is covered but sits in "${label}"`);
    }
}

const seen = new Map();
for (const [label, group] of [['just added', fresh], ['still need these', need], ['all covered', done]]) {
    for (const c of group.cards) {
        if (seen.has(c.id)) bad.push(`item ${c.id} appears in both "${seen.get(c.id)}" and "${label}"`);
        seen.set(c.id, label);
    }
}

// Partly-pledged first, inside "still need these" only — "just added" is by recency.
let firstUntouched = null;
for (const c of need.cards) {
    if (c.pledged === 0) firstUntouched ??= c;
    else if (firstUntouched) bad.push(`item ${c.id} (${c.pledged}/${c.needed}) ranks below untouched item ${firstUntouched.id}`);
}

console.log(`just added ${fresh.cards.length} · still need these ${need.cards.length} `
    + `(${need.cards.filter((c) => c.pledged > 0).length} partial) · all covered ${done.cards.length}`);
console.log(bad.length ? `FAIL:\n  ${bad.join('\n  ')}` : 'OK — groups are consistent and partly-pledged items rank first');
process.exit(bad.length ? 1 : 0);
