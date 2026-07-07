#!/usr/bin/env python3
"""Generate assets/languages/*.svg — the README "Language Support" icon grid.

One tile per supported language: a paper card with the language's vector mark and
its name centered underneath. Labels are converted to vector outlines (Archivo,
same pipeline as generate-waitlist.py) so the SVG renders pixel-identical
everywhere: GitHub loads README SVGs in "secure static mode", which blocks
@font-face / web-font loading, so outlines are the only reliable way to ship the
brand typeface. Every tile sits on the brand paper (#f7f6f2), so brand-colored
marks — including near-black ones like Rust — stay legible on GitHub light *and*
dark themes with no media-query tricks.

Glyph sources (fetched at generation time, results checked in):
  - simple-icons via https://cdn.simpleicons.org/<slug>  (CC0-1.0)
  - devicon via jsDelivr, pinned @v2.16.0                (MIT) — Java, C#,
    Objective-C, which simple-icons doesn't carry
  - hand-drawn in this file: CFML, COBOL, VB.NET (no usable upstream mark)

All trademarks/logos belong to their respective owners; they're used here only
to indicate language support.

Adding a language: append to LANGS, re-run, reference the new SVG in README.md
with a fresh `?v=1`. If you change EXISTING tile bytes, bump that tile's `?v=N`
in README.md in the same commit (GitHub caches README images aggressively).

Requires: fonttools, brotli  (pip install fonttools brotli), network access.
Font: @fontsource-variable/archivo (latin, wght axis) from the landing-page package.
Usage: python3 generate-language-tiles.py [--preview /path/to/preview.svg]
"""
import os
import re
import sys
import urllib.request
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

# --- brand palette (mirrors generate-waitlist.py) ---------------------------
PAPER    = "#f7f6f2"
HAIRLINE = "#d6d3c8"
INK      = "#16150f"

FONT = os.path.join(
    os.path.dirname(__file__),
    "../../landing-page/node_modules/@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2",
)

# --- tile geometry (px) ------------------------------------------------------
TILE        = 104     # square tile, rx=8 card like the waitlist button
GLYPH_BOX   = 44      # logo box, horizontally centered
GLYPH_TOP   = 18
LABEL_SIZE  = 12.5
LABEL_WT    = 640
LABEL_GAP   = 12      # glyph box bottom -> label cap top
TRACK       = 0.15

DEVICON = "https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/{0}/{0}-{1}.svg"

# (file slug, label, source) — README "Supported Languages" table order.
# source: ("si", slug) simple-icons | ("devicon", name, variant) | ("custom", key)
LANGS = [
    ("typescript",  "TypeScript",  ("si", "typescript")),
    ("javascript",  "JavaScript",  ("si", "javascript")),
    ("arkts",       "ArkTS",       ("si", "harmonyos")),
    ("python",      "Python",      ("si", "python")),
    ("go",          "Go",          ("si", "go")),
    ("rust",        "Rust",        ("si", "rust")),
    ("java",        "Java",        ("devicon", "java", "original")),
    ("csharp",      "C#",          ("devicon", "csharp", "original")),
    ("php",         "PHP",         ("si", "php")),
    ("ruby",        "Ruby",        ("si", "ruby")),
    ("c",           "C",           ("si", "c")),
    ("cpp",         "C++",         ("si", "cplusplus")),
    ("objective-c", "Objective-C", ("devicon", "objectivec", "plain")),
    ("metal",       "Metal",       ("si", "apple")),
    ("cuda",        "CUDA",        ("si", "nvidia")),
    ("swift",       "Swift",       ("si", "swift")),
    ("kotlin",      "Kotlin",      ("si", "kotlin")),
    ("scala",       "Scala",       ("si", "scala")),
    ("dart",        "Dart",        ("si", "dart")),
    ("svelte",      "Svelte",      ("si", "svelte")),
    ("vue",         "Vue",         ("si", "vuedotjs")),
    ("astro",       "Astro",       ("si", "astro")),
    ("liquid",      "Liquid",      ("si", "shopify")),
    ("delphi",      "Delphi",      ("si", "delphi")),
    ("lua",         "Lua",         ("si", "lua")),
    ("r",           "R",           ("si", "r")),
    ("luau",        "Luau",        ("si", "luau")),
    ("cfml",        "CFML",        ("custom", "cfml")),
    ("cobol",       "COBOL",       ("custom", "cobol")),
    ("vbnet",       "VB.NET",      ("custom", "vbnet")),
    ("erlang",      "Erlang",      ("si", "erlang")),
    ("solidity",    "Solidity",    ("si", "solidity")),
    ("terraform",   "Terraform",   ("si", "terraform")),
    ("nix",         "Nix",         ("si", "nixos")),
]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "codegraph-assets"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8")


class Outliner:
    """Archivo text -> SVG path outlines, one font instance per weight."""

    def __init__(self):
        self._by_weight = {}

    def _font(self, weight):
        if weight not in self._by_weight:
            ft = TTFont(FONT)
            instantiateVariableFont(ft, {"wght": weight}, inplace=True)
            self._by_weight[weight] = (ft, ft.getBestCmap(), ft.getGlyphSet(), ft["hmtx"])
        return self._by_weight[weight]

    def measure(self, text, size, weight, track=TRACK):
        ft, cmap, _, hmtx = self._font(weight)
        scale = size / ft["head"].unitsPerEm
        w = sum(hmtx[cmap[ord(ch)]][0] * scale + track for ch in text)
        return w - track

    def cap_height(self, size, weight):
        ft, _, _, _ = self._font(weight)
        return getattr(ft["OS/2"], "sCapHeight", 700) * size / ft["head"].unitsPerEm

    def outline(self, text, size, weight, start_x, baseline_y, track=TRACK):
        ft, cmap, glyphs, hmtx = self._font(weight)
        scale = size / ft["head"].unitsPerEm
        sink = SVGPathPen(glyphs, ntos=lambda v: f"{round(v, 2):g}")
        pen_x = start_x
        for ch in text:
            gname = cmap[ord(ch)]
            if ch != " ":
                t = Transform(scale, 0, 0, -scale, pen_x, baseline_y)
                glyphs[gname].draw(TransformPen(sink, t))
            pen_x += hmtx[gname][0] * scale + track
        return sink.getCommands()

    def centered(self, text, size, weight, center_x, baseline_y, track=TRACK):
        w = self.measure(text, size, weight, track)
        return self.outline(text, size, weight, center_x - w / 2, baseline_y, track)


def si_glyph(slug):
    """simple-icons: single brand-colored 24x24 path, scaled into the glyph box."""
    svg = fetch(f"https://cdn.simpleicons.org/{slug}")
    fill = re.search(r'fill="(#[0-9A-Fa-f]{3,8})"', svg).group(1)
    d = re.search(r'<path d="([^"]+)"', svg).group(1)
    s = round(GLYPH_BOX / 24, 5)
    x = (TILE - GLYPH_BOX) / 2
    return f'<g transform="translate({x},{GLYPH_TOP}) scale({s})"><path fill="{fill}" d="{d}"/></g>'


def devicon_glyph(name, variant):
    """devicon: multi-path 128x128 markup, embedded verbatim and scaled."""
    svg = fetch(DEVICON.format(name, variant))
    inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1).strip()
    s = round(GLYPH_BOX / 128, 5)
    x = (TILE - GLYPH_BOX) / 2
    return f'<g transform="translate({x},{GLYPH_TOP}) scale({s})">{inner}</g>'


def custom_glyph(key, out):
    x = (TILE - GLYPH_BOX) / 2          # glyph box left edge (30)
    cx = TILE / 2                        # 52
    cy = GLYPH_TOP + GLYPH_BOX / 2       # glyph box vertical center (40)
    if key == "cfml":
        # The community CFML mark: a <cf> tag, set in Archivo.
        size, wt = 20.0, 700
        baseline = round(cy + out.cap_height(size, wt) / 2, 2)
        d = out.centered("<cf>", size, wt, cx, baseline, track=0.4)
        return f'<path fill="#1b5ea6" d="{d}"/>'
    if key == "cobol":
        # A punched card: manila stock, clipped corner, punched rows.
        w, h = GLYPH_BOX, 28
        top, cut = round(cy - h / 2, 2), 7
        holes = []
        for row in range(3):
            hy = top + 7.4 + row * 6.4
            for col in range(7):
                if (row * 3 + col * 5) % 4 != 0:   # deterministic "data" pattern
                    holes.append(
                        f'<rect x="{round(x + 4.4 + col * 5.4, 2)}" y="{round(hy, 2)}" width="2.4" height="4" fill="#6b5d33"/>'
                    )
        card = (
            f'M{x + cut},{top} H{x + w} V{top + h} H{x} V{top + cut} Z'
        )
        return (
            f'<path d="{card}" fill="#ecdfb1" stroke="#b3a06a" stroke-width="1" stroke-linejoin="miter"/>'
            + "".join(holes)
        )
    if key == "vbnet":
        # The .NET-purple badge with a VB monogram.
        size, wt = 16.5, 720
        baseline = round(cy + out.cap_height(size, wt) / 2, 2)
        d = out.centered("VB", size, wt, cx, baseline, track=0.6)
        return (
            f'<rect x="{x}" y="{GLYPH_TOP}" width="{GLYPH_BOX}" height="{GLYPH_BOX}" rx="6" fill="#512bd4"/>'
            f'<path fill="{PAPER}" d="{d}"/>'
        )
    raise KeyError(key)


def main():
    preview_path = None
    if "--preview" in sys.argv:
        preview_path = sys.argv[sys.argv.index("--preview") + 1]

    out = Outliner()
    label_baseline = round(GLYPH_TOP + GLYPH_BOX + LABEL_GAP + out.cap_height(LABEL_SIZE, LABEL_WT), 2)

    out_dir = os.path.join(os.path.dirname(__file__), "languages")
    os.makedirs(out_dir, exist_ok=True)

    bodies = {}
    for slug, label, source in LANGS:
        if source[0] == "si":
            glyph = si_glyph(source[1])
        elif source[0] == "devicon":
            glyph = devicon_glyph(source[1], source[2])
        else:
            glyph = custom_glyph(source[1], out)
        label_d = out.centered(label, LABEL_SIZE, LABEL_WT, TILE / 2, label_baseline)
        body = (
            f'<rect x="0.5" y="0.5" width="{TILE - 1}" height="{TILE - 1}" rx="8" fill="{PAPER}" stroke="{HAIRLINE}"/>\n'
            f"  {glyph}\n"
            f'  <path fill="{INK}" d="{label_d}"/>'
        )
        bodies[slug] = body
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{TILE}" height="{TILE}" '
            f'viewBox="0 0 {TILE} {TILE}" role="img" aria-label="{label}">\n'
            f"  <title>{label}</title>\n"
            f"  {body}\n"
            f"</svg>\n"
        )
        path = os.path.join(out_dir, f"{slug}.svg")
        with open(path, "w") as fh:
            fh.write(svg)
        print(f"wrote {os.path.relpath(path, os.path.dirname(__file__))}  ({len(svg)}b)  {label}")

    if preview_path:
        cols, pad = 7, 8
        rows = -(-len(LANGS) // cols)
        w = cols * (TILE + pad) + pad
        h = rows * (TILE + pad) + pad
        cells = []
        for i, (slug, _, _) in enumerate(LANGS):
            tx = pad + (i % cols) * (TILE + pad)
            ty = pad + (i // cols) * (TILE + pad)
            cells.append(f'<g transform="translate({tx},{ty})">{bodies[slug]}</g>')
        light = "".join(cells)
        with open(preview_path, "w") as fh:
            fh.write(
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h * 2}" viewBox="0 0 {w} {h * 2}">'
                f'<rect width="{w}" height="{h}" fill="#ffffff"/>{light}'
                f'<g transform="translate(0,{h})"><rect width="{w}" height="{h}" fill="#0d1117"/>{light}</g>'
                f"</svg>\n"
            )
        print(f"wrote preview {preview_path} (top: light bg, bottom: dark bg)")


if __name__ == "__main__":
    main()
