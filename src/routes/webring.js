import { Hono } from 'hono';

export const webring = new Hono();

async function orderedFestivalIds(db) {
    const rows = (await db.prepare('SELECT id FROM festivals WHERE deleted_at IS NULL ORDER BY id').all()).results;
    return rows.map((r) => r.id);
}

webring.get('/webring/:currentId/:direction', async (c) => {
    const db = c.env.DB;
    const ids = await orderedFestivalIds(db);
    if (ids.length === 0) return c.redirect('/');

    const direction = c.req.param('direction');
    const currentId = Number(c.req.param('currentId'));
    const idx = ids.indexOf(currentId);

    let target;
    if (direction === 'random') {
        target = ids[Math.floor(Math.random() * ids.length)];
    } else if (direction === 'prev') {
        target = idx === -1 ? ids[0] : ids[(idx - 1 + ids.length) % ids.length];
    } else {
        target = idx === -1 ? ids[0] : ids[(idx + 1) % ids.length];
    }

    return c.redirect(`/f/${target}`);
});
