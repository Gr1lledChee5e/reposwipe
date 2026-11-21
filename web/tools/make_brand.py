#!/usr/bin/env python3
"""Skill Swipe brand assets (green theme, v12.1).

  brand/logo-source.png  the emblem as supplied (red on black)      → logo.webp (in-app, 224 px, transparent, green)
  bg.purple.jpg          the original purple nebula                  → bg.jpg (green nebula with a hint of purple)
  also writes brand/logo-1024.png, og/icon512.png and the extension icons when ../../reposwipe-extension exists.
Usage: python3 tools/make_brand.py
"""
import os, sys
import numpy as np
from PIL import Image, ImageFilter
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
def P(*a): return os.path.join(HERE, *a)

def rgb_to_hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]; mx = a.max(-1); mn = a.min(-1); d = mx - mn
    h = np.zeros_like(mx); m = d > 1e-6
    rc = (mx == r) & m; gc = (mx == g) & m & ~rc; bc = m & ~rc & ~gc
    h[rc] = ((g - b)[rc] / d[rc]) % 6; h[gc] = (b - r)[gc] / d[gc] + 2; h[bc] = (r - g)[bc] / d[bc] + 4
    return h / 6.0, np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0), mx
def hsv_to_rgb(h, s, v):
    i = np.floor(h * 6).astype(int) % 6; f = h * 6 - np.floor(h * 6); p = v * (1 - s); q = v * (1 - f * s); t = v * (1 - (1 - f) * s)
    out = np.zeros(h.shape + (3,))
    for k, (r, g, b) in enumerate([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]):
        m = i == k; out[m, 0] = r[m]; out[m, 1] = g[m]; out[m, 2] = b[m]
    return out

# ---- logo: red emblem on black → emerald emblem on transparent
src = np.asarray(Image.open(P("brand", "logo-source.png")).convert("RGB")).astype(float) / 255
h, s, v = rgb_to_hsv(src)
GREEN = 150 / 360.0
lit = np.clip(v, 0, 1)
rgb = hsv_to_rgb(np.full_like(h, GREEN), np.clip(s * 0.92, 0, 1), np.clip(lit * 1.05, 0, 1))
rgb[..., 0] += 0.10 * lit ** 3; rgb[..., 2] += 0.16 * lit ** 3          # hot highlights lean mint, not flat green
alpha = np.clip((lit - 0.045) / 0.30, 0, 1) ** 0.85                       # black → transparent, keep the dark stone texture inside
un = np.clip(rgb / np.maximum(alpha[..., None], 0.35), 0, 1)              # un-premultiply so edges don't go dark
logo = Image.fromarray((np.dstack([un, alpha]) * 255).astype("uint8"), "RGBA")
bbox = logo.getbbox(); side = max(bbox[2] - bbox[0], bbox[3] - bbox[1]); pad = int(side * 0.04)
sq = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (0, 0, 0, 0))
sq.paste(logo.crop(bbox), (pad + (side - (bbox[2] - bbox[0])) // 2, pad + (side - (bbox[3] - bbox[1])) // 2))
sq.resize((1024, 1024), Image.LANCZOS).save(P("brand", "logo-1024.png"))
sq.resize((224, 224), Image.LANCZOS).save(P("logo.webp"), "WEBP", quality=78, method=6)
print("logo.webp", os.path.getsize(P("logo.webp")), "bytes")

def icon(size, path):   # the emblem on the app's dark green, for places that need an opaque square
    bg = Image.new("RGBA", (size, size), (4, 18, 12, 255))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0)); em = sq.resize((int(size * 0.86),) * 2, Image.LANCZOS)
    off = (size - em.size[0]) // 2; glow.paste(em, (off, off), em)
    if size >= 96: bg = Image.alpha_composite(bg, glow.filter(ImageFilter.GaussianBlur(size / 22)))
    Image.alpha_composite(bg, glow).convert("RGB").save(path)
icon(512, P("og", "icon512.png"))
ext = os.path.join(HERE, "..", "reposwipe-extension", "icons")
if os.path.isdir(ext):
    for n in (16, 32, 48, 128): icon(n, os.path.join(ext, f"icon{n}.png"))
    print("extension icons written")

# ---- background: purple nebula → green nebula that keeps a little purple in its brightest swirl
im = Image.open(P("bg.purple.jpg")).convert("RGB"); a = np.asarray(im).astype(float) / 255
h, s, v = rgb_to_hsv(a)
g = hsv_to_rgb((h - 118 / 360.0) % 1.0, np.clip(s * 0.86, 0, 1), np.clip(v * 0.80, 0, 1))
bright = np.asarray(Image.fromarray((v * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(28))).astype(float) / 255
mask = np.clip((bright - 0.30) / 0.35, 0, 1)[..., None] * 0.42            # only the bright core keeps some of the original purple
out = np.clip(g * (1 - mask) + a * 0.9 * mask, 0, 1)
res = Image.fromarray((out * 255).astype("uint8"))
for q in range(60, 30, -2):
    res.save(P("bg.jpg"), "JPEG", quality=q, optimize=True)
    if os.path.getsize(P("bg.jpg")) <= 40000: break
print("bg.jpg", os.path.getsize(P("bg.jpg")), "bytes at q", q)
