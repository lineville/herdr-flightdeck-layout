#!/usr/bin/env python3
"""Draws Flight Deck's planets as halftone SVGs: python3 planets/make.py

Every planet is a 400px disc at the centre of its viewBox, shaded with dots lit from the
upper left. A texture function picks each dot's colour from its point on the sphere, so
each world gets its own palette and surface. Rings widen the viewBox; main.js reads that
from PLANETS (keep the two in step).
"""
import math, os, random

OUT = os.path.dirname(os.path.abspath(__file__))
R = 200.0
PITCH_X, PITCH_Y = 8.0, 7.0
LIGHT = (-0.45, 0.5, 0.74)  # x right, y up, z at the camera
_l = math.sqrt(sum(c * c for c in LIGHT))
LIGHT = tuple(c / _l for c in LIGHT)


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgbhex(c):
    return "#%02X%02X%02X" % tuple(max(0, min(255, round(v))) for v in c)


def mix(a, b, t):
    a, b = hexrgb(a) if isinstance(a, str) else a, hexrgb(b) if isinstance(b, str) else b
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def shade(c, k):
    c = hexrgb(c) if isinstance(c, str) else c
    return tuple(v * k for v in c)


class Noise:
    """Smooth 3D value noise with a fixed seed, so the files come out the same every run."""

    def __init__(self, seed):
        rnd = random.Random(seed)
        self.p = list(range(256))
        rnd.shuffle(self.p)
        self.p += self.p
        self.v = [rnd.random() for _ in range(256)]

    def _h(self, x, y, z):
        p = self.p
        return self.v[p[p[p[x & 255] + (y & 255)] + (z & 255)]]

    def raw(self, x, y, z):
        xi, yi, zi = math.floor(x), math.floor(y), math.floor(z)
        xf, yf, zf = x - xi, y - yi, z - zi
        u, v, w = (t * t * (3 - 2 * t) for t in (xf, yf, zf))
        lerp = lambda a, b, t: a + (b - a) * t
        c = [[[self._h(xi + i, yi + j, zi + k) for k in (0, 1)] for j in (0, 1)] for i in (0, 1)]
        x00 = lerp(c[0][0][0], c[1][0][0], u); x10 = lerp(c[0][1][0], c[1][1][0], u)
        x01 = lerp(c[0][0][1], c[1][0][1], u); x11 = lerp(c[0][1][1], c[1][1][1], u)
        return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w)

    def fbm(self, x, y, z, octaves=4):
        s, a, f, n = 0.0, 0.5, 1.0, 0.0
        for _ in range(octaves):
            s += a * self.raw(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2.0
        return s / n


def tilt(p, deg):
    """Turns a surface point about the view axis, so bands and poles lean."""
    a = math.radians(deg)
    x, y, z = p
    return (x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a), z)


# ---- textures: point on the unit sphere (x right, y up, z at camera) -> colour ----------

def gas_giant(pal, seed, lean=0, storm=None, bands=7):
    n = Noise(seed)
    def tex(p):
        x, y, z = tilt(p, lean)
        warp = 0.18 * (n.fbm(x * 2.2, y * 2.2, z * 2.2) - 0.5)
        b = (y + warp) * bands
        band = 0.5 + 0.5 * math.sin(b * math.pi)
        fine = n.fbm(x * 6, y * 18, z * 6)
        col = mix(pal[0], pal[1], band)
        col = mix(col, pal[2], max(0.0, fine - 0.55) * 2.2)
        if storm:
            sx, sy, rx, ry = storm
            d = ((x - sx) / rx) ** 2 + ((y - sy) / ry) ** 2
            if d < 1 and z > 0:
                col = mix(col, pal[3], 1 - d * 0.6)
        return col
    return tex


def terran(pal, seed, sea=0.5, caps=0.82):
    n = Noise(seed)
    def tex(p):
        x, y, z = p
        h = n.fbm(x * 1.8 + 3, y * 1.8, z * 1.8, 5)
        if abs(y) > caps - 0.08 * (h - 0.5):
            return hexrgb(pal[4])
        if h < sea:
            return mix(pal[0], pal[1], (h / sea) ** 2)
        return mix(pal[2], pal[3], (h - sea) / (1 - sea) * 1.6)
    return tex


def cratered(pal, seed, count=40):
    n = Noise(seed)
    rnd = random.Random(seed)
    craters = []
    for _ in range(count):
        u, v = rnd.uniform(-1, 1), rnd.uniform(0, math.tau)
        s = math.sqrt(1 - u * u)
        craters.append(((s * math.cos(v), u, s * math.sin(v)), rnd.uniform(0.06, 0.24)))
    def tex(p):
        h = n.fbm(p[0] * 3, p[1] * 3, p[2] * 3)
        col = mix(pal[0], pal[1], h * 1.3 - 0.15)
        for c, r in craters:
            d = math.dist(p, c) / r
            if d < 0.78:
                col = mix(col, pal[2], 0.85)
            elif d < 1.0:
                col = mix(col, pal[3], 0.75)
        return col
    return tex


def molten(pal, seed):
    n = Noise(seed)
    def tex(p):
        x, y, z = p
        f = n.fbm(x * 2.6, y * 2.6, z * 2.6, 5)
        crack = abs(f - 0.5)
        if crack < 0.035:
            return hexrgb(pal[3])
        if crack < 0.075:
            return mix(pal[2], pal[3], 1 - (crack - 0.035) / 0.04)
        return mix(pal[0], pal[1], n.fbm(x * 7, y * 7, z * 7))
    return tex


def icy(pal, seed):
    n = Noise(seed)
    m = Noise(seed + 9)
    def tex(p):
        x, y, z = p
        col = mix(pal[0], pal[1], n.fbm(x * 2.4, y * 2.4, z * 2.4))
        if abs(m.fbm(x * 4, y * 4, z * 4) - 0.5) < 0.02:
            col = hexrgb(pal[2])  # fractures
        if abs(y) > 0.7:
            col = mix(col, pal[3], (abs(y) - 0.7) * 4)
        return col
    return tex


def swirl(pal, seed, lean=0):
    n = Noise(seed)
    def tex(p):
        x, y, z = tilt(p, lean)
        a = math.atan2(z, x) + 2.6 * y
        s = 0.5 + 0.5 * math.sin(a * 4 + 10 * n.fbm(x * 2, y * 2, z * 2))
        s = s * s * (3 - 2 * s)
        return mix(mix(pal[0], pal[1], s), pal[2], max(0, n.fbm(x * 5, y * 5, z * 5) - 0.5) * 2)
    return tex


def dunes(pal, seed):
    n = Noise(seed)
    def tex(p):
        x, y, z = p
        h = n.fbm(x * 2, y * 2, z * 2)
        ridge = 0.5 + 0.5 * math.sin((x * 9 + y * 4 + 4 * h) * math.pi)
        col = mix(pal[0], pal[1], h * 1.4 - 0.2)
        col = mix(col, pal[2], ridge * 0.35)
        if abs(y) > 0.86:
            col = hexrgb(pal[3])
        return col
    return tex


# ---- drawing ----------------------------------------------------------------------------

def outline_fn(seed, lumpy):
    """The body's edge as radius(angle), 1 for a sphere; lumpy bodies wobble."""
    if not lumpy:
        return lambda a: 1.0
    rnd = random.Random(seed)
    terms = [(k, rnd.uniform(0.02, lumpy) / k ** 0.6, rnd.uniform(0, math.tau)) for k in range(2, 7)]
    raw = lambda a: 1.0 + sum(amp * math.sin(k * a + ph) for k, amp, ph in terms)
    top = max(raw(math.tau * i / 360) for i in range(360))
    return lambda a: raw(a) / top


def body(tex, base, seed, squash=1.0, lumpy=0.0, dmin=0.9, dmax=3.1):
    edge = outline_fn(seed, lumpy)
    out = []
    steps = 160
    pts = []
    for i in range(steps):
        a = math.tau * i / steps
        r = R * edge(a)
        pts.append((R + r * math.cos(a), R - r * math.sin(a) * squash))
    d = "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z"
    rim = rgbhex(shade(base, 2.2))
    out.append(f'<path d="{d}" fill="{rgbhex(shade(base, 0.24))}" stroke="{rim}" stroke-opacity="0.55" stroke-width="2"/>')
    row = 0
    y = PITCH_Y / 2 + 1
    while y < 2 * R:
        x = (PITCH_X / 2 if row % 2 else 0) + 4
        while x < 2 * R:
            dx, dy = (x - R) / R, -(y - R) / (R * squash)
            ang = math.atan2(dy, dx)
            lim = edge(ang)
            rr = math.hypot(dx, dy)
            if rr < lim * 0.985:
                nx, ny = dx / lim, dy / lim
                nz = math.sqrt(max(0.0, 1 - nx * nx - ny * ny))
                p = (nx, ny, nz)
                lit = max(0.0, sum(a * b for a, b in zip(p, LIGHT)))
                lit = lit ** 0.8
                limb = 0.55 + 0.45 * nz
                col = shade(tex(p), 0.42 + 0.72 * lit * limb)
                r = dmin + (dmax - dmin) * lit * (0.75 + 0.25 * limb)
                out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}" fill="{rgbhex(col)}"/>')
            x += PITCH_X
        y += PITCH_Y
        row += 1
    return out


def ring_parts(spec):
    """Back and front halves of a ring set, as elliptical strokes about the centre."""
    rx0, ry_ratio, lean, bands = spec
    back, front = [], []
    for k, (scale_, width, color, alpha) in enumerate(bands):
        rx, ry = R * rx0 * scale_, R * rx0 * scale_ * ry_ratio
        tr = f'transform="rotate({lean} {R} {R})"'
        st = f'fill="none" stroke="{color}" stroke-opacity="{alpha}" stroke-width="{width}"'
        back.append(f'<path d="M{R - rx:.1f} {R:.1f} A{rx:.1f} {ry:.1f} 0 0 1 {R + rx:.1f} {R:.1f}" {tr} {st}/>')
        front.append(f'<path d="M{R + rx:.1f} {R:.1f} A{rx:.1f} {ry:.1f} 0 0 1 {R - rx:.1f} {R:.1f}" {tr} {st}/>')
    return back, front


def write(name, tex, base, seed, squash=1.0, lumpy=0.0, rings=None):
    pad = 0
    back, front = [], []
    if rings:
        back, front = ring_parts(rings)
        pad = math.ceil(R * rings[0] * max(b[0] for b in rings[3]) - R + 8)
    v = f"{-pad} {-pad} {2 * R + 2 * pad:.0f} {2 * R + 2 * pad:.0f}"
    parts = back + body(tex, base, seed, squash, lumpy) + front
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{v}" width="{2 * R + 2 * pad:.0f}" height="{2 * R + 2 * pad:.0f}">' + "".join(parts) + "</svg>"
    with open(os.path.join(OUT, f"{name}.svg"), "w") as f:
        f.write(svg)
    print(f"{name}.svg  extent {(2 * R + 2 * pad) / (2 * R):.3f}  {len(svg) // 1024} KB")


PLANETS = [
    ("jovian", gas_giant(["#C98B55", "#F1DDB8", "#8A4E2E", "#D2553A"], 11, lean=-8, storm=(0.32, -0.28, 0.2, 0.11)), "#C98B55", dict(squash=0.92)),
    ("terran", terran(["#123E8C", "#2F7FD6", "#3E9A4C", "#B9A26A", "#F2F6FA"], 5), "#2F7FD6", {}),
    ("cinder", molten(["#2A1512", "#4A2018", "#E0461C", "#FFC046"], 3), "#E0461C", {}),
    ("glacier", icy(["#5FB2D6", "#E6F6FB", "#1E5F8A", "#FFFFFF"], 21), "#9FD4E8", {}),
    ("saturnine", gas_giant(["#B9A6E0", "#E9DDF7", "#6D57A8", "#FFFFFF"], 8, lean=14, bands=5), "#B9A6E0",
     dict(squash=0.94, rings=(1.42, 0.3, -16, [(1.0, 10, "#D9C98F", 0.9), (1.17, 14, "#B7A672", 0.75), (1.33, 6, "#8E8160", 0.6)]))),
    ("dust", dunes(["#7A2A14", "#E0703A", "#FFC79A", "#FFF3E8"], 17), "#D9784A", {}),
    ("toxic", swirl(["#2F5A14", "#D6E85A", "#F4FFB0"], 13, lean=20), "#9BC23A", {}),
    ("rock", cratered(["#7A746C", "#B8B0A4", "#2E2B28", "#EAE4DA"], 4), "#8A8F95", dict(lumpy=0.05)),
    ("neptune", gas_giant(["#1F3FAF", "#4C8CF0", "#9FC8FF", "#0C1F66"], 31, lean=4, storm=(-0.25, 0.2, 0.16, 0.09), bands=4), "#3A6FE0",
     dict(rings=(1.32, 0.22, 10, [(1.0, 2.5, "#9FC8FF", 0.55), (1.12, 1.5, "#9FC8FF", 0.35)]))),
    ("magenta", swirl(["#7A1F6B", "#F27BC8", "#FFD1EC"], 41, lean=-25), "#C9449E", dict(squash=0.96)),
]

if __name__ == "__main__":
    for name, tex, base, opts in PLANETS:
        write(name, tex, base, sum(map(ord, name)), **opts)
