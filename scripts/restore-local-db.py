#!/usr/bin/env python3
"""Regenerate the local D1 dev data as named-column INSERTs.

Context: the deploy work set a real `database_id` in wrangler.toml, which re-keys
the miniflare local D1 to a fresh empty file. Our real dev data still lives in the
OLD id's sqlite file. We can't just replay a positional `.dump` because the old
`items` table has `description` appended at the end (added later via ALTER TABLE)
while schema.sql puts it 4th — positional VALUES() would misalign.

So: read every row from the OLD sqlite and emit `INSERT INTO t (cols) VALUES (...)`
with explicit column names (order-independent), preceded by DELETE FROMs to clear
any partial rows from a failed load. Apply the result with:

  wrangler d1 execute camp-planner-db --local --file=<out>

after schema.sql has created the tables.
"""
import sqlite3
import sys

OLD = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/c6c9fe2e839a026d2bc28c3710008b8d91b43bb2bed7c7b18fa3ea4062dfb1a0.sqlite"

con = sqlite3.connect(OLD)
con.row_factory = sqlite3.Row
cur = con.cursor()

# Tables in creation order (parents before children) — safe for inserts.
tables = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
).fetchall()]


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, bytes):
        return "X'" + v.hex() + "'"
    return "'" + str(v).replace("'", "''") + "'"


out = []
# Clear any partial data first, children before parents.
for t in reversed(tables):
    out.append(f"DELETE FROM {t};")
# Insert with explicit column names so column ORDER can't matter.
for t in tables:
    cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})").fetchall()]
    collist = ", ".join(cols)
    for row in cur.execute(f"SELECT * FROM {t}").fetchall():
        vals = ", ".join(lit(row[c]) for c in cols)
        out.append(f"INSERT INTO {t} ({collist}) VALUES ({vals});")

sys.stdout.write("\n".join(out) + "\n")
con.close()
