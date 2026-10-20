"""One-off: move the app's dark stylesheets onto the site's light palette, by what each colour does.

A dark theme's colours cannot simply be inverted: its panels are lighter than its page, and on a light page the
cards are whiter than the page. So each colour is mapped by the property it sits in:
  backgrounds  near-black page -> #f3f3f1, dark panels -> white (hovers a shade darker), light fills kept
  lines        dark hairlines -> light greys (hover borders darker), white overlays -> ink overlays
  text         light text -> ink (muted stays muted), dark text on a fill kept, accents darkened for contrast
  shadows      black shadows softened
Saturated accents (gold, the status colours, chain colours) keep their hue.

  python scripts/light-theme.py src/explorer.css src/styles.css
"""
import colorsys
import re
import sys

ANY = re.compile(r"#(?P<hex>[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b"
                 r"|rgba?\(\s*(?P<r>\d+)\s*,\s*(?P<g>\d+)\s*,\s*(?P<b>\d+)\s*(?:,\s*(?P<a>[\d.]+)\s*)?\)")


def parse_hex(h):
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    a = int(h[6:8], 16) / 255 if len(h) == 8 else None
    return r, g, b, a


def hls(r, g, b):
    return colorsys.rgb_to_hls(r / 255, g / 255, b / 255)


def to_rgb(h, l, s):
    r, g, b = colorsys.hls_to_rgb(h, max(0, min(1, l)), s)
    return round(r * 255), round(g * 255), round(b * 255)


def fmt(r, g, b, a):
    if a is None:
        return f"#{r:02x}{g:02x}{b:02x}"
    return f"rgba({r},{g},{b},{a:.3g})".replace("rgba(", "rgba(")


def neutral(s, l):
    return s < 0.25 or l < 0.1 or l > 0.92


def map_color(role, r, g, b, a):
    h, l, s = hls(r, g, b)
    white = r > 240 and g > 240 and b > 240
    black = l < 0.09 and neutral(s, l)
    if a is not None and a < 1:
        # translucent: white veils on dark become ink veils; dark veils keep their job, lighter
        if white and role in ("bg", "line"):
            return fmt(11, 11, 12, min(1, a * (0.9 if role == "bg" else 1.1)))
        if black and role == "bg" and a >= 0.5:
            return fmt(243, 243, 241, a)
        if black and role in ("shadow", "bg"):
            return fmt(16, 16, 24, a * 0.4)
        if role == "text" and white:
            return fmt(11, 11, 12, a)
        return fmt(r, g, b, a)
    if role == "shadow":
        return fmt(r, g, b, a)
    if not neutral(s, l):
        if role == "text" or role == "line":
            return fmt(*to_rgb(h, min(l, 0.4), s), a)
        return fmt(r, g, b, a)
    if role == "bg":
        if l <= 0.055:
            return "#f3f3f1"
        if l <= 0.22:
            return fmt(*to_rgb(h, 1 - max(0, l - 0.07) * 0.6, min(s, 0.08)), a)
        return fmt(r, g, b, a)
    if role == "line":
        if l < 0.4:
            return fmt(*to_rgb(h, 0.98 - l * 0.5, min(s, 0.08)), a)
        return fmt(r, g, b, a)
    if role == "text":
        if l < 0.25:
            return fmt(r, g, b, a)  # dark text sits on a light or coloured fill; it stays dark
        return fmt(*to_rgb(h, min((1 - l) * 0.9, 0.56), min(s, 0.1)), a)
    return fmt(r, g, b, a)


def role_of(prop):
    p = prop.strip().lower()
    if p.startswith("--"):
        if any(k in p for k in ("line", "ring", "hairline", "border", "rule")):
            return "line"
        if any(k in p for k in ("bg", "panel", "surface", "card", "wash")):
            return "bg"
        if any(k in p for k in ("ink", "text", "fg", "muted", "dim", "soft")):
            return "text"
        return None  # accents and data colours: left alone
    if "shadow" in p:
        return "shadow"
    if p.startswith("background"):
        return "bg"
    if p.startswith("border") or p.startswith("outline") or p in ("column-rule", "stroke"):
        return "line"
    if p in ("color", "fill", "caret-color", "text-decoration-color", "-webkit-text-fill-color", "accent-color"):
        return "text"
    return None


DECL = re.compile(r"(?P<prop>--[\w-]+|[a-zA-Z-]+)\s*:\s*(?P<val>[^;{}]+)")


def convert(css):
    out, n = [], 0
    i = 0
    for m in DECL.finditer(css):
        role = role_of(m.group("prop"))
        val = m.group("val")
        if not role or ("#" not in val and "rgb" not in val):
            continue
        def sub_any(mm):  # one pass, so a colour this produced is never mapped twice
            if mm.group("hex"):
                return map_color(role, *parse_hex(mm.group("hex")))
            a = float(mm.group("a")) if mm.group("a") is not None else None
            return map_color(role, int(mm.group("r")), int(mm.group("g")), int(mm.group("b")), a)
        new = ANY.sub(sub_any, val)
        if new != val:
            out.append(css[i:m.start("val")])
            out.append(new)
            i = m.end("val")
            n += 1
    out.append(css[i:])
    return "".join(out), n


for path in sys.argv[1:]:
    src = open(path, encoding="utf-8").read()
    new, n = convert(src)
    open(path, "w", encoding="utf-8", newline="").write(new)
    print(f"{path}: {n} declarations moved to the light palette")
