-- sample.sql - synthetic SQL file for Explorer preview testing

CREATE TABLE items (
    id      INTEGER PRIMARY KEY,
    label   TEXT NOT NULL,
    color   TEXT,
    count   INTEGER DEFAULT 0
);

INSERT INTO items (id, label, color, count) VALUES
    (1, 'Apple',  'Red',    5),
    (2, 'Banana', 'Yellow', 12),
    (3, 'Grape',  'Purple', 40);

SELECT label, color, count
FROM items
WHERE count > 4
ORDER BY count DESC;
