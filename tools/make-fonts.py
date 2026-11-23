#!/usr/bin/env python3
"""Make the web fonts that build.py embeds into styles.css.

Obsidian installs only main.js, manifest.json and styles.css, so the fonts
travel inside styles.css as woff2 data URIs. This script subsets the source
fonts in fonts/source/ to the characters pseudocode uses and writes
fonts/*.woff2.

Licenses: CMU Serif is under the SIL Open Font License 1.1 and LM Roman Caps
under the GUST Font License. Both require a modified (subset) font to carry a
different name, so the subsets are renamed "PS Serif" / "PS Serif Caps"; the
copyright and license fields (name IDs 0, 13, 14) are kept. See fonts/LICENSE.md.

Needs fontTools and brotli:  pip install fonttools brotli
Run from the plugin folder:  python3 tools/make-fonts.py
"""

import os

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(HERE, "fonts", "source")
OUT = os.path.join(HERE, "fonts")

# Latin, Latin-1, Latin Extended-A, Greek, punctuation, arrows, math operators.
UNICODES = (
    list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + list(range(0x370, 0x400))
    + list(range(0x2010, 0x2070)) + list(range(0x2190, 0x2200)) + list(range(0x2200, 0x2300))
)

# (source file, output file, new family name, style name)
FONTS = [
    ("cm-regular.ttf", "ps-serif-regular.woff2", "PS Serif", "Regular"),
    ("cm-italic.ttf", "ps-serif-italic.woff2", "PS Serif", "Italic"),
    ("cm-bold.ttf", "ps-serif-bold.woff2", "PS Serif", "Bold"),
    ("cm-smallcaps.otf", "ps-serif-caps.woff2", "PS Serif Caps", "Regular"),
]

KEEP_NAME_IDS = {0, 13, 14}  # copyright, license description, license URL


def rename(font, family, style):
    """Drop the original names (reserved by the licenses), keep the legal notices."""
    table = font["name"]
    table.names = [record for record in table.names if record.nameID in KEEP_NAME_IDS]
    full = f"{family} {style}".replace(" Regular", "")
    postscript = full.replace(" ", "") if style != "Regular" else family.replace(" ", "")
    for name_id, value in ((1, family), (2, style), (3, f"{postscript};subset"), (4, full), (6, postscript)):
        table.setName(value, name_id, 3, 1, 0x409)
    # The GUST fonts carry their license only in the copyright string; say where it is.
    if not any(record.nameID == 13 for record in table.names):
        table.setName("GUST Font License, see https://www.gust.org.pl/projects/e-foundry/licenses", 13, 3, 1, 0x409)


def main():
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["kern", "liga", "smcp", "c2sc"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    for source, output, family, style in FONTS:
        font = TTFont(os.path.join(SOURCE, source))
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=UNICODES)
        subsetter.subset(font)
        rename(font, family, style)
        font.flavor = "woff2"
        path = os.path.join(OUT, output)
        font.save(path)
        print(f"{output}: {os.path.getsize(path) // 1024} KB")


if __name__ == "__main__":
    main()
