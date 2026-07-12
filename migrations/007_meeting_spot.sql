-- 007: per-festival meeting spot for the cars tab ("everyone converge HERE before
-- the fest"). Rendered as the fake Streets & Trips banner above the car list.
-- All nullable/additive: no meeting spot set = no banner content, old fests fine.
ALTER TABLE festivals ADD COLUMN meet_name TEXT;      -- "Sunoco"
ALTER TABLE festivals ADD COLUMN meet_address TEXT;   -- "1 Commercial Blvd, Blakeslee, PA 18610"
ALTER TABLE festivals ADD COLUMN meet_maps_url TEXT;  -- google maps link (everyone uses google maps)
ALTER TABLE festivals ADD COLUMN meet_time TEXT;      -- free text: "Friday 10:00 AM"
