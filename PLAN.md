# Camp Planner — festival packing/logistics site for the crew

Goofy 1995-style site so friends coordinate what to bring to festival camp.
Philosophy: **never block anyone from doing anything** — no admins, everyone can do
every action, everything is audited and undoable (it replaces a Google Sheet; behave like one).
The group chat (GroupMe) is where conversation happens; this site is the *state* —
who brings what, who rides with whom, who bought their parking pass.

## Stack

- Cloudflare Worker, Hono, **server-rendered HTML + HTMX** (fragments swapped in place). No build step, no SPA framework.
- D1 (SQLite) for everything. One worker, one DB.
- Deploy with wrangler on a cuuush.com subdomain (e.g. `camp.cuuush.com`) — copy the `routes` pattern from `~/code/calorie-tracker/wrangler.toml`.
- Secrets (`wrangler secret put`, Chris will paste values): `OPENROUTER_API_KEY`, `RESEND_API_KEY`.
- Email from `camp@robot.cuuush.com` — the robot.cuuush.com domain is already verified in Resend (see calorie-tracker's auth.js for a working Resend fetch call).

## Sign-in (make it EASY)

- [ ] Sign-in = type your name. Optional email field, labeled "only if u want email notifications".
- [ ] Names normalized (lowercase, trimmed) for uniqueness, site-wide. Copy: *"if u think there will be another person with your name, maybe pick something more identifiable haha"*.
- [ ] Name taken + no cookie → "someone's already signed in as chris — is that you? [yes that's me]" (trust-based reclaim, logged in audit).
- [ ] Session cookie, 3-month rolling expiry, HttpOnly.
- [ ] Log IP (`cf-connecting-ip`), geo (Cloudflare request cf object: city/country), user-agent on sign-in and on every mutating action. show this in a admin backend page to see who is logging in (everyone can see this) actually HIDE the ip in the database but just in case we need it for fraud. but say "we totally log your ip, fyi, lol" in the users page. we can have a link to this in the bottom , called admin, maybe? 

## Festivals

- [ ] Global account, then a festival picker. Top-left shows current fest name → dropdown to switch fests or "+ add a fest".
- [ ] Homepage lists all festivals (open, no invite codes).
- [ ] Creating a fest has option to **clone the item list from an existing fest** (items only, not pledges) — this is how the site gets reused year after year, or start fresh
- [ ] Per-fest editable **info box**: blurb, dates (drives a countdown in the header), location/address, ticket + parking links.
- [ ] Seed data: 1 fest called **Elements 2026** with Chris's pre-populated "must have" items, see chrislist.txt
- [ ] Real per-fest hit counter, in old website style, odometer style: "you are visitor #001337".

## Stuff tab (the main list)

- [ ] One flat list. Anything anyone adds is immediately a real item — no separate suggestions tab. **Votes** on every item signal what's most useful; sortable by votes.
- [ ] Item: name, emoji, needed qty + unit (e.g. 3 packs), category (optional), added-by, votes, comments.
- [ ] Pre-seeded items get a static rainbow-gradient-text badge: *~ cush's 2026 forest must have list ~*.
- [ ] Pledges: quick "i have one!" button, or pick a qty (e.g. 2 of 3 water packs). **Over-pledging is fine** (need 1 battery pack, 3 pledged = ok). Un-pledge/withdraw anytime. Never block.
- [ ] Progress per item (2/3 + bar), pledger names shown. Unclaimed items visually loud / floated up.
- [ ] Anyone can edit anything — name, needed qty, emoji, delete — all audited.
- [ ] Comments per item (this is where "my lights are the good costco ones" vs "mine are half broken" gets resolved).
- [ ] Dense rows, collapsed by default; tap to expand for pledge buttons/comments/emoji edit.

## Emoji via OpenRouter

- [ ] On item creation, call `deepseek/deepseek-v4-flash` via OpenRouter: no reasoning/thinking, prompt for exactly 1 emoji for the item name, tiny max_tokens.
- [ ] Fallback 📦 on any failure — never block creation on the LLM. Cache result by normalized item name.
- [ ] User can change the emoji afterward.

## Ppl tab

- [ ] Everyone who joined the fest, with arrival day (thu/fri/sat…) per person.
- [ ] **Checklist grid** ("did u get the required stuff?"): rows = people, columns = tasks. Everyone checks off their own. Defaults per fest: festival pass, parking pass. Anyone can add a column.
- [ ] "not going anymore 😢" bail button → releases that person's pledges and car seats back to unclaimed, announces in the news ticker. def have a confirmation for this, make this undoable. make everything undoable for that matter.

## Rides tab (THE CARPOOL ZONE)

- [ ] Drivers post cars: seats available, leaving from, departure day/time, comment thread.
- [ ] Riders tap an open seat to claim it; leave anytime. No blocking, no approval flow — details get texted by the driver anyway, the site just tracks who's in what car and what's free.


## Mine tab

- [ ] Your pledges, your checklist items, your car/seat — "what do I personally have to do."
- [ ] "packed ✅" toggle per pledge appears when fest is near → becomes the 7am packing checklist.

## Audit, undo, news ticker

- [ ] Every mutation → audit row: who, action, before/after, 
- [ ] **Soft deletes only.** Action log page (visible to everyone — no admins) with **[undo]** on reversible entries, Google-Sheets-style. Undoing is itself an audited action ("chris undid sam's delete").
- [ ] Recent events render as the ★ NEWS ★ ticker at the top of every page: "sam pledged 2 water cases · chris changed canopies to 3 · kayla joined".

## Email notifications (Resend)

- [ ] Only for people who gave an email. Triggers — someone: comments on your item, pledges your item, comments on your car, grabs/leaves a seat in your car.
- [ ] One goofy retro template, from `camp@robot.cuuush.com`, with an unsubscribe link.
- [ ] Don't email people about their own actions.

## Vibe (1995, but works on a phone)

- [ ] GeoCities energy, mobile-usable: web-safe colors, beveled buttons, dense tables, goofy lowercase copy throughout ("whos bringing what", "i got one!!").
- [ ] Static (non-animated) flair: NEW! starbursts, rainbow gradient text, ★ dividers.
- [ ] 88x31 badge row in the footer — Chris supplies the images, leave placeholder slots for: under construction, best viewed in Netscape/IE, valid HTML, NEW!, mailbox, misc rave badges.
- [ ] Webring footer: "← prev | random | next →" cycling through the site's festivals.



## Build order

1. Scaffold worker + wrangler + D1 schema (people, sessions, festivals, memberships, items, pledges, votes, comments, cars, seats, checklist tasks/checks, audit log, emoji cache, hit counter).
2. Sign-in flow + cookie + audit plumbing (log everything from day one).
3. Festivals: create/clone/switch, info box, seed Elements 2026.
4. Stuff tab: items, pledges, votes, comments, emoji LLM.
5. Ppl tab: checklist grid, arrival day, bail button.
6. Rides tab: cars + seats + needs-a-ride.
7. Mine tab + packed toggle.
8. News ticker + action log page + undo.
9. Resend emails.
10. Retro skin: badges, hit counter, webring.
