#!/usr/bin/env python3
"""Rewrite the PIXMOJI_RE line in layout.js so the regex survives being embedded
in the CONFETTI_SCRIPT template literal.

CONFETTI_SCRIPT is a JS backtick template literal that gets injected raw into a
<script> tag. That means every backslash in it is processed once at module load,
so to have the *browser* see `\\p{...}` / `\\uFE0F` we must write DOUBLE
backslashes in the source. This replaces the (broken, single-backslash) line with
a correct double-backslash version.
"""
import re
import pathlib

path = pathlib.Path("/Users/chris/code/camp-planner/src/render/layout.js")
text = path.read_text()

# Desired regex as the BROWSER should see it (raw string = literal backslashes).
# Uses ️ (VS16) and ‍ (ZWJ) so ZWJ sequences / variation selectors are
# swallowed into a single emoji run.
browser_re = (
    r"/(?:\p{Extended_Pictographic}"
    r"(?:️|‍|\p{Emoji_Modifier}|\p{Extended_Pictographic})*"
    r"|[\u{1F1E6}-\u{1F1FF}]{2})/gu"
)
# Double every backslash so it survives the template-literal evaluation:
source_re = browser_re.replace("\\", "\\\\")
new_line = "var PIXMOJI_RE = " + source_re + ";"

new_text, n = re.subn(r"var PIXMOJI_RE = /.*?/gu;", lambda _m: new_line, text)
if n != 1:
    raise SystemExit(f"expected exactly 1 match, got {n}")

path.write_text(new_text)
print("patched PIXMOJI_RE ->")
print(new_line)
