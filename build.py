#!/usr/bin/env python3
"""Build the single-file Obsidian plugin from src/.

The plugin is split into four plain scripts that share one module scope:
  core.js    — AST, LaTeX parser, serializer
  render.js  — flat renderer (AST -> DOM)
  builder.js — visual builder modal
  main.js    — plugin entry (commands, code block processor, settings)

Run from this directory:  python3 build.py
"""

import base64
import os
import shutil
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")

HEADER = """/*
 * Pseudocode Suite — generated bundle. Edit files in src/ and run build.py.
 */

const {
  Plugin,
  Modal,
  Menu,
  Notice,
  MarkdownRenderer,
  MarkdownRenderChild,
  Component,
  MarkdownView,
  TFile,
  PluginSettingTab,
  Setting,
  setIcon,
  Platform,
  renderMath,
  finishRenderMath,
  loadMathJax,
} = require('obsidian');

"""

ORDER = ["core.js", "render.js", "builder.js", "main.js"]

# Obsidian installs only main.js, manifest.json and styles.css, so the fonts
# (subsets made by tools/make-fonts.py) are embedded as data URIs.
# [file, CSS family, style, weight]
FONTS = [
    ("ps-serif-regular.woff2", "CM Pseudocode", "normal", "normal"),
    ("ps-serif-italic.woff2", "CM Pseudocode", "italic", "normal"),
    ("ps-serif-bold.woff2", "CM Pseudocode", "normal", "bold"),
    ("ps-serif-caps.woff2", "CM Pseudocode SC", "normal", "normal"),
]

FONT_NOTICE = """/*
 * Pseudocode Suite — generated from src/styles.css by build.py.
 *
 * Embedded fonts (subsets, renamed as their licenses require; see fonts/LICENSE.md):
 * - PS Serif: from CMU Serif by Andrey V. Panov, SIL Open Font License 1.1
 *   (https://openfontlicense.org).
 * - PS Serif Caps: from LM Roman Caps 10, (c) 2003, 2009 B. Jackowski and J. M. Nowacki,
 *   GUST Font License (https://www.gust.org.pl/projects/e-foundry/licenses).
 */
"""


def font_faces():
    rules = []
    for file, family, style, weight in FONTS:
        with open(os.path.join(HERE, "fonts", file), "rb") as handle:
            data = base64.b64encode(handle.read()).decode("ascii")
        rules.append(
            f"@font-face {{ font-family: '{family}'; font-style: {style}; font-weight: {weight}; "
            f"font-display: swap; src: url(data:font/woff2;base64,{data}) format('woff2'); }}"
        )
    return "\n".join(rules) + "\n\n"


def main():
    parts = [HEADER]
    for name in ORDER:
        path = os.path.join(SRC, name)
        with open(path, encoding="utf-8") as handle:
            parts.append(handle.read().rstrip() + "\n\n")

    with open(os.path.join(HERE, "main.js"), "w", encoding="utf-8") as handle:
        handle.write("".join(parts))

    with open(os.path.join(SRC, "styles.css"), encoding="utf-8") as handle:
        styles = handle.read()
    with open(os.path.join(HERE, "styles.css"), "w", encoding="utf-8") as handle:
        handle.write(FONT_NOTICE + font_faces() + styles)

    # Catch syntax errors before Obsidian does.
    node = shutil.which("node")
    if node:
        subprocess.run([node, "--check", os.path.join(HERE, "main.js")], check=True)

    print("built main.js and styles.css")


if __name__ == "__main__":
    main()
