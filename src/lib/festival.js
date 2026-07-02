export async function loadFestival(c) {
    const id = Number(c.req.param('id'));
    const db = c.env.DB;
    return db.prepare('SELECT * FROM festivals WHERE id = ? AND deleted_at IS NULL').bind(id).first();
}
