// Seed the canonical Elements 2026 FRIDAY lineup (from the official poster) into a
// festival's schedule. Emits INSERT SQL to stdout; pipe it into wrangler:
//
//   node scripts/seed-elements-friday.mjs [festivalId] > /tmp/friday.sql
//   wrangler d1 execute camp-planner-db --local --file=/tmp/friday.sql
//
// Times are minutes from midnight of the festival day; after-midnight sets are
// 1440+ (12:30 AM = 1470). stage_order is the poster's left→right column order.
// Re-running is safe: it clears this fest's Friday sets first.

const fid = Number(process.argv[2] || 1);
const DAY = 'Friday';

// [stage, stage_order] — columns left→right on the poster.
const STAGES = [['Earth', 0], ['Fire', 1], ['Air', 2], ['Water', 3]];

// [artist, start_min, end_min]
const LINEUP = {
    Earth: [
        ['MACHETE', 930, 980],
        ["MADDY O'NEAL", 990, 1050],
        ['PAPADOSIO', 1080, 1170],
        ['CHASE & STATUS', 1200, 1275],
        ['CRANKDAT', 1300, 1375],
        ['SULLIVAN KING b2b KAYZO', 1380, 1455],
        ['ILLENIUM', 1470, 1560],
    ],
    Fire: [
        ['OVAN', 900, 960],
        ['MISS PIPS', 960, 1020],
        ['RIVA + BIANCA', 1020, 1080],
        ['4YU', 1080, 1155],
        ['KASKADE REDUX', 1155, 1245],
        ['LEVITY', 1260, 1320],
        ['TAPE B', 1320, 1385],
        ['REZZ', 1395, 1470],
    ],
    Air: [
        ['NEEK.O', 720, 795],
        ['LA VIRGEN', 795, 870],
        ['SARINDIPITY', 870, 945],
        ['OBA + FLIP', 945, 1020],
        ['NARASHIMA', 1020, 1110],
        ['MAX LOW', 1110, 1200],
        ['LONDONBRIDGE', 1200, 1290],
        ['TORREN FOOT b2b AIRWOLF PARADISE', 1290, 1380],
        ['SIDEPIECE', 1380, 1470],
        ['WAX MOTIF', 1470, 1560],
    ],
    Water: [
        ['FROM EARTH TO ETHER: AN AYURVEDIC MORNING FLOW', 675, 735],
        ['ACE ON EARTH', 750, 825],
        ['MES', 825, 900],
        ['PATCHES.', 900, 960],
        ['CRUMB PIT', 960, 1020],
        ['EATER', 1020, 1080],
        ['MEDINA', 1095, 1155],
        ['DRUNKEN KONG', 1155, 1215],
        ['MAX & DANA', 1215, 1275],
        ['DEVAULT', 1275, 1335],
        ['LAYTON GIORDANI', 1335, 1410],
        ['ELI BROWN', 1410, 1500],
    ],
};

const esc = (s) => s.replace(/'/g, "''");
const rows = [];
for (const [stage, order] of STAGES) {
    for (const [artist, s, e] of LINEUP[stage]) {
        rows.push(`(${fid}, '${DAY}', '${esc(stage)}', ${order}, '${esc(artist)}', ${s}, ${e})`);
    }
}

console.log(`DELETE FROM schedule_sets WHERE festival_id = ${fid} AND day = '${DAY}';`);
console.log('INSERT INTO schedule_sets (festival_id, day, stage, stage_order, artist, start_min, end_min) VALUES');
console.log(rows.join(',\n') + ';');
