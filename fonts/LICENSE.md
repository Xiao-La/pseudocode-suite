# Font licenses

`styles.css` embeds subsets of two font families. `tools/make-fonts.py` makes the subsets
from the original files in `fonts/source/`, and `build.py` embeds them.

Both licenses require a modified font (a subset counts) to use a different name, so the
subsets are named **PS Serif** and **PS Serif Caps**. Their copyright and license fields
(name table IDs 0, 13 and 14) are kept unchanged.

## PS Serif (regular, italic, bold)

- Source: CMU Serif (Computer Modern Unicode), converted from Donald Knuth's Computer
  Modern by Andrey V. Panov. Some glyphs were copied from the Blue Sky fonts released by the AMS.
- License: SIL Open Font License, Version 1.1. Full text and FAQ: https://openfontlicense.org
- Files: `ps-serif-regular.woff2`, `ps-serif-italic.woff2`, `ps-serif-bold.woff2`
  (sources: `source/cm-regular.ttf`, `source/cm-italic.ttf`, `source/cm-bold.ttf`)

## PS Serif Caps (small capitals)

- Source: LM Roman Caps 10 (Latin Modern, the design of TeX's cmcsc10).
  Copyright 2003, 2009 B. Jackowski and J. M. Nowacki (on behalf of TeX users groups).
- License: GUST Font License. Full text: https://www.gust.org.pl/projects/e-foundry/licenses
- File: `ps-serif-caps.woff2` (source: `source/cm-smallcaps.otf`)

`source/cm-bolditalic.ttf` (CMU Serif Bold Italic, same license as above) is kept with
the other sources but not embedded.
