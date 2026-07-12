-- 008: monthly third-party API budget (Google Places for the meeting-spot search).
-- One row per (period, api) where period is 'YYYY-MM'; the counter is bumped BEFORE
-- each outbound call and the call is skipped once the month's budget is spent — a
-- server-side hard stop that keeps us inside the API's free tier no matter what a
-- client does. Monthly (not daily) because real usage is bursty: everyone plans the
-- same evening, then nothing for weeks — matching the shape of Google's free tier,
-- which is also monthly. Not soft-deleted / not audited: plumbing, not user data.
CREATE TABLE IF NOT EXISTS api_usage (
    period TEXT NOT NULL,
    api TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (period, api)
);
