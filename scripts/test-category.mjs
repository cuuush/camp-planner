// Ad-hoc probe for getItemCategory() — checks whether the LLM is reusing existing
// categories sensibly or just defaulting to whatever's already there regardless of
// fit. Run: node scripts/test-category.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const key = (await readFile(resolve(root, '.dev.vars'), 'utf8')).match(/^OPENROUTER_API_KEY=(.+)$/m)[1].trim();

const { getItemCategory } = await import('../src/lib/category.js');

const fakeDb = (categories) => ({
    prepare: () => ({
        bind: () => ({
            all: async () => ({ results: categories.map((category) => ({ category })) }),
        }),
    }),
});

const cases = [
    { existing: ['poop'], name: 'Portable propane stove' },
    { existing: ['poop'], name: 'Tent' },
    { existing: ['Kitchen Gear', 'Shelter'], name: 'Propane stove' },
    { existing: ['Kitchen Gear', 'Shelter'], name: 'Camp chairs' },
    { existing: [], name: 'Sunscreen' },
    { existing: ['Kitchen Gear', 'Shelter', 'Comfort'], name: 'Bug spray' },
];

for (const { existing, name } of cases) {
    const cat = await getItemCategory({ OPENROUTER_API_KEY: key }, fakeDb(existing), 1, name);
    console.log(`existing=[${existing.join(', ')}]  item="${name}"  ->  "${cat}"`);
}
