// Unit-check splitArtists() against every multi-artist/alias name actually in the
// DB, plus the shapes we expect but haven't seen yet, plus the names that must NOT
// be split. Run: node scripts/test-artist-split.mjs
import { splitArtists } from '../src/lib/spotify.js';

const cases = [
    // --- real rows from the imported Elements schedule ---
    ['SULLIVAN KING b2b KAYZO', ['SULLIVAN KING', 'KAYZO']],
    ['TORREN FOOT b2b AIRWOLF PARADISE', ['TORREN FOOT', 'AIRWOLF PARADISE']],
    ['HVNLEE b2b LUNA MAR', ['HVNLEE', 'LUNA MAR']],
    ['DJ DIESEL AKA SHAQ', ['DJ DIESEL']],
    // --- must NOT split: measured as a real duo on Spotify (exact match) ---
    ['RIVA + BIANCA', ['RIVA + BIANCA']],
    ['OBA + FLIP', ['OBA + FLIP']],
    // --- ordinary names pass through untouched ---
    ['NEEK.O', ['NEEK.O']],
    ['MADDY O\'NEAL', ['MADDY O\'NEAL']],
    // --- case-insensitivity of the separators ---
    ['A B2B B', ['A', 'B']],
    ['A b2b B', ['A', 'B']],
    ['A B3B B', ['A', 'B']],
    ['A vs B', ['A', 'B']],
    ['A VS. B', ['A', 'B']],
    ['X a.k.a. Y', ['X']],
    ['X AKA Y', ['X']],
    // --- three-way ---
    ['A b2b B b2b C', ['A', 'B', 'C']],
    // --- combined ---
    ['DJ DIESEL AKA SHAQ b2b KAYZO', ['DJ DIESEL', 'KAYZO']],
    // --- names that merely CONTAIN the letters must survive ---
    ['B2B Connect', ['B2B Connect']],   // no surrounding spaces → not a separator
    ['Elvis', ['Elvis']],
    ['Vsauce', ['Vsauce']],
    ['Blaqk Audio', ['Blaqk Audio']],
    // --- trailing slot notes are display text, not search text (no live examples
    //     yet — this is the shape Chris says a future poster will use) ---
    ['GANJA WHITE NIGHT (SUNSET SET)', ['GANJA WHITE NIGHT']],
    ['SOMEONE (live)', ['SOMEONE']],
    ['SOMEONE (DJ set)', ['SOMEONE']],
    ['SOMEONE (live) (sunset set)', ['SOMEONE']],
    ['A (sunset set) b2b B (live)', ['A', 'B']],
    // --- but a LEADING/inner paren is part of the name ---
    ['(hed) p.e.', ['(hed) p.e.']],
    ['Godspeed You! (Black Emperor) Live', ['Godspeed You! (Black Emperor) Live']],
    // --- junk ---
    ['', []],
    [null, []],
    ['   ', []],
];

let fail = 0;
for (const [input, want] of cases) {
    const got = splitArtists(input);
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(input).padEnd(36)} → ${JSON.stringify(got)}${ok ? '' : `   want ${JSON.stringify(want)}`}`);
}
console.log(`\n${cases.length - fail}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
