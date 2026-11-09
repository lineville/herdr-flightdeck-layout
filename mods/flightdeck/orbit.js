// The 3D model behind Flight Deck: orbits, pads, flight paths and the camera.
// World units: the system's planet has radius 1, y is up, +z points at the camera.
// No Herdr imports, so it stays pure.

export const TAU = Math.PI * 2;
export const PAD_R = 1.08; // a landed craft sits just above the surface
export const LAUNCH_MS = 3200;
export const LAND_MS = 3200;

// Context sets the orbit: an empty context flies far out, a full one skims the surface.
export const R_FAR = 4.4;
export const R_NEAR = 1.45;
export const MIN_GAP = 0.24; // the least radial room between two craft, so neither hides the other
const R_LIMIT = R_FAR + 0.6; // spacing may push past the far orbit, but never past this
export const R_RATE = 0.18; // how fast an orbit moves to a new radius, in planet radii per second

const deg = (d) => (d * Math.PI) / 180;
const DEFAULT_PITCH = deg(17);
// Each slot gets its own tilt and its own line of nodes, so two craft at one radius still draw two orbits.
const INCL = [9, -16, 23, -6, 17, -27, 12, -20, 4, -12];
const NODE = [0, 61, 122, 183, 244, 305, 30, 91, 152, 213];
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // spreads start angles evenly, however many craft there are

export const radiusFor = (ctx) => R_FAR - (R_FAR - R_NEAR) * Math.max(0, Math.min(1, ctx ?? 0));

// Kepler's third law: inner orbits are faster.
export const periodFor = (r) => 16000 * Math.pow(r / 1.75, 1.5);

// How open an orbit looks from the default view: 1 is face-on, 0 is edge-on (a line).
const openness = (inc, node) => Math.cos(inc) * Math.sin(DEFAULT_PITCH) + Math.sin(inc) * Math.cos(node) * Math.cos(DEFAULT_PITCH);
const MIN_OPEN = 0.3;

// Each slot keeps its tilt, but tips the other way when it would look edge-on from the default
// view. The two directions' openness adds up to 2·cos(inc)·sin(pitch), so one of them is open enough.
export const shapeOf = (slot) => {
  const node = deg(NODE[slot % NODE.length]);
  let inc = deg(INCL[slot % INCL.length]);
  if (Math.abs(openness(inc, node)) < MIN_OPEN) inc = -inc;
  return { inc, node };
};
export const startAngle = (slot) => (slot * GOLDEN) % TAU;

export const orbitOf = (slot, r) => ({ r, ...shapeOf(slot), period: periodFor(r) });

// A sub-agent's small orbit around its parent craft.
export const moonOrbitOf = (slot) => ({ r: 0.36 + 0.1 * (slot % 3), inc: deg(35 - 20 * (slot % 4)), node: deg(70 * slot), period: 5200 + 900 * (slot % 3) });

// Pushes radii apart so each pair keeps MIN_GAP between them. `wanted` is [{key, r}];
// returns a Map key -> r. Craft keep their order, and the set shifts in when it would pass the limit.
export function spreadRadii(wanted) {
  const list = [...wanted].sort((a, b) => a.r - b.r || String(a.key).localeCompare(String(b.key)));
  const out = list.map((x) => x.r);
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + MIN_GAP);
  const over = out.length ? out[out.length - 1] - R_LIMIT : 0;
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] = Math.max(R_NEAR, out[i] - over);
  for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - MIN_GAP);
  return new Map(list.map((x, i) => [x.key, Math.max(1.25, out[i])]));
}

export const orbitPoint = (o, th) => {
  const x = o.r * Math.cos(th), z = o.r * Math.sin(th);
  const y1 = -z * Math.sin(o.inc), z1 = z * Math.cos(o.inc);
  return [x * Math.cos(o.node) + z1 * Math.sin(o.node), y1, -x * Math.sin(o.node) + z1 * Math.cos(o.node)];
};

// Pads sit on the face of the planet that looks at the camera, in a band left to right.
export const padPoint = (slot) => {
  const lon = deg(-56 + 28 * (slot % 5)), lat = deg(14 - 15 * Math.floor(slot / 5) - (slot % 2) * 6);
  return scale([Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)], PAD_R);
};

// A sub-agent docks beside its parent.
export const moonPadPoint = (slot) => {
  const a = deg(200 + 55 * slot);
  return [0.2 * Math.cos(a), -0.14, 0.2 * Math.sin(a)];
};

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return scale(a, 1 / l); };

const slerp = (a, b, t) => {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const w = Math.acos(dot);
  if (w < 1e-4) return a;
  const s = Math.sin(w);
  return add(scale(a, Math.sin((1 - t) * w) / s), scale(b, Math.sin(t * w) / s));
};

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
export const clamp01 = (t) => Math.max(0, Math.min(1, t));

// From a pad up to an orbit: the heading swings over while the craft climbs fast, then settles.
export const ascent = (pad, target, s) => {
  const r = len(pad) + (len(target) - len(pad)) * easeOut(s);
  return scale(slerp(norm(pad), norm(target), easeInOut(s)), r);
};

// From an orbit down to a pad: the craft keeps its height for longer, then drops.
export const descent = (from, pad, s) => {
  const r = len(from) + (len(pad) - len(from)) * easeIn(s);
  return scale(slerp(norm(from), norm(pad), easeInOut(s)), r);
};

export const DEFAULT_VIEW = { yaw: 0, pitch: DEFAULT_PITCH, zoom: 1 };
export const PITCH_MIN = deg(-75), PITCH_MAX = deg(85);
export const ZOOM_MIN = 0.45, ZOOM_MAX = 2.6;

// The cockpit looks at the system from a little above its plane by default. The frame fits
// the farthest orbit, so the view holds still while orbits move in. `view` is what someone
// dragged and scrolled to: yaw turns the system, pitch tilts it, zoom scales it.
export function camera(w, h, view = DEFAULT_VIEW) {
  const maxR = R_FAR + 0.2;
  const D = Math.max(7, 2.7 * maxR);
  const fit = Math.min((0.46 * w * (D - maxR * 0.5)) / maxR, (0.52 * h * (D - maxR)) / (maxR * Math.sin(DEFAULT_VIEW.pitch) + 0.95));
  const F = Math.max(40, fit) * view.zoom;
  return { cx: w / 2, cy: h * 0.47, F, D, yaw: view.yaw, pitch: view.pitch, planetPx: F / Math.sqrt(D * D - 1) };
}

// World point to screen: x, y in px, depth scale (1 at the planet), and whether it is behind the planet's centre.
export function project(cam, p) {
  const cy = Math.cos(cam.yaw ?? 0), sy = Math.sin(cam.yaw ?? 0);
  const x0 = p[0] * cy + p[2] * sy, z0 = -p[0] * sy + p[2] * cy;
  const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
  const y1 = p[1] * c - z0 * s, z1 = p[1] * s + z0 * c;
  const zc = cam.D - z1;
  const k = cam.F / zc;
  return { x: cam.cx + x0 * k, y: cam.cy - y1 * k, scale: cam.D / zc, behind: z1 < 0 };
}

// An orbit as screen polylines, split into the far half and the near half.
export function orbitPaths(cam, o, steps = 120) {
  const far = [], near = [];
  let run = null, side = null;
  for (let i = 0; i <= steps; i++) {
    const q = project(cam, orbitPoint(o, (i / steps) * TAU));
    const s = q.behind ? "far" : "near";
    if (s !== side) {
      if (run) run.push([q.x, q.y]);
      run = [];
      (s === "far" ? far : near).push(run);
      side = s;
    }
    run.push([q.x, q.y]);
  }
  return { far, near };
}
