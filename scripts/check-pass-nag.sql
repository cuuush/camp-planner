-- Correctness check for the Rover pass-nag rewrite (src/render/layout.js,
-- passStatement): the old code ran two queries and combined them in JS; the new
-- one answers with three EXISTS in a single row. For every member of a fest this
-- computes BOTH shapes side by side, so `same_fest` / `same_car` must be 1 on
-- every row. Run:
--   npx wrangler d1 execute camp-planner-db --local --file=scripts/check-pass-nag.sql
WITH members AS (
    SELECT m.person_id, m.festival_id
    FROM memberships m
    WHERE m.bailed_at IS NULL
),
-- NEW: what passStatement() returns.
new_shape AS (
    SELECT
        mb.person_id, mb.festival_id,
        EXISTS(SELECT 1 FROM cars
               WHERE festival_id = mb.festival_id AND driver_person_id = mb.person_id
                 AND deleted_at IS NULL) AS driving,
        EXISTS(SELECT 1 FROM checklist_tasks t
               JOIN checklist_checks cc ON cc.task_id = t.id
               WHERE t.festival_id = mb.festival_id AND t.is_default = 1 AND t.deleted_at IS NULL
                 AND cc.person_id = mb.person_id AND cc.unchecked_at IS NULL
                 AND lower(t.label) = 'festival pass') AS got_fest_pass,
        EXISTS(SELECT 1 FROM checklist_tasks t
               JOIN checklist_checks cc ON cc.task_id = t.id
               WHERE t.festival_id = mb.festival_id AND t.is_default = 1 AND t.deleted_at IS NULL
                 AND cc.person_id = mb.person_id AND cc.unchecked_at IS NULL
                 AND lower(t.label) = 'car pass') AS got_car_pass
    FROM members mb
),
-- OLD: the label set the second query returned, which JS then searched.
old_labels AS (
    SELECT mb.person_id, mb.festival_id,
           MAX(CASE WHEN lower(t.label) = 'festival pass' THEN 1 ELSE 0 END) AS got_fest_pass,
           MAX(CASE WHEN lower(t.label) = 'car pass' THEN 1 ELSE 0 END) AS got_car_pass
    FROM members mb
    LEFT JOIN checklist_tasks t
           ON t.festival_id = mb.festival_id AND t.is_default = 1 AND t.deleted_at IS NULL
    LEFT JOIN checklist_checks cc
           ON cc.task_id = t.id AND cc.person_id = mb.person_id AND cc.unchecked_at IS NULL
    WHERE cc.id IS NOT NULL
    GROUP BY mb.person_id, mb.festival_id
)
SELECT
    p.display_name, n.festival_id, n.driving,
    -- The two booleans the render actually branches on.
    (NOT n.got_fest_pass) AS new_need_fest,
    (n.driving AND NOT n.got_car_pass) AS new_need_car,
    (COALESCE(o.got_fest_pass, 0) = 0) AS old_need_fest,
    (n.driving AND COALESCE(o.got_car_pass, 0) = 0) AS old_need_car,
    ((NOT n.got_fest_pass) = (COALESCE(o.got_fest_pass, 0) = 0)) AS same_fest,
    ((n.driving AND NOT n.got_car_pass) = (n.driving AND COALESCE(o.got_car_pass, 0) = 0)) AS same_car
FROM new_shape n
JOIN people p ON p.id = n.person_id
LEFT JOIN old_labels o ON o.person_id = n.person_id AND o.festival_id = n.festival_id
ORDER BY n.festival_id, p.display_name;
