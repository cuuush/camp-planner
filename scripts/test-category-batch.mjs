// Simulates categorizing a real festival's item list in order, letting categories
// accumulate as getItemCategory() would in production — checks for sane grouping
// and whether the category set stays tidy (not one-category-per-item) or sprawls.
// Run: node scripts/test-category-batch.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const key = (await readFile(resolve(root, '.dev.vars'), 'utf8')).match(/^OPENROUTER_API_KEY=(.+)$/m)[1].trim();

const { getItemCategory } = await import('../src/lib/category.js');

const items = [
    'Tent', 'Sleeping bag', 'Camp chairs', 'Tapestries', 'Fairy lights', 'Couch',
    'Beer', 'Water', 'Ice (bagged)', 'Propane stove', 'Cooler', 'Plates and cups',
    'Sunscreen', 'Bug spray', 'First aid kit', 'Portable charger', 'Extension cords',
    'Bluetooth speaker', 'EZ-Up canopy', 'Rug', 'Trash bags', 'Toilet paper',
    'Hand sanitizer', 'Baby wipes', 'Card games', 'Frisbee', 'Hammock', 'Rain jacket',
    'Duct tape', 'Headlamp', 'Cash for camp dues', 'Totem materials',
];

let categories = [];
const db = () => ({
    prepare: () => ({
        bind: () => ({
            all: async () => ({ results: categories.map((category) => ({ category })) }),
        }),
    }),
});

for (const name of items) {
    const cat = await getItemCategory({ OPENROUTER_API_KEY: key }, db(), 1, name);
    if (!categories.includes(cat)) categories.push(cat);
    console.log(`${name.padEnd(24)} -> ${cat}`);
}

console.log(`\n${categories.length} distinct categories for ${items.length} items:`);
console.log(categories.map((c) => `  - ${c}`).join('\n'));
