#!/usr/bin/env python3
"""Assert the subset pixmoji font covers EXACTLY what the client pixel-ifies.

public/camp.js only wraps a codepoint in a .pixmoji span if it falls inside
PIXMOJI_COVERED_RANGES (src/render/pixmoji-coverage.js). If the font is missing a
codepoint that list claims, that emoji renders as UnifontEX tofu (a hex box)
instead of falling back to a native color emoji — the one failure mode worse than
either option on its own, and it's invisible until someone types that emoji.

Run after scripts/build-unifont-pixmoji.sh. Usage:
    python3 scripts/check-pixmoji-font.py [font.woff2]
"""
import re
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

REPO = Path(__file__).resolve().parent.parent
COVERAGE_JS = REPO / "src/render/pixmoji-coverage.js"
DEFAULT_FONT = REPO / "public/fonts/unifontex-pixmoji1.woff2"
# The gap-filler that backs UnifontEX up in the .pixmoji font-family stack. A
# codepoint covered by EITHER font is fine — that's exactly what the stack is for.
FALLBACK_FONT = REPO / "public/fonts/unifont-emoji16a.woff2"


def expected_codepoints():
    src = COVERAGE_JS.read_text()
    m = re.search(r"PIXMOJI_COVERED_RANGES\s*=\s*\[([^\]]*)\]", src)
    if not m:
        sys.exit(f"could not parse ranges out of {COVERAGE_JS}")
    nums = [int(n) for n in m.group(1).split(",") if n.strip()]
    out = set()
    for start, end in zip(nums[::2], nums[1::2]):
        out.update(range(start, end + 1))
    return out


def font_codepoints(path):
    if not path.exists():
        return set()
    return set(TTFont(path).getBestCmap().keys())


def main():
    font_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FONT
    expected = expected_codepoints()
    primary = font_codepoints(font_path)
    fallback = font_codepoints(FALLBACK_FONT)
    have = primary | fallback

    missing = sorted(expected - have)
    print(f"expected (pixmoji-coverage.js): {len(expected)}")
    print(f"in {font_path.name}: {len(primary)}")
    print(f"in {FALLBACK_FONT.name}: {len(fallback)}")
    print(f"covered by the pair: {len(expected & have)}")

    if missing:
        sample = " ".join(f"U+{cp:04X}" for cp in missing[:40])
        print(f"\nMISSING {len(missing)} codepoint(s) the client WILL pixel-ify:")
        print(f"  {sample}")
        sys.exit(1)

    print("\nOK — every codepoint the client pixel-ifies has a real glyph.")


if __name__ == "__main__":
    main()
