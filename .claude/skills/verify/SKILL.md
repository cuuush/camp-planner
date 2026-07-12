---
name: verify
description: Build, run, and drive camp-planner locally to verify changes end-to-end.
---

# Verifying camp-planner

Hono app on Cloudflare Workers + D1, server-rendered HTML with htmx fragments.

## Build & launch

```bash
npm install
npx wrangler d1 execute camp-planner-db --local --file=schema.sql
npx wrangler d1 execute camp-planner-db --local --file=seed.sql
npx wrangler dev --ip 127.0.0.1 --port 8787   # ready in ~3s, watch stdout for "Ready"
```

Local D1 persists under `.wrangler/`; inspect or mutate it with
`npx wrangler d1 execute camp-planner-db --local --command "SELECT ..."`.

## Flows worth driving (curl, cookie jar)

```bash
curl -c jar.txt -d "name=Chris&next=/f/1/stuff" http://127.0.0.1:8787/signin   # 302, sets camp_session
curl -b jar.txt http://127.0.0.1:8787/f/1/stuff                                # main list page (seed fest id=1)
curl -b jar.txt -d "expanded=0" http://127.0.0.1:8787/items/1/vote             # htmx fragment back
curl -b jar.txt -d "qty=2" http://127.0.0.1:8787/items/1/pledge
curl -b jar.txt -d "body=hi" http://127.0.0.1:8787/items/1/comments
# undo: find audit id via d1 execute, then POST /f/1/log/<id>/undo
```

Tabs: `/f/1/stuff`, `/f/1/ppl`, `/f/1/rides`, `/f/1/mine`, `/f/1/log`.

## Gotchas

- Any authed action on a fest auto-creates a membership (join banner disappears).
- No OPENROUTER_API_KEY / RESEND_API_KEY locally: item-add falls back to 📦 emoji,
  notification emails silently no-op — both are fine for verification.
- Static assets + `public/_headers` are served by wrangler dev too; check headers
  with `curl -I`.
