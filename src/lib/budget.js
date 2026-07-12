// Monthly budgets for third-party APIs — the server-side guarantee that outbound
// calls stay inside a provider's FREE tier no matter how hard a client hammers an
// endpoint. Monthly, not daily: real searching happens in bursts (the whole camp
// plans on one evening), and Google's free tier is monthly anyway — so the budget
// matches the shape of both. Bump-then-check: the counter increments before the
// caller does the external call, and once the month's budget is spent callers must
// skip the call and degrade politely (the meeting-spot search says so; the link
// parser still works because it never calls out). D1-backed so the cap holds
// across isolates/regions, unlike an in-memory counter.
//
// Google-side backstops (gcloud quota overrides on the project) exist only for
// catastrophe — a bug here, a leaked key: SearchTextRequest 160/day + 30/min.
// 160×31 = 4,960 stays under the free tier even if this file stops working.

export async function takeApiBudget(db, api, monthlyLimit) {
    const period = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    await db.prepare(`
        INSERT INTO api_usage (period, api, count) VALUES (?, ?, 1)
        ON CONFLICT(period, api) DO UPDATE SET count = count + 1
    `).bind(period, api).run();
    const row = await db.prepare('SELECT count FROM api_usage WHERE period = ? AND api = ?').bind(period, api).first();
    return row.count <= monthlyLimit;
}

// Google Places free tier is 5,000 Pro-SKU calls/month (2025 pricing). 4,500
// leaves headroom for timezone edges and the Google-side daily backstop math.
export const PLACES_MONTHLY_LIMIT = 4500;
