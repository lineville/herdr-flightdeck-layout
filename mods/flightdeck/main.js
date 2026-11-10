// Flight Deck: a cockpit view of the fleet. Every space (a repo) is a planet; its agents
// are craft that launch when they start work, orbit while they work, hold when they need
// you, and land when they are done. Orbits are muted gray dotted rings; each craft's tag
// takes its worktree's color, so craft working in one branch share a hue. Sub-agents circle
// their parent.
// Fleet mode lays the planets out on a grid that fits the view; System mode shows one.
// Styled dark and flat: grayscale, one cyan accent (#2EE6FF), IBM Plex Sans and Mono.

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, focused, hc, props, run, settings, shared, spaces, terminals, panes } from "herdr";
import { createDemo } from "./demo.js";
import {
  DEFAULT_VIEW, LAND_MS, LAUNCH_MS, PITCH_MAX, PITCH_MIN, R_RATE, TAU, ZOOM_MAX, ZOOM_MIN, add, ascent, camera, clamp01,
  descent, moonOrbitOf, moonPadPoint, orbitOf, orbitPaths, orbitPoint, padPoint, project, radiusFor, spreadRadii, startAngle,
} from "./orbit.js";
import { modelLook, parseStatusLine } from "./telemetry.js";

const READ_MS = 5000; // how often each agent's status line is read for its model and context

const VIEW_KEY = "flightdeck.view";
const MODE_KEY = "flightdeck.mode";
const DRAG_RAD_PER_PX = 0.008;
const CLICK_SLOP_PX = 4; // a press that moves less than this is still a click on a craft

const store = {
  get(key, ok, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) ?? "null"); if (ok(v)) return v; } catch {}
    return fallback;
  },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} },
};
const loadView = () => store.get(VIEW_KEY, (v) => v && [v.yaw, v.pitch, v.zoom].every(Number.isFinite), { ...DEFAULT_VIEW });
const saveView = (v) => store.set(VIEW_KEY, v);

const MANIFEST_KEY = "flightdeck.manifest";
const MANIFEST_HEAD = 32; // the header: all that shows when collapsed
const MANIFEST_SNAP = 64; // dragged shorter than this, it collapses
const MANIFEST_MIN_OPEN = 76; // open, it shows at least the header and one row
const loadManifest = () => store.get(MANIFEST_KEY, (m) => m && typeof m.collapsed === "boolean" && (m.height == null || Number.isFinite(m.height)), { collapsed: false, height: null });
const saveManifest = (m) => store.set(MANIFEST_KEY, m);

const ASSET = "mods/flightdeck";
const SANS = "IBM Plex Sans";
const MONO = "IBM Plex Mono";

const C = {
  bg: "#000000", surface: "#121212", surface2: "#1f1f1f", surface3: "#272825",
  fg: "#edefea", fg2: "#b3b5b0", fg3: "#7b7c79", hairline: "#222222", border: "#4b4c4a", borderActive: "#eeefec",
  gray80: "#353534", accent: "#2ee6ff",
  success: "#5bd65f", successBg: "#66ff6949", warning: "#ff844d", warningBg: "#ff530e4a",
  neutral: "#b3b5b0", neutralBg: "#fffffa30", advisory: "#ffca42",
};

// Fallback orbit hues, for craft whose worktree isn't known (the demo, another layout).
const ORBIT_HUES = ["#8cabff", "#58d6b5", "#f257a5", "#b061ff", "#d9c27a", "#c0c4ff"];
const orbitHue = (slot) => ORBIT_HUES[slot % ORBIT_HUES.length];
// Space colors, the same as the sidebar's avatars.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const ORBIT_GRAY = C.fg2; // orbits stay neutral so they don't compete with the craft
const ORBIT_NEAR_ALPHA = "8c"; // 55%
const ORBIT_FAR_ALPHA = "4d"; // 30%
const ORBIT_DOTS = [1.5, 5];
// Only craft in flight draw their orbit; descending, landed and docked craft don't.
const IN_FLIGHT = new Set(["launch", "orbit", "hold"]);

const HUD_H = 40;
const EDGE = 16; // inset of the cockpit readouts, matching the top bar's padding
const ROW_H = 34;
const HEAD_H = 24;
const FAST_MS = 220; // ticks while a craft launches or lands
const SLOW_MS = 700; // ticks while craft only orbit

const STATUS = {
  working: { badge: "In orbit", text: C.neutral, bg: C.neutralBg, mark: C.accent },
  blocked: { badge: "Needs you", text: C.warning, bg: C.warningBg, mark: C.warning },
  done: { badge: "Landed", text: C.success, bg: C.successBg, mark: C.success },
  idle: { badge: "Docked", text: C.neutral, bg: C.neutralBg, mark: C.neutral },
};

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
};

const mono = (size, color, weight = 400) => div().font_family(MONO).font_weight(weight).text_size(size).text_color(color).whitespace_nowrap();
const sans = (size, color, weight = 400) => div().font_family(SANS).font_weight(weight).text_size(size).text_color(color).whitespace_nowrap();
const base = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();

// Pi's session name from its title ("π - <name> - <folder>"), or null.
function piName(title, cwd) {
  const m = /^π\s+-\s+(.*)$/.exec((title ?? "").trim());
  if (!m) return null;
  const folder = base(cwd);
  let rest = m[1];
  if (folder && rest === folder) return null;
  if (folder && rest.endsWith(` - ${folder}`)) rest = rest.slice(0, -(folder.length + 3));
  return rest || null;
}

// Cells for n planets in a w×h view: the column count that gives each system the most room.
// A system is about 1.45 times as wide as it is tall. The last row is centered.
export function grid(n, w, h) {
  if (n <= 1) return [{ x: 0, y: 0, w, h }];
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const score = Math.min(w / cols, (h / rows) * 1.45);
    if (!best || score > best.score) best = { cols, rows, score };
  }
  const cw = w / best.cols, ch = h / best.rows;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / best.cols), c = i % best.cols;
    const inRow = r === best.rows - 1 ? n - r * best.cols : best.cols;
    return { x: c * cw + ((best.cols - inRow) * cw) / 2, y: r * ch, w: cw, h: ch };
  });
}

export default class FlightDeck extends View {
  init(_props, cx) {
    const speedProp = Number((props() ?? {}).speed);
    this.speed = speedProp > 0 && speedProp <= 1 ? speedProp : 1;
    const t0 = Date.now();
    this.clock = () => t0 + (Date.now() - t0) * this.speed;
    this.size = null;
    this.craft = new Map(); // address -> craft state, kept across systems
    this.frame = new Map(); // address -> where the craft is drawn now
    this.cams = new Map(); // space id -> its camera, in cockpit pixels
    this.cells = [];
    this.view = null; // System mode: a system picked by hand; null follows the shown space
    this.mode = store.get(MODE_KEY, (m) => m === "fleet" || m === "system", "fleet");
    this.hover = null;
    this.dur = SLOW_MS;
    this.orbitCache = null;
    this.look = loadView();
    this.press = null;
    this.dragged = false;
    this.manifest_ = loadManifest();
    this.resizing = null;
    this.telemetry = new Map(); // address -> { ctx 0..1, model }
    const p = props() ?? {};
    this.demo = p.demo ? createDemo(this.clock, Number(p.demoStart) || 0) : null;
    this.src = this.demo ?? { agents, spaces, terminals, focused };
    const frameMs = Number(p.fps) > 0 ? Math.max(33, Math.round(1000 / Number(p.fps))) : 0;
    this.fastMs = frameMs || FAST_MS;
    this.slowMs = frameMs || SLOW_MS;
    if (this.demo) {
      cx.spawn(async (cx) => {
        for (;;) {
          this.telemetry = this.demo.telemetry();
          this.wake?.();
          cx.notify();
          await cx.sleep(250);
        }
      });
    }
    // Reads the shown systems' agents one at a time. A status line that doesn't show (a dialog
    // over it) keeps the last reading.
    if (!this.demo) cx.spawn(async (cx) => {
      for (;;) {
        const ids = new Set(this.shown().map((s) => s.id));
        let changed = false;
        for (const a of this.src.agents().filter((x) => ids.has(x.space))) {
          try {
            const res = await hc(["read", a.address, "--lines", "16"]);
            const got = parseStatusLine(res?.stdout);
            if (!got) continue;
            const old = this.telemetry.get(a.address);
            const next = { ctx: got.ctx, model: got.model ?? old?.model ?? null };
            if (!old || old.ctx !== next.ctx || old.model !== next.model) { this.telemetry.set(a.address, next); changed = true; }
          } catch {}
        }
        if (changed) { this.wake?.(); cx.notify(); }
        await cx.sleep(READ_MS);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const step = this.step();
        if (step) {
          this.place(this.clock() + step * this.speed, step);
          cx.notify();
          await Promise.race([cx.sleep(step), new Promise((wake) => { this.wake = wake; })]);
        } else {
          await Promise.race([cx.sleep(5000), new Promise((wake) => { this.wake = wake; })]);
        }
      }
    });
  }

  // ---- model ------------------------------------------------------------------------

  systemId() {
    const all = this.src.spaces();
    if (this.view && all.some((s) => s.id === this.view)) return this.view;
    return this.src.focused()?.space ?? all.find((s) => s.active)?.id ?? all[0]?.id ?? null;
  }

  // The systems on screen: every space in Fleet mode, one in System mode.
  shown() {
    const all = this.src.spaces();
    if (this.mode === "fleet" && !this.demo) return all;
    const id = this.systemId();
    return all.filter((s) => s.id === id);
  }

  setMode(mode, view, cx) {
    this.mode = mode;
    this.view = view ?? null;
    store.set(MODE_KEY, mode);
    this.orbitCache = null;
    this.place(this.clock(), 0);
    this.wake?.();
    cx.notify();
  }

  // An agent's worktree from the sidebar's tree: { path, branch, color }, or null.
  worktree(a) {
    if (!a?.pane) return null;
    const tree = shared("deck.tree");
    const path = tree?.panes?.[a.pane];
    return path ? { path, ...tree.worktrees?.[path] } : null;
  }

  hue(c) {
    return this.worktree(this.agentBy?.get(c.address))?.color ?? orbitHue(c.slot);
  }

  spaceColor(id) {
    const c = (shared("space.colors") ?? {})[id] ?? "ansi6";
    return c.startsWith("#") ? c : MARK[c] ?? C.fg3;
  }

  sync(list) {
    const now = this.clock();
    const parents = new Map(this.src.terminals().map((t) => [t.address, t.parent ?? null]));
    const here = new Set(list.map((a) => a.address));
    const live = new Set(this.src.agents().map((a) => a.address));
    let changed = false;
    for (const address of [...this.craft.keys()]) {
      if (!live.has(address)) { this.craft.delete(address); this.frame.delete(address); changed = true; }
    }
    const used = new Map(); // anchor -> taken slots
    for (const c of this.craft.values()) {
      const key = c.parent ?? `space:${c.space}`;
      if (!used.has(key)) used.set(key, new Set());
      used.get(key).add(c.slot);
    }
    const freeSlot = (key) => {
      const taken = used.get(key) ?? new Set();
      let s = 0;
      while (taken.has(s)) s++;
      taken.add(s);
      used.set(key, taken);
      return s;
    };
    list.forEach((a, i) => {
      const parent = parents.get(a.address);
      const parentHere = parent && here.has(parent) ? parent : null;
      let c = this.craft.get(a.address);
      if (!c || c.parent !== parentHere || c.space !== a.space) {
        const slot = freeSlot(parentHere ?? `space:${a.space}`);
        const launch = a.status === "working" || a.status === "blocked";
        const r = radiusFor(this.telemetry.get(a.address)?.ctx ?? 0);
        c = { address: a.address, space: a.space, parent: parentHere, slot, status: a.status, shown: false,
          phase: launch ? "launch" : "parked", t0: now + i * 650, theta: startAngle(slot), thetaAt: now, r, rGoal: r, rAt: now };
        if (a.status === "blocked") c.holdAfterLaunch = true;
        this.craft.set(a.address, c);
        changed = true;
        return;
      }
      if (c.status === a.status) return;
      const was = c.status;
      c.status = a.status;
      changed = true;
      const flying = c.phase === "launch" || c.phase === "orbit" || c.phase === "hold";
      if (a.status === "working") {
        if (c.phase === "hold") { c.theta = c.holdTheta; c.thetaAt = now; c.phase = "orbit"; }
        else if (!flying) { c.from = this.worldAt(c, now); c.r = c.rGoal; c.phase = "launch"; c.t0 = now; }
      } else if (a.status === "blocked") {
        if (flying) { c.holdTheta = this.angleAt(c, now); c.phase = "hold"; }
        else { c.from = this.worldAt(c, now); c.r = c.rGoal; c.phase = "launch"; c.t0 = now; c.holdAfterLaunch = true; }
      } else if (flying || c.phase === "land") {
        if (was === "working" || was === "blocked") { c.from = this.worldAt(c, now); c.phase = "land"; c.t0 = now; }
      }
    });
    if (changed) { this.place(this.clock(), 300); this.wake?.(); }
  }

  orbit(c) {
    return c.parent ? moonOrbitOf(c.slot) : orbitOf(c.slot, c.r);
  }

  advance(c, now) {
    if (c.phase === "orbit") { c.theta = this.angleAt(c, now); c.thetaAt = now; }
    if (c.phase === "orbit" || c.phase === "hold") {
      const step = (R_RATE * Math.max(0, now - (c.rAt ?? now))) / 1000;
      c.r += Math.max(-step, Math.min(step, c.rGoal - c.r));
    } else if (c.phase === "parked") {
      c.r = c.rGoal;
    }
    c.rAt = now;
  }

  anchor(c, t) {
    const p = c.parent && this.craft.get(c.parent);
    return p ? this.worldAt(p, t) : [0, 0, 0];
  }

  pad(c) {
    return c.parent ? moonPadPoint(c.slot) : padPoint(c.slot);
  }

  angleAt(c, t) {
    if (c.phase === "hold") return c.holdTheta;
    if (c.phase === "launch") return c.theta;
    return c.theta + (TAU * (t - c.thetaAt)) / this.orbit(c).period;
  }

  worldAt(c, t) {
    const o = this.orbit(c);
    const base = this.anchor(c, t);
    if (c.phase === "parked") return add(base, this.pad(c));
    if (c.phase === "hold") return add(base, orbitPoint(o, c.holdTheta));
    if (c.phase === "launch") {
      const s = clamp01((t - c.t0) / LAUNCH_MS);
      if (t >= c.t0 + LAUNCH_MS) {
        c.phase = c.holdAfterLaunch ? "hold" : "orbit";
        if (c.holdAfterLaunch) c.holdTheta = c.theta;
        c.holdAfterLaunch = false;
        c.thetaAt = c.t0 + LAUNCH_MS;
        c.rAt = c.thetaAt;
        return this.worldAt(c, t);
      }
      const start = c.from ? add(c.from, [-base[0], -base[1], -base[2]]) : this.pad(c);
      return add(base, ascent(start, orbitPoint(o, c.theta), s));
    }
    if (c.phase === "land") {
      if (t >= c.t0 + LAND_MS) { c.phase = "parked"; c.from = null; return add(base, this.pad(c)); }
      const from = add(c.from, [-base[0], -base[1], -base[2]]);
      return add(base, descent(from, this.pad(c), clamp01((t - c.t0) / LAND_MS)));
    }
    return add(base, orbitPoint(o, this.angleAt(c, t)));
  }

  step() {
    const ids = new Set(this.shown().map((s) => s.id));
    let orbiting = false;
    for (const c of this.craft.values()) {
      if (!ids.has(c.space)) continue;
      if (c.phase === "launch" || c.phase === "land") return this.fastMs;
      if (c.phase === "orbit") orbiting = true;
    }
    return orbiting ? this.slowMs : 0;
  }

  // Lays the systems out, then works out each craft's next spot. Each one glides there over `dur`.
  place(t, dur) {
    if (this.press) { t = this.clock(); dur = 0; }
    this.dur = dur;
    this.now = this.clock();
    if (!this.size) return;
    const vp = this.viewport();
    const shown = this.shown();
    this.cells = grid(shown.length, vp.w, vp.h).map((cell, i) => ({ ...cell, space: shown[i] }));
    this.cams = new Map();
    const many = this.cells.length > 1;
    for (const cell of this.cells) {
      const cam = camera(cell.w, cell.h, this.look);
      cam.cx += cell.x;
      cam.cy += cell.y;
      this.cams.set(cell.space.id, cam);
      const tops = [...this.craft.values()].filter((c) => c.space === cell.space.id && !c.parent);
      const goals = spreadRadii(tops.map((c) => ({ key: c.address, r: radiusFor(this.telemetry.get(c.address)?.ctx ?? 0) })));
      for (const c of tops) { c.rGoal = goals.get(c.address) ?? c.rGoal; this.advance(c, this.now); }
    }
    this.cam = this.cams.get(shown[0]?.id) ?? camera(vp.w, vp.h, this.look);
    const crafted = new Map(this.src.agents().map((a) => [a.address, a]));
    for (const c of this.craft.values()) {
      const cam = this.cams.get(c.space);
      if (!cam) continue;
      const q = project(cam, this.worldAt(c, c.shown ? t : this.now));
      const a = crafted.get(c.address);
      const look = modelLook(this.telemetry.get(c.address)?.model, a?.app ?? a?.program?.key);
      const least = many ? 10 : 14;
      const size = c.parent ? (many ? 9 : 12) : Math.max(least, Math.min(30, cam.planetPx * 0.2)) * look.size;
      const s = Math.round(size * q.scale);
      const off = Math.hypot(q.x - cam.cx, q.y - cam.cy);
      const hidden = q.behind && off < cam.planetPx + s * 0.2;
      this.frame.set(c.address, { x: q.x, y: q.y, s, opacity: hidden ? 0 : q.behind ? 0.55 : 1 });
    }
  }

  viewport() {
    const { width: w, height: h } = this.size;
    return { w, h: Math.max(120, h - HUD_H - this.consoleH(h)) };
  }

  consoleH(h) {
    const most = Math.max(MANIFEST_HEAD, h - HUD_H - 120);
    if (this.manifest_.collapsed) return MANIFEST_HEAD;
    if (this.manifest_.height != null) return Math.round(Math.min(Math.max(this.manifest_.height, MANIFEST_MIN_OPEN), most));
    const rows = this.rows ?? [];
    const px = rows.reduce((sum, r) => sum + (r.kind === "agent" ? ROW_H : HEAD_H), 0);
    return Math.round(Math.min(Math.max(44 + px, 112), h * 0.36, most));
  }

  resizeTo(y) {
    const r = this.resizing;
    const want = r.h0 - (y - r.y0);
    this.manifest_ = want < MANIFEST_SNAP ? { ...this.manifest_, collapsed: true } : { collapsed: false, height: want };
    this.place(this.clock(), 0);
  }

  endResize(cx) {
    if (!this.resizing) return;
    this.resizing = null;
    saveManifest(this.manifest_);
    cx.notify();
  }

  // The manifest's rows: per system (when there are several), per worktree, its agents
  // with their sub-agents.
  buildRows(shown, list) {
    const rows = [];
    const tree = shared("deck.tree");
    let n = 0;
    for (const s of shown) {
      const mine = list.filter((a) => a.space === s.id);
      if (shown.length > 1) rows.push({ kind: "space", s, count: mine.length });
      const tops = mine.filter((a) => !this.craft.get(a.address)?.parent);
      const order = tree?.spaces?.[s.id] ?? [];
      const groups = new Map();
      for (const a of tops) {
        const wt = this.worktree(a);
        const key = wt?.path ?? "";
        if (!groups.has(key)) groups.set(key, { wt, agents: [] });
        groups.get(key).agents.push(a);
      }
      const keys = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
      for (const key of keys) {
        const g = groups.get(key);
        if (g.wt) rows.push({ kind: "worktree", wt: g.wt, count: g.agents.length });
        for (const a of g.agents) {
          rows.push({ kind: "agent", a, n: ++n });
          for (const b of mine.filter((x) => this.craft.get(x.address)?.parent === a.address)) rows.push({ kind: "agent", a: b, n: ++n, sub: true });
        }
      }
    }
    return rows;
  }

  // ---- render -----------------------------------------------------------------------

  render() {
    const shown = this.shown();
    const ids = new Set(shown.map((s) => s.id));
    const list = this.src.agents().filter((a) => ids.has(a.space));
    this.agentBy = new Map(list.map((a) => [a.address, a]));
    this.cwd = new Map((this.demo ? [] : panes()).map((p) => [p.pane, p.cwd]));
    this.sync(list);
    this.rows = this.buildRows(shown, list);
    const tabs = new Map(shown.flatMap((s) => s.tabs ?? []).map((t) => [t.id, t]));

    const root = v_flex().id("root").size_full().bg(C.bg).overflow_hidden()
      .when(Boolean(this.resizing), (el) => el.cursor_row_resize())
      .on_mouse_move((e, cx) => {
        if (!this.resizing) return;
        const z = Number(settings()?.zoom) || 1;
        this.resizeTo(e.position.y / z);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => this.endResize(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endResize(cx); })
      .on_size_change((size, cx) => {
        const z = Number(settings()?.zoom) || 1;
        this.size = { width: size.width / z, height: size.height / z };
        this.orbitCache = null;
        this.place(this.clock(), 0);
        cx.notify();
      });
    if (!this.size) return root;
    if (!this.cams.size && shown.length) this.place(this.clock(), 0);
    const vp = this.viewport();

    return root
      .child(this.hud(shown, list))
      .child(this.cockpit(vp, shown, list, tabs))
      .child(this.manifest(list, tabs));
  }

  hud(shown, list) {
    const width = this.size?.width ?? 0;
    const tight = width < 620;
    const count = (s) => list.filter((a) => a.status === s).length;
    const stat = (n, label, color) => h_flex().gap(6).items_center()
      .child(div().w(6).h(6).bg(n ? color : C.border))
      .child(mono(11, n ? C.fg2 : C.fg3, 500).child(tight ? String(n) : `${n} ${label}`));
    const fleet = this.mode === "fleet" && !this.demo;
    const system = !fleet ? shown[0] ?? null : null;
    const following = !this.view || this.view === this.src.focused()?.space;
    const others = this.src.spaces().filter((s) => s.id !== system?.id);
    const chip = (s) => h_flex().id(`sys-${s.id}`).h(24).px(8).gap(6).items_center().rounded(4).border(1).border_color(C.hairline).cursor_pointer()
      .hover((st) => st.bg(C.surface2).border_color(C.border))
      .on_click((_e, cx) => this.setMode("system", s.id, cx))
      .child(div().w(6).h(6).bg(this.spaceColor(s.id)))
      .child(mono(10.5, C.fg2, 500).child(s.name.toUpperCase()))
      .when(s.status != null, (el) => el.child(div().w(6).h(6).bg(STATUS[s.status]?.mark ?? C.border)));
    const seg = (mode, label) => h_flex().id(`mode-${mode}`).h(22).px(8).items_center().cursor_pointer()
      .when(this.mode === mode, (el) => el.bg(C.surface3))
      .hover((st) => st.bg(C.surface2))
      .on_click((_e, cx) => this.setMode(mode, null, cx))
      .child(mono(10, this.mode === mode ? C.fg : C.fg3, 600).child(label));
    const title = fleet ? `FLEET · ${shown.length} ${shown.length === 1 ? "SYSTEM" : "SYSTEMS"}` : (system?.name ?? "NO SYSTEM").toUpperCase();
    return h_flex().h(HUD_H).flex_none().px(16).gap(12).items_center().justify_between().border_b(1).border_color(C.hairline).bg(C.bg)
      .child(h_flex().gap(10).items_center().min_w(0).overflow_hidden()
        .child(div().w(8).h(8).bg(C.accent).flex_none())
        .when(!tight, (el) => el.child(mono(12, C.fg, 600).child("FLIGHT DECK")).child(mono(12, C.fg3).child("//")))
        .child(mono(12, C.fg2, 500).truncate().child(title))
        .when(Boolean(this.demo), (el) => el.child(h_flex().h(20).px(6).items_center().rounded(4).border(1).border_color(C.border).flex_none()
          .child(mono(10, C.fg3, 600).child("DEMO DATA"))))
        .when(!fleet && !following, (el) => el.child(h_flex().id("follow").h(24).px(8).items_center().rounded(4).border(1).border_color(C.accent).cursor_pointer()
          .hover((st) => st.bg(C.surface2))
          .on_click((_e, cx) => this.setMode("system", null, cx))
          .child(mono(10.5, C.accent, 600).child("RETURN"))))
        .when(!fleet && others.length > 0 && width >= 820, (el) => el.child(div().w(1).h(16).bg(C.hairline).flex_none()).child(h_flex().gap(6).children(others.slice(0, 4).map(chip)))))
      .child(h_flex().gap(14).flex_none().items_center()
        .child(stat(count("working"), "IN ORBIT", C.accent))
        .child(stat(count("blocked"), "HOLDING", C.warning))
        .child(stat(count("done") + count("idle"), "LANDED", C.success))
        .when(!this.demo, (el) => el.child(h_flex().rounded(4).border(1).border_color(C.border).overflow_hidden()
          .child(seg("fleet", "FLEET")).child(seg("system", "SYSTEM")))));
  }

  cockpit(vp, shown, list, tabs) {
    const { yaw, pitch, zoom } = this.look;
    const tops = [...this.craft.values()].filter((c) => this.cams.has(c.space) && !c.parent && IN_FLIGHT.has(c.phase));
    const key = `${vp.w}x${vp.h}:${yaw}:${pitch}:${zoom}:${this.cells.map((c) => `${c.space.id}@${c.x},${c.y},${c.w},${c.h}`).join("|")}:${tops.map((c) => `${c.space}/${c.slot}@${c.r.toFixed(2)}`).sort().join(",")}`;
    if (!this.orbitCache || this.orbitCache.key !== key) {
      const build = (runs) => runs.filter((r) => r.length > 1).map((r) => {
        let path = PathBuilder.stroke(this.cells.length > 1 ? 1.2 : 1.5).dash_array(ORBIT_DOTS).move_to(r[0][0], r[0][1]);
        for (const pt of r.slice(1)) path = path.line_to(pt[0], pt[1]);
        return path.build();
      });
      const rings = tops.map((c) => {
        const p = orbitPaths(this.cams.get(c.space), orbitOf(c.slot, c.r));
        return { far: build(p.far), near: build(p.near), farColor: `${ORBIT_GRAY}${ORBIT_FAR_ALPHA}`, nearColor: `${ORBIT_GRAY}${ORBIT_NEAR_ALPHA}` };
      });
      this.orbitCache = { key, rings };
    }
    const layer = (path, color) => (path ? window.paint_path(path, color).absolute().left(0).top(0).w(vp.w).h(vp.h) : null);
    const farRings = this.orbitCache.rings.flatMap((r) => r.far.map((p) => layer(p, r.farColor)));
    const nearRings = this.orbitCache.rings.flatMap((r) => r.near.map((p) => layer(p, r.nearColor)));
    const starSide = Math.max(vp.w, vp.h);
    const bodies = this.rows.filter((r) => r.kind === "agent").map((r) => this.body(r.a, tabs)).filter(Boolean);
    const moved = Math.abs(yaw - DEFAULT_VIEW.yaw) > 1e-3 || Math.abs(pitch - DEFAULT_VIEW.pitch) > 1e-3 || Math.abs(zoom - DEFAULT_VIEW.zoom) > 1e-3;

    return div().id("cockpit").relative().w(vp.w).h(vp.h).flex_none().overflow_hidden().bg(C.bg)
      .when(Boolean(this.press), (el) => el.cursor_grabbing())
      .when(!this.press, (el) => el.cursor_grab())
      .on_mouse_down("left", (e, cx) => {
        this.press = { x: e.position.x, y: e.position.y, yaw: this.look.yaw, pitch: this.look.pitch };
        this.dragged = false;
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.press) return;
        const dx = e.position.x - this.press.x, dy = e.position.y - this.press.y;
        if (Math.hypot(dx, dy) > CLICK_SLOP_PX) this.dragged = true;
        if (!this.dragged) return;
        this.look = {
          ...this.look,
          yaw: this.press.yaw + dx * DRAG_RAD_PER_PX,
          pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.press.pitch + dy * DRAG_RAD_PER_PX)),
        };
        this.place(this.clock(), 0);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_hover((hovered, cx) => { if (!hovered && this.press) this.endDrag(cx); })
      .on_scroll_wheel((e, cx) => {
        const dy = Math.max(-60, Math.min(60, e.delta.y));
        this.look = { ...this.look, zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.look.zoom * Math.exp(-dy * 0.004))) };
        saveView(this.look);
        this.place(this.clock(), 0);
        cx.notify();
      })
      .child(image(`${ASSET}/stars.svg`).absolute().left((vp.w - starSide) / 2).top((vp.h - starSide) / 2).w(starSide).h(starSide))
      .children(farRings)
      .children(this.cells.flatMap((cell) => this.planet(cell, list)))
      .children(nearRings)
      .children(bodies)
      .child(this.readout(vp, shown, list))
      .child(this.viewControls(vp, moved))
      .when(shown.length === 0, (el) => el.child(v_flex().absolute().left(0).w(vp.w).top(vp.h / 2 - 20).items_center().gap(4)
        .child(mono(11, C.fg2, 600).child("NO SYSTEMS"))
        .child(sans(13, C.fg3).child("Open a repo as a space to start one."))))
      .when(shown.length === 1 && list.length === 0, (el) => el.child(v_flex().absolute().left(0).w(vp.w).top(this.cam.cy + this.cam.planetPx + 18).items_center().gap(4)
        .child(mono(11, C.fg2, 600).child("NO CREW IN THIS SYSTEM"))
        .child(sans(13, C.fg3).child("Start an agent in this space to launch it."))));
  }

  // One system's planet: its atmosphere in the space's color, a reticle on the shown space,
  // and its name under it. Click selects the space; a double-click opens it in System mode.
  planet(cell, list) {
    const cam = this.cams.get(cell.space.id);
    if (!cam) return [];
    const s = cell.space;
    const d = cam.planetPx * 2;
    const color = this.spaceColor(s.id);
    const active = s.id === this.src.focused()?.space;
    const fleet = this.cells.length > 1;
    const crew = list.filter((a) => a.space === s.id).length;
    const atmo = d + Math.max(6, d * 0.08);
    const out = [
      div().absolute().left(cam.cx - atmo / 2).top(cam.cy - atmo / 2).w(atmo).h(atmo).rounded(atmo / 2)
        .border(active ? 2 : 1).border_color(`${color}${active ? "cc" : "55"}`).bg(`${color}14`),
      image(`${ASSET}/globe.svg`).absolute().left(cam.cx - d / 2).top(cam.cy - d / 2).w(d).h(d),
    ];
    if (fleet && active) {
      // Thin corner brackets around the shown space's planet.
      const r = atmo + 14, arm = Math.max(6, Math.min(14, r * 0.18)), x0 = cam.cx - r / 2, y0 = cam.cy - r / 2;
      const corner = (left, topSide) => {
        let el = div().absolute().w(arm).h(arm).border_color(C.accent)
          .left(left ? x0 : x0 + r - arm).top(topSide ? y0 : y0 + r - arm);
        el = topSide ? el.border_t(1.5) : el.border_b(1.5);
        return left ? el.border_l(1.5) : el.border_r(1.5);
      };
      out.push(corner(true, true), corner(false, true), corner(true, false), corner(false, false));
    }
    if (fleet) {
      out.push(div().id(`planet-${s.id}`).absolute().left(cam.cx - d / 2).top(cam.cy - d / 2).w(d).h(d).rounded(d / 2).cursor_pointer()
        .on_click((e, cx) => {
          if (this.dragged || this.demo) return;
          if (e.click_count === 2) this.setMode("system", s.id, cx);
          else run("space.select", { id: s.id });
        }));
      const worst = ["blocked", "working", "done"].find((st) => list.some((a) => a.space === s.id && a.status === st));
      out.push(h_flex().absolute().left(cell.x).w(cell.w).top(Math.min(cam.cy + atmo / 2 + 8, cell.y + cell.h - 40)).justify_center()
        .child(h_flex().id(`planet-tag-${s.id}`).h(20).px(6).gap(6).items_center().rounded(3).bg("#000000cc").cursor_pointer()
          .when(active, (el) => el.border(1).border_color(C.accent))
          .on_click((_e, cx) => { if (!this.dragged) run("space.select", { id: s.id }); cx.notify(); })
          .child(div().w(7).h(7).bg(color))
          .child(mono(10.5, active ? C.fg : C.fg2, 600).child(s.name.toUpperCase()))
          .child(mono(10, C.fg3, 500).child(`${crew}`))
          .when(Boolean(worst), (el) => el.child(div().w(6).h(6).bg(STATUS[worst].mark)))));
    }
    return out;
  }

  endDrag(cx) {
    if (!this.press) return;
    this.press = null;
    saveView(this.look);
    this.wake?.();
    cx.notify();
  }

  viewControls(vp, moved) {
    const fleet = this.cells.length > 1;
    return h_flex().absolute().left(EDGE).bottom(EDGE).gap(10).items_center()
      .when(vp.w >= 480, (el) => el.child(mono(10, C.fg3, 500).child(fleet ? "DRAG TO TURN · SCROLL TO ZOOM · DOUBLE-CLICK A PLANET" : "DRAG TO TURN · SCROLL TO ZOOM")))
      .when(moved, (el) => el.child(h_flex().id("reset-view").h(22).px(8).items_center().rounded(4).border(1).border_color(C.border).bg(C.bg).cursor_pointer()
        .hover((st) => st.bg(C.surface2).border_color(C.borderActive))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          this.look = { ...DEFAULT_VIEW };
          saveView(this.look);
          this.place(this.clock(), 400);
          cx.notify();
        })
        .child(mono(10, C.fg2, 600).child("RESET VIEW"))));
  }

  readout(vp, shown, list) {
    const tabs = shown.flatMap((s) => s.tabs ?? []);
    const longest = list.reduce((m, a) => {
      const since = tabs.find((t) => t.id === a.tab)?.working_since;
      return a.status === "working" && since ? Math.max(m, (this.now ?? this.clock()) - since) : m;
    }, 0);
    const corner = (lines, left) => v_flex().absolute().top(EDGE).gap(2)
      .when(left, (el) => el.left(EDGE)).when(!left, (el) => el.right(EDGE).items_end())
      .children(lines.map(([t, c]) => mono(10, c, 500).child(t)));
    const worktrees = new Set(list.map((a) => this.worktree(a)?.path).filter(Boolean)).size;
    const system = shown[0];
    const left = this.cells.length > 1
      ? [[`SYSTEMS ${shown.length}`, C.fg3], [`WORKTREES ${worktrees}`, C.fg3]]
      : [[`SYS ${(system?.name ?? "").toUpperCase()}`, C.fg3], [`WT  ${worktrees}`, C.fg3]];
    return div().absolute().left(0).top(0).w(vp.w).h(vp.h)
      .child(corner(left, true))
      .child(corner([[`CREW ${list.length}`, C.fg3], [longest ? `T+${clock(longest)}` : "T+--:--", longest ? C.fg2 : C.fg3]], false));
  }

  label(a, tabs) {
    const session = piName(a.title, this.cwd?.get(a.pane));
    if (session) return session;
    if (/^π\s+-/.test(a.title ?? "")) return a.program?.name ?? "Pi";
    if (this.craft.get(a.address)?.parent) return (a.title || a.program?.name || a.address).trim();
    const tab = tabs.get(a.tab);
    const named = tab?.named && !/^\d+$/.test(tab.name) && tab.name !== this.worktree(a)?.branch;
    return (named ? tab.name : (a.title ?? "").replace(/^π\s+-\s+/, "") || a.program?.name || a.address).trim();
  }

  flightWord(a, c, tabs) {
    if (c.phase === "launch") return ["LAUNCH", C.accent];
    if (c.phase === "land") return ["DESCENT", C.fg2];
    if (a.status === "working") {
      const since = tabs.get(a.tab)?.working_since;
      return [since ? `ORBIT T+${clock((this.now ?? this.clock()) - since)}` : "ORBIT", C.accent];
    }
    if (a.status === "blocked") return ["HOLD · NEEDS YOU", C.warning];
    if (a.status === "done") return ["LANDED", C.success];
    return ["DOCKED", C.fg3];
  }

  meta(tel) {
    const model = tel?.model ? tel.model.toUpperCase() : "MODEL --";
    const ctx = tel?.ctx != null ? `CTX ${Math.round(tel.ctx * 100)}%` : "CTX --";
    return `${model} · ${ctx}`;
  }

  body(a, tabs) {
    const c = this.craft.get(a.address);
    const f = c && this.frame.get(a.address);
    if (!f || !this.cams.has(c.space)) return null;
    c.shown = true;
    const dur = { duration: this.dur, easing: "linear" };
    const box = f.s + 10;
    const tel = this.telemetry.get(a.address);
    const glyph = c.parent ? "sat" : modelLook(tel?.model, a.app ?? a.program?.key).glyph;
    const lit = this.hover === a.address || a.focused;
    let ring;
    if (c.phase === "launch" || c.phase === "orbit") {
      ring = svg(`${ASSET}/arc.svg`).absolute().left(0).top(0).size_full().text_color(C.accent).spin(1400 / this.speed);
    } else if (c.phase === "hold") {
      ring = svg(`${ASSET}/ring.svg`).absolute().left(0).top(0).size_full().text_color(C.warning).loop("opacity", { from: 0.25, to: 1, period: 1400 / this.speed });
    } else if (c.phase === "land") {
      ring = svg(`${ASSET}/ring.svg`).absolute().left(0).top(0).size_full().text_color(C.border);
    } else {
      ring = svg(`${ASSET}/ring.svg`).absolute().left(0).top(0).size_full().text_color(a.status === "done" ? C.success : C.border);
    }
    const [word, wordColor] = this.flightWord(a, c, tabs);
    const cell = this.cells.find((x) => x.space.id === c.space);
    const flip = f.x > (cell ? cell.x + cell.w * 0.7 : (this.size?.width ?? 0) * 0.7);
    const name = this.label(a, tabs).toUpperCase();
    const wt = this.worktree(a);
    const hue = this.hue(c);
    // Docked craft crowd the planet's face, so their tags show on hover only. With several
    // systems on screen, tags stay small.
    const quiet = c.phase === "parked" && !lit;
    const small = this.cells.length > 1;
    const max = small ? 18 : 24;
    const tag = v_flex().absolute().top(box / 2 - (c.parent ? 15 : 22)).gap(1).when(quiet, (el) => el.opacity(0)).px(5).py(2).rounded(2).bg("#000000cc")
      .when(!flip, (el) => el.left(box + 10)).when(flip, (el) => el.right(box + 10).items_end())
      .child(mono(c.parent || small ? 9.5 : 10.5, lit ? C.fg : c.parent ? C.fg2 : C.fg, 600).child(name.length > max ? `${name.slice(0, max - 1)}…` : name))
      .when(!c.parent || lit, (el) => el.child(mono(9.5, wordColor, 500).child(word)))
      .when(Boolean(wt) && !c.parent && (lit || !small), (el) => el.child(mono(9.5, hue, 500).child(`⎇ ${wt.branch}`)))
      .when(!c.parent && (lit || !small), (el) => el.child(mono(9.5, C.fg3, 500).child(this.meta(tel))));
    const leaderColor = c.parent ? C.border : `${hue}${lit ? "ff" : ORBIT_NEAR_ALPHA}`;
    const leader = div().absolute().top(box / 2).h(1).w(8).bg(leaderColor).when(quiet, (el) => el.opacity(0))
      .when(!flip, (el) => el.left(box + 1)).when(flip, (el) => el.right(box + 1));
    return div().id(`craft-${a.address}`).absolute()
      .left(f.x - box / 2).top(f.y - box / 2).w(box).h(box).p(5).opacity(f.opacity)
      .transition("left", dur).transition("top", dur).transition("width", dur).transition("height", dur).transition("opacity", dur)
      .cursor_pointer()
      .on_hover((hovered, cx) => { this.hover = hovered ? a.address : this.hover === a.address ? null : this.hover; cx.notify(); })
      .on_click((_e, cx) => { if (this.dragged || this.demo) return; run("agent.focus", { terminal: a.address }); cx.notify(); })
      .child(image(`${ASSET}/${glyph}.svg`).size_full())
      .child(ring)
      .child(leader)
      .child(tag);
  }

  ctxMeter(ctx) {
    const known = ctx != null;
    const color = known && ctx >= 0.8 ? C.advisory : C.fg2;
    return h_flex().w(92).flex_none().gap(6).items_center()
      .child(div().w(48).h(4).rounded(2).bg(C.surface3).child(div().h(4).rounded(2).w(known ? Math.max(2, 48 * ctx) : 0).bg(color)))
      .child(mono(10.5, known ? color : C.fg3, 500).child(known ? `${Math.round(ctx * 100)}%` : "--"));
  }

  manifest(list, tabs) {
    const h = this.consoleH(this.size.height);
    const narrow = this.size.width < 560;
    const collapsed = this.manifest_.collapsed;
    const toggle = h_flex().id("manifest-toggle").h(22).px(8).items_center().rounded(4).border(1).border_color(C.border).cursor_pointer()
      .hover((st) => st.bg(C.surface2).border_color(C.borderActive))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        this.manifest_ = { ...this.manifest_, collapsed: !collapsed };
        saveManifest(this.manifest_);
        this.place(this.clock(), 0);
        cx.notify();
      })
      .child(mono(10, C.fg2, 600).child(collapsed ? "EXPAND" : "COLLAPSE"));
    const grip = div().absolute().left(0).top(4).w_full().flex().justify_center()
      .child(div().w(36).h(3).rounded(2).bg(this.resizing ? C.fg2 : C.border));
    const header = h_flex().id("manifest-head").relative().h(MANIFEST_HEAD).flex_none().px(16).gap(12).items_center().justify_between()
      .when(!collapsed, (el) => el.border_b(1).border_color(C.hairline))
      .cursor_row_resize()
      .hover((st) => st.bg(C.surface2))
      .on_mouse_down("left", (e, cx) => {
        const z = Number(settings()?.zoom) || 1;
        this.resizing = { y0: e.position.y / z, h0: this.consoleH(this.size.height) };
        cx.notify();
      })
      .child(grip)
      .child(mono(11, C.fg2, 600).child("CREW MANIFEST"))
      .child(h_flex().gap(12).items_center()
        .child(mono(10.5, C.fg3, 500).child(list.length === 1 ? "1 CRAFT" : `${list.length} CRAFT`))
        .child(toggle));
    const badge = (status) => {
      const st = STATUS[status] ?? STATUS.idle;
      return h_flex().h(24).pl(4).pr(8).gap(4).items_center().rounded(4).bg(st.bg).flex_none()
        .child(div().w(16).h(16).flex().items_center().justify_center().child(div().w(6).h(6).bg(st.mark)))
        .child(sans(12, st.text, 600).child(st.badge));
    };
    const spaceHead = (r) => h_flex().id(`mh-${r.s.id}`).h(HEAD_H).flex_none().px(16).gap(8).items_center().bg(C.bg).cursor_pointer()
      .hover((st) => st.bg(C.surface2))
      .on_click((_e, cx) => { if (!this.demo) run("space.select", { id: r.s.id }); cx.notify(); })
      .child(div().w(7).h(7).bg(this.spaceColor(r.s.id)))
      .child(mono(10.5, r.s.id === this.src.focused()?.space ? C.fg : C.fg2, 600).child(r.s.name.toUpperCase()))
      .child(mono(10, C.fg3, 500).child(`${r.count} CRAFT`));
    const wtHead = (r) => h_flex().h(HEAD_H).flex_none().pl(28).pr(16).gap(7).items_center()
      .child(div().w(7).h(7).rounded(4).bg(r.wt.color ?? C.fg3))
      .child(mono(10.5, r.wt.color ?? C.fg2, 500).truncate().child(r.wt.branch ?? base(r.wt.path)))
      .when(r.wt.main, (el) => el.child(mono(9.5, C.fg3, 500).child("MAIN")));
    const row = (r) => {
      const a = r.a;
      const lit = this.hover === a.address;
      const since = tabs.get(a.tab)?.working_since;
      return h_flex().id(`row-${a.address}`).h(ROW_H).flex_none().px(16).gap(12).items_center().cursor_pointer()
        .when(lit || a.focused, (el) => el.bg(C.surface3))
        .hover((st) => st.bg(C.surface3))
        .on_hover((hovered, cx) => { this.hover = hovered ? a.address : this.hover === a.address ? null : this.hover; cx.notify(); })
        .on_click((_e, cx) => { if (this.demo) return; run("agent.focus", { terminal: a.address }); cx.notify(); })
        .child(mono(10.5, C.fg3, 500).w(r.sub ? 40 : 24).flex_none().child(r.sub ? `  └ ${String(r.n).padStart(2, "0")}` : String(r.n).padStart(2, "0")))
        .child(div().w(104).flex_none().child(badge(a.status)))
        .child(sans(13, C.fg, 500).flex_1().min_w(0).truncate().child(this.label(a, tabs)))
        .when(!narrow, (el) => el.child(mono(10.5, C.fg3, 500).flex_none()
          .child((this.telemetry.get(a.address)?.model ?? a.program?.name ?? a.app ?? "AGENT").toUpperCase())))
        .child(this.ctxMeter(this.telemetry.get(a.address)?.ctx))
        .child(mono(11, a.status === "working" ? C.fg2 : C.fg3, 500).w(64).flex_none().text_right()
          .child(a.status === "working" && since ? `T+${clock((this.now ?? this.clock()) - since)}` : "--:--"));
    };
    const draw = (r) => (r.kind === "space" ? spaceHead(r) : r.kind === "worktree" ? wtHead(r) : row(r));
    return v_flex().h(h).flex_none().bg(C.surface).border_t(1).border_color(C.hairline).overflow_hidden()
      .child(header)
      .when(!collapsed, (el) => el.child(v_flex().id("manifest-rows").flex_1().min_h(0).overflow_y_scrollbar()
        .children(this.rows.map(draw))
        .when(list.length === 0, (el) => el.child(div().px(16).py(12).child(sans(13, C.fg3).child("No agents in view."))))));
  }
}
