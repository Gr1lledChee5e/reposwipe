#!/usr/bin/env python3
"""One-off: recolour a file from the purple theme to the green theme (v12.1).
Every purple-family colour (hue 235°–325°) becomes a green of matching brightness; everything else (ambers, reds,
language dots…) is left alone. Lines that should stay purple — the "hints of purple" — are skipped by marker.
The old teal fork accent becomes the purple hint, so forks still read as their own colour on a green page.
Usage: python3 tools/retheme.py <file> [<file> …]"""
import colorsys, re, sys

KEEP_PURPLE = [".tag.acc", ".aipill", ".picktag", "const LANG_COLORS", "KEEP-PURPLE"]
TEAL_TO_PURPLE = {"#5EEAD4": "#C084FC", "#99F6E4": "#E9D5FF", "94,234,212": "192,132,252", "45,212,191": "168,85,247"}

def lin(c): c /= 255; return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def lum(r, g, b): return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
def green(r, g, b):
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255); H = h * 360
    if not (235 <= H <= 325) or s < 0.15: return None
    nh = max(140, min(176, 152 + (H - 262) * 0.65)) / 360
    target = lum(r, g, b)
    if 0.05 < target < 0.6: target = min(0.62, target * 1.55)      # saturated purples look brighter than their luminance; lift mid greens to match
    ns = s * (0.9 if l <= 0.12 else 0.82 - 0.52 * max(0.0, (l - 0.70) / 0.30))   # pale tints stay pale: a mint white, not a green one
    lo, hi = 0.0, 1.0
    for _ in range(30):
        mid = (lo + hi) / 2; rr, gg, bb = [x * 255 for x in colorsys.hls_to_rgb(nh, mid, ns)]
        if lum(rr, gg, bb) < target: lo = mid
        else: hi = mid
    return tuple(round(x * 255) for x in colorsys.hls_to_rgb(nh, (lo + hi) / 2, ns))

def recolor(text):
    out, n = [], 0
    for line in text.split("\n"):
        if any(k in line for k in KEEP_PURPLE): out.append(line); continue
        held = []                                    # teal fork accents are parked, recoloured to purple after the pass
        for a, b in TEAL_TO_PURPLE.items():
            for form in {a, a.lower()}:
                while form in line: line = line.replace(form, "@@HINT%d@@" % len(held), 1); held.append(b); n += 1
        def hx(m):
            nonlocal n
            v = m.group(0); c = green(int(v[1:3], 16), int(v[3:5], 16), int(v[5:7], 16))
            if not c: return v
            n += 1; return "#%02X%02X%02X" % c
        def rg(m):
            nonlocal n
            c = green(int(m.group(2)), int(m.group(3)), int(m.group(4)))
            if not c: return m.group(0)
            n += 1; return "%s(%d,%d,%d" % (m.group(1), *c)
        line = re.sub(r"#[0-9a-fA-F]{6}\b", hx, line)
        line = re.sub(r"\b(rgba?)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", rg, line)
        for i, b in enumerate(held): line = line.replace("@@HINT%d@@" % i, b)
        out.append(line)
    return "\n".join(out), n

if __name__ == "__main__":
    for f in sys.argv[1:]:
        t = open(f, encoding="utf-8").read(); new, n = recolor(t)
        open(f, "w", encoding="utf-8").write(new); print(f, "→", n, "colours changed")
    for c in ["#8B5CF6", "#C084FC", "#C026D3", "#EDE9FE", "#B9AEE0", "#7A6FA8", "#0A0718", "#DDD6FE", "#E9D5FF", "#F0ABFC", "#1A1430"]:
        g = green(int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)); sys.stdout.write("   %s → #%02X%02X%02X\n" % ((c,) + g))
