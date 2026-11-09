// Flight Deck: a cockpit view of the shown space as a star system. The space is the
// planet; each agent in it is a craft that launches when it starts work, orbits while it
// works, holds when it needs you, and lands when it is done. Sub-agents circle their parent.
// Styled dark and flat: grayscale, one cyan accent (#2EE6FF), IBM Plex Sans and Mono,
// surfaces divided by hairlines.

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, focused, hc, props, run, setAgentOrder, settings, spaces, terminals } from "herdr";
import { createDemo } from "./demo.js";
import {
  DEFAULT_VIEW, LAND_MS, LAUNCH_MS, PITCH_MAX, PITCH_MIN, R_RATE, TAU, ZOOM_MAX, ZOOM_MIN, add, ascent, camera, clamp01,
  descent, moonOrbitOf, moonPadPoint, orbitOf, orbitPaths, orbitPoint, padPoint, project, radiusFor, spreadRadii, startAngle,
} from "./orbit.js";
import { modelLook, parseStatusLine } from "./telemetry.js";

const READ_MS = 5000; // how often each agent's status line is read for its model and context

const VIEW_KEY = "flightdeck.view";
const DRAG_RAD_PER_PX = 0.008;
const CLICK_SLOP_PX = 4; // a press that moves less than this is still a click on a craft

// The last view this copy was turned to. Per copy and best effort: a blocked store just starts at the default.
const loadView = () => {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (v && [v.yaw, v.pitch, v.zoom].every(Number.isFinite)) return v;
  } catch {}
  return { ...DEFAULT_VIEW };
};
const saveView = (v) => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch {} };

// The manifest's height and whether it's collapsed, per copy. A blocked store starts at the default.
const MANIFEST_KEY = "flightdeck.manifest";
const MANIFEST_HEAD = 32; // the header: all that shows when collapsed
const MANIFEST_SNAP = 64; // dragged shorter than this, it collapses
const MANIFEST_MIN_OPEN = 76; // open, it shows at least the header and one row
const loadManifest = () => {
  try {
    const m = JSON.parse(localStorage.getItem(MANIFEST_KEY) ?? "null");
    if (m && typeof m.collapsed === "boolean" && (m.height == null || Number.isFinite(m.height))) return m;
  } catch {}
  return { collapsed: false, height: null };
};
const saveManifest = (m) => { try { localStorage.setItem(MANIFEST_KEY, JSON.stringify(m)); } catch {} };

const ASSET = "mods/flightdeck";
const SANS = "IBM Plex Sans";
const MONO = "IBM Plex Mono";

// Colour tokens, dark theme.
const C = {
  bg: "#000000", surface: "#121212", surface2: "#1f1f1f", surface3: "#272825",
  fg: "#edefea", fg2: "#b3b5b0", fg3: "#7b7c79", hairline: "#222222", border: "#4b4c4a", borderActive: "#eeefec",
  // A HUD cyan: far from the warning orange, so "In orbit" never reads as "Needs you".
  gray80: "#353534", accent: "#2ee6ff",
  success: "#5bd65f", successBg: "#66ff6949", warning: "#ff844d", warningBg: "#ff530e4a",
  neutral: "#b3b5b0", neutralBg: "#fffffa30", advisory: "#ffca42",
};

// Orbit hues: soft data-viz hues (blue, mint, pink, purple), then sand and periwinkle.
// Green, bright yellow and red are left out: they read as success, advisory and danger.
// No cyans here: the accent is cyan, and a ring must never look like a working craft.
const ORBIT_HUES = ["#8cabff", "#58d6b5", "#f257a5", "#b061ff", "#d9c27a", "#c0c4ff"];
const orbitHue = (slot) => ORBIT_HUES[slot % ORBIT_HUES.length];
const ORBIT_NEAR_ALPHA = "8c"; // 55%
const ORBIT_FAR_ALPHA = "4d"; // 30%
const ORBIT_DOTS = [1.5, 5];

const HUD_H = 40;
const ROW_H = 34;
const FAST_MS = 220; // ticks while a craft launches or lands
const SLOW_MS = 700; // ticks while craft only orbit

// What each status looks like. Working is a neutral badge with the accent square:
// the accent marks the active state.
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

export default class FlightDeck extends View {
  init(_props, cx) {
    // `speed` (0..1, default 1) slows every motion and timer, for recordings: capture slowly,
    // then play back faster for a higher frame rate. Real data always runs at 1.
    const speedProp = Number((props() ?? {}).speed);
    this.speed = speedProp > 0 && speedProp <= 1 ? speedProp : 1;
    const t0 = Date.now();
    this.clock = () => t0 + (Date.now() - t0) * this.speed;
    this.size = null;
    this.craft = new Map(); // address -> craft state, kept across systems
    this.frame = new Map(); // address -> where the craft is drawn now
    this.view = null; // a system picked by hand; null follows the shown space
    this.hover = null;
    this.dur = SLOW_MS;
    this.orbitCache = null;
    this.look = loadView(); // yaw, pitch and zoom from dragging and scrolling
    this.press = null; // a drag in progress
    this.dragged = false; // the last press moved far enough to be a drag, not a click
    this.manifest_ = loadManifest(); // { collapsed, height }: null height is the automatic default
    this.resizing = null; // a manifest resize in progress: { y0, h0 }
    this.telemetry = new Map(); // address -> { ctx 0..1, model }, read from each agent's status line
    // Props, all optional: `demo: true` flies a scripted fleet instead of real agents (no
    // tokens spent), and `fps` redraws that often while craft move, for smooth recordings.
    const p = props() ?? {};
    this.demo = p.demo ? createDemo(this.clock, Number(p.demoStart) || 0) : null;
    this.src = this.demo ?? { agents, spaces, terminals, focused };
    const frameMs = Number(p.fps) > 0 ? Math.max(33, Math.round(1000 / Number(p.fps))) : 0;
    this.fastMs = frameMs || FAST_MS;
    this.slowMs = frameMs || SLOW_MS;
    if (this.demo) {
      // The demo's clock: statuses, sub-agents and context come from the script.
      cx.spawn(async (cx) => {
        for (;;) {
          this.telemetry = this.demo.telemetry();
          this.wake?.();
          cx.notify();
          await cx.sleep(250);
        }
      });
    }
    // Reads the shown system's agents one at a time. A status line that doesn't show (a dialog
    // over it) keeps the last reading.
    if (!this.demo) cx.spawn(async (cx) => {
      for (;;) {
        const id = this.systemId();
        let changed = false;
        for (const a of this.src.agents().filter((x) => x.space === id)) {
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
          // Nothing moves: no redraws until a status changes.
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

  // Brings each craft's flight in line with its agent's status. Runs in render, since
  // render is what Herdr calls when agents change.
  sync(list) {
    const now = this.clock();
    const parents = new Map(this.src.terminals().map((t) => [t.address, t.parent ?? null]));
    const here = new Set(list.map((a) => a.address));
    let changed = false;
    for (const address of [...this.craft.keys()]) {
      if (!this.src.agents().some((a) => a.address === address)) { this.craft.delete(address); this.frame.delete(address); changed = true; }
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
      if (!c || c.parent !== parentHere) {
        const slot = freeSlot(parentHere ?? `space:${a.space}`);
        // Craft already working when the deck opens launch one after another.
        const launch = a.status === "working" || a.status === "blocked";
        // A fresh agent has an empty context, so it flies to the far orbit.
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

  // Moves a craft's clock to now: banks the angle it flew at its old radius, then eases the
  // radius toward its goal. The angle is summed step by step, since speed changes with radius.
  advance(c, now) {
    if (c.phase === "orbit") { c.theta = this.angleAt(c, now); c.thetaAt = now; }
    if (c.phase === "orbit" || c.phase === "hold") {
      const step = (R_RATE * Math.max(0, now - (c.rAt ?? now))) / 1000;
      c.r += Math.max(-step, Math.min(step, c.rGoal - c.r));
    } else if (c.phase === "parked") {
      c.r = c.rGoal; // where it will go on its next launch
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

  // The orbit angle at t: `theta` was the angle at `thetaAt`. A launch aims at `theta`.
  angleAt(c, t) {
    if (c.phase === "hold") return c.holdTheta;
    if (c.phase === "launch") return c.theta;
    return c.theta + (TAU * (t - c.thetaAt)) / this.orbit(c).period;
  }

  // Where the craft is at t, relative to the planet's centre.
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
        c.thetaAt = c.t0 + LAUNCH_MS; // it reached `theta` as the launch ended
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

  // How often to tick: fast while a craft climbs or lands, slow while craft only orbit, never otherwise.
  step() {
    const id = this.systemId();
    let orbiting = false;
    for (const c of this.craft.values()) {
      if (c.space !== id) continue;
      if (c.phase === "launch" || c.phase === "land") return this.fastMs;
      if (c.phase === "orbit") orbiting = true;
    }
    return orbiting ? this.slowMs : 0;
  }

  // Works out each craft's next spot. Each one glides there natively over `dur`.
  place(t, dur) {
    // While someone drags, craft follow the camera at once; gliding would trail behind the pointer.
    if (this.press) { t = this.clock(); dur = 0; }
    this.dur = dur;
    this.now = this.clock();
    if (!this.size) return;
    const vp = this.viewport();
    const id = this.systemId();
    const tops = [...this.craft.values()].filter((c) => c.space === id && !c.parent);
    // Context sets each orbit's radius; spreading keeps craft with the same context apart.
    const goals = spreadRadii(tops.map((c) => ({ key: c.address, r: radiusFor(this.telemetry.get(c.address)?.ctx ?? 0) })));
    for (const c of tops) { c.rGoal = goals.get(c.address) ?? c.rGoal; this.advance(c, this.now); }
    const cam = camera(vp.w, vp.h, this.look);
    this.cam = cam;
    const crafted = new Map(this.src.agents().map((a) => [a.address, a]));
    for (const c of this.craft.values()) {
      if (c.space !== id) continue;
      const q = project(cam, this.worldAt(c, c.shown ? t : this.now));
      const a = crafted.get(c.address);
      const look = modelLook(this.telemetry.get(c.address)?.model, a?.app ?? a?.program?.key);
      // Bigger models read as smarter: the size scales with the model's tier.
      const base = c.parent ? 12 : Math.max(14, Math.min(30, cam.planetPx * 0.2)) * look.size;
      const s = Math.round(base * q.scale);
      const off = Math.hypot(q.x - cam.cx, q.y - cam.cy);
      const hidden = q.behind && off < cam.planetPx + s * 0.2;
      this.frame.set(c.address, { x: q.x, y: q.y, s, opacity: hidden ? 0 : q.behind ? 0.55 : 1 });
    }
  }

  viewport() {
    const { width: w, height: h } = this.size;
    return { w, h: Math.max(120, h - HUD_H - this.consoleH(h)) };
  }

  // The manifest's height: its header only when collapsed, what someone dragged it to, or
  // by default enough for its rows, between 112px and 36% of the view. The cockpit keeps 120px.
  consoleH(h) {
    const most = Math.max(MANIFEST_HEAD, h - HUD_H - 120);
    if (this.manifest_.collapsed) return MANIFEST_HEAD;
    if (this.manifest_.height != null) return Math.round(Math.min(Math.max(this.manifest_.height, MANIFEST_MIN_OPEN), most));
    const n = this.rows?.length ?? 0;
    return Math.round(Math.min(Math.max(44 + n * ROW_H, 112), h * 0.36, most));
  }

  // Dragging the manifest's header: up makes it taller, down shorter; dropped below
  // MANIFEST_SNAP it collapses to its header, and dragged back up it opens again.
  resizeTo(y) {
    const r = this.resizing;
    const want = r.h0 - (y - r.y0);
    if (want < MANIFEST_SNAP) {
      this.manifest_ = { ...this.manifest_, collapsed: true };
    } else {
      this.manifest_ = { collapsed: false, height: want };
    }
    this.place(this.clock(), 0); // the cockpit changed size, so the camera refits
  }

  endResize(cx) {
    if (!this.resizing) return;
    this.resizing = null;
    saveManifest(this.manifest_);
    cx.notify();
  }

  // ---- render -----------------------------------------------------------------------

  render(cx) {
    const id = this.systemId();
    const system = this.src.spaces().find((s) => s.id === id) ?? null;
    const list = this.src.agents().filter((a) => a.space === id);
    this.sync(list);
    // Parents first, each followed by its sub-agents.
    const tops = list.filter((a) => !this.craft.get(a.address)?.parent);
    this.rows = tops.flatMap((a) => [a, ...list.filter((b) => this.craft.get(b.address)?.parent === a.address)]);
    if (!this.demo) setAgentOrder(this.rows.map((a) => a.address));
    const tabs = new Map((system?.tabs ?? []).map((t) => [t.id, t]));

    const root = v_flex().id("root").size_full().bg(C.bg).overflow_hidden()
      // A resize is followed on the root, so it keeps going when the pointer leaves the header.
      .when(Boolean(this.resizing), (el) => el.cursor_row_resize())
      .on_mouse_move((e, cx) => {
        if (!this.resizing) return;
        const z = Number(settings()?.zoom) || 1;
        this.resizeTo(e.position.y / z);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => this.endResize(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endResize(cx); })
      // Sizes come back unzoomed, while every length set here is zoomed: divide by the zoom.
      .on_size_change((size, cx) => {
        const z = Number(settings()?.zoom) || 1;
        this.size = { width: size.width / z, height: size.height / z };
        this.orbitCache = null;
        this.place(this.clock(), 0);
        cx.notify();
      });
    if (!this.size) return root;
    if (!this.cam) this.place(this.clock(), 0);
    const vp = this.viewport();

    return root
      .child(this.hud(system, list, cx))
      .child(this.cockpit(vp, system, list, tabs))
      .child(this.manifest(list, tabs));
  }

  hud(system, list) {
    const count = (s) => list.filter((a) => a.status === s).length;
    const stat = (n, label, color) => h_flex().gap(6).items_center()
      .child(div().w(6).h(6).bg(n ? color : C.border))
      .child(mono(11, n ? C.fg2 : C.fg3, 500).child(`${n} ${label}`));
    const others = this.src.spaces().filter((s) => s.id !== system?.id);
    const following = !this.view || this.view === this.src.focused()?.space;
    const chip = (s) => h_flex().id(`sys-${s.id}`).h(24).px(8).gap(6).items_center().rounded(4).border(1).border_color(C.hairline).cursor_pointer()
      .hover((st) => st.bg(C.surface2).border_color(C.border))
      .on_click((_e, cx) => { this.view = s.id; this.orbitCache = null; this.place(this.clock(), 0); this.wake?.(); cx.notify(); })
      .child(image(`${ASSET}/moon.svg`).w(12).h(12))
      .child(mono(10.5, C.fg2, 500).child(s.name.toUpperCase()))
      .when(s.status != null, (el) => el.child(div().w(6).h(6).bg(STATUS[s.status]?.mark ?? C.border)));
    return h_flex().h(HUD_H).flex_none().px(16).gap(12).items_center().justify_between().border_b(1).border_color(C.hairline).bg(C.bg)
      .child(h_flex().gap(10).items_center().min_w(0).overflow_hidden()
        .child(div().w(8).h(8).bg(C.accent).flex_none())
        .child(mono(12, C.fg, 600).child("FLIGHT DECK"))
        .child(mono(12, C.fg3).child("//"))
        .child(mono(12, C.fg2, 500).truncate().child((system?.name ?? "NO SYSTEM").toUpperCase()))
        // Says plainly that what shows is scripted, so a recording never passes for real work.
        .when(Boolean(this.demo), (el) => el.child(h_flex().h(20).px(6).items_center().rounded(4).border(1).border_color(C.border).flex_none()
          .child(mono(10, C.fg3, 600).child("DEMO DATA"))))
        .when(!following, (el) => el.child(h_flex().id("follow").h(24).px(8).items_center().rounded(4).border(1).border_color(C.accent).cursor_pointer()
          .hover((st) => st.bg(C.surface2))
          .on_click((_e, cx) => { this.view = null; this.orbitCache = null; this.place(this.clock(), 0); this.wake?.(); cx.notify(); })
          .child(mono(10.5, C.accent, 600).child("RETURN"))))
        // Narrow, the chips would crowd out the system's own name: they show from 720px wide.
        .when(others.length > 0 && (this.size?.width ?? 0) >= 720, (el) => el.child(div().w(1).h(16).bg(C.hairline).flex_none()).child(h_flex().gap(6).children(others.slice(0, 5).map(chip)))))
      .child(h_flex().gap(14).flex_none().items_center()
        .child(stat(count("working"), "IN ORBIT", C.accent))
        .child(stat(count("blocked"), "HOLDING", C.warning))
        .child(stat(count("done") + count("idle"), "LANDED", C.success)));
  }

  cockpit(vp, system, list, tabs) {
    const cam = this.cam;
    const tops = [...this.craft.values()].filter((c) => c.space === system?.id && !c.parent);
    const { yaw, pitch, zoom } = this.look;
    // Orbits drift in as context fills, so their lines are rebuilt each time a radius moves a little.
    const key = `${vp.w}x${vp.h}:${yaw}:${pitch}:${zoom}:${tops.map((c) => `${c.slot}@${c.r.toFixed(2)}`).sort().join(",")}`;
    if (!this.orbitCache || this.orbitCache.key !== key) {
      // Every orbit is dotted all the way round, in its own hue. Depth shows in strength:
      // the half behind the planet is fainter than the half in front.
      // One path per run: a dashed path draws a line across a move_to, joining the pieces.
      const build = (runs) => runs.filter((r) => r.length > 1).map((r) => {
        let path = PathBuilder.stroke(1.5).dash_array(ORBIT_DOTS).move_to(r[0][0], r[0][1]);
        for (const pt of r.slice(1)) path = path.line_to(pt[0], pt[1]);
        return path.build();
      });
      const rings = tops.map((c) => {
        const p = orbitPaths(cam, orbitOf(c.slot, c.r));
        const hue = orbitHue(c.slot);
        return { far: build(p.far), near: build(p.near), farColor: `${hue}${ORBIT_FAR_ALPHA}`, nearColor: `${hue}${ORBIT_NEAR_ALPHA}` };
      });
      this.orbitCache = { key, rings };
    }
    const layer = (path, color) => (path ? window.paint_path(path, color).absolute().left(0).top(0).w(vp.w).h(vp.h) : null);
    const farRings = this.orbitCache.rings.flatMap((r) => r.far.map((p) => layer(p, r.farColor)));
    const nearRings = this.orbitCache.rings.flatMap((r) => r.near.map((p) => layer(p, r.nearColor)));
    const starSide = Math.max(vp.w, vp.h);
    const planet = cam.planetPx * 2;

    const bodies = this.rows.map((a) => this.body(a, tabs)).filter(Boolean);
    const empty = list.length === 0;

    const moved = Math.abs(yaw - DEFAULT_VIEW.yaw) > 1e-3 || Math.abs(pitch - DEFAULT_VIEW.pitch) > 1e-3 || Math.abs(zoom - DEFAULT_VIEW.zoom) > 1e-3;
    return div().id("cockpit").relative().w(vp.w).h(vp.h).flex_none().overflow_hidden().bg(C.bg)
      .when(Boolean(this.press), (el) => el.cursor_grabbing())
      .when(!this.press, (el) => el.cursor_grab())
      // Drag turns the system: sideways spins it, up and down tilts it.
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
      // Scroll zooms in and out around the planet.
      .on_scroll_wheel((e, cx) => {
        const dy = Math.max(-60, Math.min(60, e.delta.y));
        this.look = { ...this.look, zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.look.zoom * Math.exp(-dy * 0.004))) };
        saveView(this.look);
        this.place(this.clock(), 0);
        cx.notify();
      })
      .child(image(`${ASSET}/stars.svg`).absolute().left((vp.w - starSide) / 2).top((vp.h - starSide) / 2).w(starSide).h(starSide))
      .children(farRings)
      .child(image(`${ASSET}/globe.svg`).absolute().left(cam.cx - planet / 2).top(cam.cy - planet / 2).w(planet).h(planet))
      .children(nearRings)
      .children(bodies)
      .child(this.canopy(vp))
      .child(this.readout(vp, system, list))
      .child(this.viewControls(vp, moved))
      .when(empty, (el) => el.child(v_flex().absolute().left(0).w(vp.w).top(cam.cy + cam.planetPx + 18).items_center().gap(4)
        .child(mono(11, C.fg2, 600).child("NO CREW IN THIS SYSTEM"))
        .child(sans(13, C.fg3).child("Start an agent in this space to launch it."))));
  }

  endDrag(cx) {
    if (!this.press) return;
    this.press = null;
    saveView(this.look);
    this.wake?.(); // craft go back to gliding from where they are
    cx.notify();
  }

  // Bottom left of the window: how to move the view, and a way back to the default.
  viewControls(vp, moved) {
    const inset = Math.max(24, vp.w * 0.05) + 8;
    return h_flex().absolute().left(inset).bottom(30).gap(10).items_center()
      .child(mono(10, C.fg3, 500).child("DRAG TO TURN · SCROLL TO ZOOM"))
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

  // The canopy frame: pillars and bows in surface gray, with hairline edges.
  canopy(vp) {
    const { w, h } = vp;
    const k = this.canopyCache;
    if (!k || k.w !== w || k.h !== h) {
      const side = Math.max(18, Math.min(44, w * 0.045));
      const shapes = [
        [[0, 0], [w, 0], [w, 10], [w * 0.64, 22], [w * 0.36, 22], [0, 10]],
        [[0, 0], [side, 0], [side * 0.35, h], [0, h]],
        [[w, 0], [w - side, 0], [w - side * 0.35, h], [w, h]],
        [[0, h], [0, h - 8], [w * 0.3, h - 18], [w * 0.7, h - 18], [w, h - 8], [w, h]],
      ];
      let fill = PathBuilder.fill();
      let edge = PathBuilder.stroke(1);
      for (const s of shapes) { fill = fill.add_polygon(s, true); edge = edge.add_polygon(s, true); }
      this.canopyCache = { w, h, fill: fill.build(), edge: edge.build() };
    }
    const at = (el) => el.absolute().left(0).top(0).w(w).h(h);
    return div().absolute().left(0).top(0).w(w).h(h)
      .child(at(window.paint_path(this.canopyCache.fill, C.surface)))
      .child(at(window.paint_path(this.canopyCache.edge, C.gray80)));
  }

  readout(vp, system, list) {
    const longest = list.reduce((m, a) => {
      const since = (system?.tabs ?? []).find((t) => t.id === a.tab)?.working_since;
      return a.status === "working" && since ? Math.max(m, (this.now ?? this.clock()) - since) : m;
    }, 0);
    const corner = (lines, left) => v_flex().absolute().top(34).gap(2)
      .when(left, (el) => el.left(Math.max(24, vp.w * 0.05) + 8)).when(!left, (el) => el.right(Math.max(24, vp.w * 0.05) + 8).items_end())
      .children(lines.map(([t, c]) => mono(10, c, 500).child(t)));
    return div().absolute().left(0).top(0).w(vp.w).h(vp.h)
      .child(corner([[`SYS ${(system?.name ?? "").toUpperCase()}`, C.fg3], [system?.branch ? `BR  ${system.branch.toUpperCase()}` : "BR  NONE", C.fg3]], true))
      .child(corner([[`CREW ${list.length}`, C.fg3], [longest ? `T+${clock(longest)}` : "T+--:--", longest ? C.fg2 : C.fg3]], false));
  }

  label(a, tabs) {
    // A sub-agent shares its parent's tab, so the tab's name would repeat the parent's: use its own title.
    if (this.craft.get(a.address)?.parent) return (a.title || a.program?.name || a.address).trim();
    const tab = tabs.get(a.tab);
    return (tab?.named ? tab.name : a.title || a.program?.name || a.address).trim();
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

  // "OPUS 5.5 · CTX 34%", or dashes until the status line has been read.
  meta(tel) {
    const model = tel?.model ? tel.model.toUpperCase() : "MODEL --";
    const ctx = tel?.ctx != null ? `CTX ${Math.round(tel.ctx * 100)}%` : "CTX --";
    return `${model} · ${ctx}`;
  }

  body(a, tabs) {
    const c = this.craft.get(a.address);
    const f = c && this.frame.get(a.address);
    if (!f) return null;
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
    const flip = f.x > (this.size?.width ?? 0) * 0.7;
    const name = this.label(a, tabs).toUpperCase();
    // A dark plate keeps the tag readable over the lit side of the planet.
    // Docked craft crowd the planet's face, so their tags show on hover only.
    const quiet = c.phase === "parked" && !lit;
    const tag = v_flex().absolute().top(box / 2 - (c.parent ? 15 : 22)).gap(1).when(quiet, (el) => el.opacity(0)).px(5).py(2).rounded(2).bg("#000000cc")
      .when(!flip, (el) => el.left(box + 10)).when(flip, (el) => el.right(box + 10).items_end())
      .child(mono(c.parent ? 9.5 : 10.5, lit ? C.fg : c.parent ? C.fg2 : C.fg, 600).child(name.length > 22 ? `${name.slice(0, 21)}…` : name))
      .when(!c.parent || lit, (el) => el.child(mono(9.5, wordColor, 500).child(word)))
      .when(!c.parent, (el) => el.child(mono(9.5, C.fg3, 500).child(this.meta(tel))));
    // The leader takes the orbit's hue, so a label points back to its ring.
    const leaderColor = c.parent ? C.border : `${orbitHue(c.slot)}${lit ? "ff" : ORBIT_NEAR_ALPHA}`;
    const leader = div().absolute().top(box / 2).h(1).w(8).bg(leaderColor).when(quiet, (el) => el.opacity(0))
      .when(!flip, (el) => el.left(box + 1)).when(flip, (el) => el.right(box + 1));
    return div().id(`craft-${a.address}`).absolute()
      .left(f.x - box / 2).top(f.y - box / 2).w(box).h(box).p(5).opacity(f.opacity)
      .transition("left", dur).transition("top", dur).transition("width", dur).transition("height", dur).transition("opacity", dur)
      .cursor_pointer()
      .on_hover((hovered, cx) => { this.hover = hovered ? a.address : this.hover === a.address ? null : this.hover; cx.notify(); })
      // A press that turned into a drag is not a click on the craft.
      .on_click((_e, cx) => { if (this.dragged || this.demo) return; run("agent.focus", { terminal: a.address }); cx.notify(); })
      .child(image(`${ASSET}/${glyph}.svg`).size_full())
      .child(ring)
      .child(leader)
      .child(tag);
  }

  // Context use as a thin meter. Past 80% it turns advisory amber: possible risk, no action required.
  ctxMeter(ctx) {
    const known = ctx != null;
    const color = known && ctx >= 0.8 ? C.advisory : C.fg2;
    return h_flex().w(92).flex_none().gap(6).items_center()
      .child(div().w(48).h(4).rounded(2).bg(C.surface3).child(div().h(4).rounded(2).w(known ? Math.max(2, 48 * ctx) : 0).bg(color)))
      .child(mono(10.5, known ? color : C.fg3, 500).child(known ? `${Math.round(ctx * 100)}%` : "--"));
  }

  // The crew manifest: one row per agent, in the order craft are numbered.
  manifest(list, tabs) {
    const h = this.consoleH(this.size.height);
    const narrow = this.size.width < 560;
    const collapsed = this.manifest_.collapsed;
    const toggle = h_flex().id("manifest-toggle").h(22).px(8).items_center().rounded(4).border(1).border_color(C.border).cursor_pointer()
      .hover((st) => st.bg(C.surface2).border_color(C.borderActive))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // a click here never starts a resize
      .on_click((_e, cx) => {
        this.manifest_ = { ...this.manifest_, collapsed: !collapsed };
        saveManifest(this.manifest_);
        this.place(this.clock(), 0);
        cx.notify();
      })
      .child(mono(10, C.fg2, 600).child(collapsed ? "EXPAND" : "COLLAPSE"));
    // The header is the handle: a grip in the middle shows it can be dragged.
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
    const row = (a, i) => {
      const c = this.craft.get(a.address);
      const sub = Boolean(c?.parent);
      const lit = this.hover === a.address;
      const since = tabs.get(a.tab)?.working_since;
      return h_flex().id(`row-${a.address}`).h(ROW_H).flex_none().px(16).gap(12).items_center().cursor_pointer()
        .when(lit || a.focused, (el) => el.bg(C.surface3))
        .hover((st) => st.bg(C.surface3))
        .on_hover((hovered, cx) => { this.hover = hovered ? a.address : this.hover === a.address ? null : this.hover; cx.notify(); })
        .on_click((_e, cx) => { if (this.demo) return; run("agent.focus", { terminal: a.address }); cx.notify(); })
        .child(mono(10.5, C.fg3, 500).w(sub ? 40 : 24).flex_none().child(sub ? `  └ ${String(i + 1).padStart(2, "0")}` : String(i + 1).padStart(2, "0")))
        .child(div().w(104).flex_none().child(badge(a.status)))
        .child(sans(13, C.fg, 500).flex_none().max_w(narrow ? 140 : 220).truncate().child(this.label(a, tabs)))
        .when(!narrow, (el) => el.child(sans(13, C.fg2).flex_1().min_w(0).truncate().child(a.title ?? "")))
        .when(narrow, (el) => el.child(div().flex_1()))
        .when(!narrow, (el) => el.child(mono(10.5, C.fg3, 500).flex_none()
          .child((this.telemetry.get(a.address)?.model ?? a.program?.name ?? a.app ?? "AGENT").toUpperCase())))
        .child(this.ctxMeter(this.telemetry.get(a.address)?.ctx))
        .child(mono(11, a.status === "working" ? C.fg2 : C.fg3, 500).w(64).flex_none().text_right()
          .child(a.status === "working" && since ? `T+${clock((this.now ?? this.clock()) - since)}` : "--:--"));
    };
    return v_flex().h(h).flex_none().bg(C.surface).border_t(1).border_color(C.hairline).overflow_hidden()
      .child(header)
      .when(!collapsed, (el) => el.child(v_flex().id("manifest-rows").flex_1().min_h(0).overflow_y_scrollbar()
        .children(this.rows.map(row))
        .when(this.rows.length === 0, (el) => el.child(div().px(16).py(12).child(sans(13, C.fg3).child("No agents in this space."))))));
  }
}
