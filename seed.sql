-- Seed data: Elements 2026, Chris's pre-populated "must have" items.
-- Assumes a fresh DB (festival gets id 1).

INSERT INTO festivals (name, blurb, location, hit_count)
VALUES ('Elements 2026', 'the crew''s home base for 2026 — fill in dates/location/links in settings!', NULL, 0);

INSERT INTO checklist_tasks (festival_id, label, is_default) VALUES
    (1, 'festival pass', 1),
    (1, 'parking pass', 1);

INSERT INTO items (festival_id, name, emoji, needed_qty, unit, is_seed, seed_label) VALUES
    (1, 'Spare chairs', '🪑', 4, 'chairs', 1, 'cush''s 2026 forest must have list'),
    (1, 'Broom', '🧹', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'More water', '💧', 3, 'cases', 1, 'cush''s 2026 forest must have list'),
    (1, 'Incense sticks', '🕯️', 2, 'packs', 1, 'cush''s 2026 forest must have list'),
    (1, 'Breakfast', '🥞', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Lights, more lights', '💡', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Oscillating fan', '🌀', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Projector for canopy', '📽️', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'More tapestries, full wall', '🧶', 4, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Nasal spray', '💦', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Mirror', '🪞', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Carpet', '🟫', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Star canopies set up', '⭐', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Table', '🪵', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Tapestries', '🧵', 2, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Battery powered fan', '🔋', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Replace totem batteries', '🔋', 1, 'sets', 1, 'cush''s 2026 forest must have list'),
    (1, 'Zip lock bag for totem', '🧴', 1, NULL, 1, 'cush''s 2026 forest must have list'),
    (1, 'Gutter for canopy', '⛺', 1, NULL, 1, 'cush''s 2026 forest must have list');
