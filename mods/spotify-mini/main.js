// A tiny Spotify player. In a layout block (the Flight Deck status bar) it is a
// slim now-playing item with -15s, previous, play/pause, next and +15s;
// clicking the track opens a popup just above it with artwork, a seekable
// progress bar, shuffle and repeat, volume, Open in Spotify, Copy link and a
// close button. Talks to the Spotify app on macOS through osascript; it never
// launches Spotify by itself.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, props, theme, appHome, openOverlay, closeOverlay, shared, setShared } from "herdr";

const DIR = "mods/spotify-mini";
const ART_DIR = "cache/spotify-mini"; // under the app home, outside the mod folder so saves don't reload it
const SEP = "\u001f";
const POPUP = { width: 340, height: 180 };
const CLOSED_KEY = "spotify.popupClosedAt"; // when a press outside the open popup closed it

const READ = `
if application "Spotify" is not running then return "off"
tell application "Spotify"
  set s to player state as string
  if s is "stopped" then return "stopped"
  set t to current track
  set sep to character id 31
  return s & sep & (name of t) & sep & (artist of t) & sep & (album of t) & sep & (artwork url of t) & sep & (player position as string) & sep & ((duration of t) as string) & sep & (shuffling as string) & sep & (repeating as string) & sep & (sound volume as string) & sep & (spotify url of t)
end tell`;

const SKIP = (sec) =>
  `tell application "Spotify"
  set p to (player position) + (${sec})
  if p < 0 then set p to 0
  set player position to p
end tell`;

const tell = (cmd) => `tell application "Spotify" to ${cmd}`;
const num = (s) => parseFloat(String(s ?? "").replace(",", "."));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const fmt = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

// spotify:track:ID -> https://open.spotify.com/track/ID (episodes and others alike).
const webLink = (uri) => {
  const m = /^spotify:([a-z]+):([A-Za-z0-9]+)$/.exec(uri ?? "");
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
};

export default class SpotifyMini extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay ?? null;
    this.popup = Boolean(this.overlay);
    this.state = "loading"; // off | stopped | playing | paused | loading | error
    this.track = null;
    this.art = null;
    this.copied = 0;
    this.busy = false;
    this.refresh(cx);
    // The bar item shows no clock, so it polls less often than the open popup.
    cx.timer.every(this.popup ? 1000 : 2500, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("osascript", ["-e", READ], { timeout: 5000 });
        this.parse(r.stdout.trim(), cx);
      } catch {
        this.state = "error";
      }
      this.busy = false;
      cx.notify();
    });
  }

  parse(out, cx) {
    if (out === "off" || out === "stopped" || out === "") {
      this.state = out || "off";
      this.track = null;
      return;
    }
    const [state, name, artist, album, artUrl, pos, dur, shuffle, repeat, vol, uri] = out.split(SEP);
    this.state = state;
    this.track = {
      name,
      artist: artist || album,
      pos: num(pos),
      dur: num(dur) / 1000,
      shuffle: shuffle === "true",
      repeat: repeat === "true",
      vol: clamp(Math.round(num(vol)), 0, 100),
      uri,
    };
    if (this.popup) this.loadArt(artUrl, cx);
  }

  loadArt(url, cx) {
    if (!url || url === this.artUrl) return;
    this.artUrl = url;
    const file = `${ART_DIR}/${url.split("/").pop().replace(/[^a-zA-Z0-9]/g, "")}.jpg`;
    cx.spawn(async (cx) => {
      const abs = `${appHome()}/${file}`;
      try {
        await exec("mkdir", ["-p", `${appHome()}/${ART_DIR}`]);
        await exec("sh", ["-c", 'test -s "$1" || curl -sfL --max-time 10 -o "$1" "$2"', "sh", abs, url], { timeout: 15000 });
        if (this.artUrl === url) this.art = file;
      } catch {
        this.art = null;
      }
      cx.notify();
    });
  }

  control(script, cx) {
    cx.spawn(async (cx) => {
      try {
        await exec("osascript", ["-e", script], { timeout: 5000 });
      } catch {}
      this.refresh(cx);
    });
  }

  get live() {
    return Boolean(this.track) && (this.state === "playing" || this.state === "paused");
  }

  get message() {
    return this.state === "off" ? "Spotify isn't running" :
      this.state === "stopped" ? "Nothing playing" :
      this.state === "error" ? "Can't reach Spotify" : "Loading…";
  }

  // A round icon button. `box` is its square size; `active` tints it with the accent.
  button(id, icon, size, box, t, onClick, { tip, active } = {}) {
    return div()
      .id(id)
      .flex_none()
      .size(box)
      .rounded(box / 2)
      .flex()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .text_color(active ? t.accent : t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(svg(`${DIR}/${icon}.svg`).size(size));
  }

  transport(prefix, t, small) {
    const run = (script) => (cx) => this.control(script, cx);
    const b = small ? 22 : 34;
    const skip = small ? 17 : 22;
    const step = small ? 11 : 15;
    return h_flex().flex_none().items_center().gap(small ? 1 : 4)
      .child(this.button(`${prefix}-back`, "back15", skip, b, t, run(SKIP(-15)), { tip: "Back 15 seconds" }))
      .child(this.button(`${prefix}-prev`, "prev", step, b, t, run(tell("previous track")), { tip: "Previous" }))
      .child(this.button(`${prefix}-play`, this.state === "playing" ? "pause" : "play", small ? 12 : 20, b, t, run(tell("playpause"))))
      .child(this.button(`${prefix}-next`, "next", step, b, t, run(tell("next track")), { tip: "Next" }))
      .child(this.button(`${prefix}-fwd`, "fwd15", skip, b, t, run(SKIP(15)), { tip: "Forward 15 seconds" }));
  }

  togglePopup() {
    // A press on the bar while the popup is open closes it as a click outside
    // (the popup stamps CLOSED_KEY on that press); don't reopen it from the same click.
    if (Date.now() - Number(shared(CLOSED_KEY) ?? 0) < 600) return;
    const b = this.bounds;
    const at = b ? { x: Math.max(8, b.x), y: Math.max(8, b.y - POPUP.height - 6) } : "pointer";
    openOverlay({ mod: "spotify-mini", kind: "popup", ...POPUP, at });
  }

  renderBar(t) {
    const live = this.live;
    const playing = this.state === "playing";
    const text = live ? `${this.track.name}${this.track.artist ? `  ·  ${this.track.artist}` : ""}` : this.message;
    return h_flex()
      .id("spotify-bar")
      .size_full()
      .pl(6)
      .pr(8)
      .gap(6)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_r(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .on_mouse_down("left", (e) => { if (e.bounds) this.bounds = e.bounds; })
      .when(live, (el) => el.child(this.transport("bar", t, true)))
      .child(
        h_flex().id("bar-open").flex_1().min_w(0).h(22).px(6).gap(8).items_center().rounded(4)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.togglePopup())
          .child(div().flex_none().text_color(playing ? t.accent : t.dim).child(svg(`${DIR}/note.svg`).size(13)))
          .child(div().flex_1().min_w(0).truncate().text_color(live ? t.foreground : t.dim).child(text)));
  }

  // A thin bar you click to set a fraction (seek, volume).
  slider(id, frac, t, onPick) {
    return div()
      .id(id)
      .flex_1()
      .h(14)
      .flex()
      .items_center()
      .cursor_pointer()
      .on_mouse_down("left", (e, cx) => {
        if (!e.bounds || !e.local_position || e.bounds.width <= 0) return;
        onPick(clamp(e.local_position.x / e.bounds.width, 0, 1), cx);
      })
      .child(div().w_full().h(4).rounded(2).bg(t.raised).flex()
        .child(div().h(4).rounded(2).bg(t.accent).flex_basis(`${Math.round(frac * 1000) / 10}%`)));
  }

  renderPopup(t) {
    const tr = this.track;
    const live = this.live;
    const frac = live && tr.dur > 0 ? clamp(tr.pos / tr.dur, 0, 1) : 0;
    const run = (script) => (cx) => this.control(script, cx);

    const art = this.art && live
      ? image(this.art).size(56).rounded(6).flex_none()
      : div().size(56).rounded(6).flex_none().bg(t.raised).flex().items_center().justify_center()
          .text_color(t.dim).child(svg(`${DIR}/note.svg`).size(22));

    const info = v_flex().flex_1().min_w(0).gap(2).pt(4)
      .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(live ? tr.name : this.message))
      .child(div().truncate().text_size(12).text_color(t.muted).child(live ? tr.artist : "Spotify"));

    const close = div().id("sp-close").flex_none().size(22).rounded(11).flex().items_center().justify_center()
      .cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Close")
      .on_click(() => closeOverlay(this.overlay))
      .child(svg(`${DIR}/close.svg`).size(11));

    const progress = h_flex().items_center().gap(8).text_size(10).text_color(t.dim)
      .child(div().w(38).flex_none().child(live ? fmt(tr.pos) : ""))
      .child(this.slider("sp-seek", frac, t, (f, cx) => {
        if (!live || !(tr.dur > 0)) return;
        tr.pos = f * tr.dur;
        cx.notify();
        this.control(tell(`set player position to ${(f * tr.dur).toFixed(1)}`), cx);
      }))
      .child(div().w(38).flex_none().text_right().child(live ? fmt(tr.dur) : ""));

    const controls = h_flex().items_center().justify_between()
      .child(this.button("sp-shuffle", "shuffle", 14, 28, t,
        run(tell(`set shuffling to ${!tr?.shuffle}`)), { tip: tr?.shuffle ? "Shuffle on" : "Shuffle off", active: tr?.shuffle }))
      .child(this.transport("sp", t, false))
      .child(this.button("sp-repeat", "repeat", 14, 28, t,
        run(tell(`set repeating to ${!tr?.repeat}`)), { tip: tr?.repeat ? "Repeat on" : "Repeat off", active: tr?.repeat }));

    const vol = tr?.vol ?? 0;
    const link = webLink(tr?.uri);
    const copied = Date.now() - this.copied < 1500;
    const footer = h_flex().items_center().gap(6).text_size(10).text_color(t.dim)
      .child(this.button("sp-mute", vol === 0 ? "mute" : "volume", 14, 24, t, (cx) => {
        if (!tr) return;
        if (vol > 0) this.lastVol = vol;
        const next = vol > 0 ? 0 : this.lastVol || 50;
        tr.vol = next;
        cx.notify();
        this.control(tell(`set sound volume to ${next}`), cx);
      }, { tip: vol === 0 ? "Unmute" : "Mute" }))
      .child(this.slider("sp-vol", vol / 100, t, (f, cx) => {
        if (!tr) return;
        tr.vol = Math.round(f * 100);
        cx.notify();
        this.control(tell(`set sound volume to ${tr.vol}`), cx);
      }))
      .child(div().w(26).flex_none().text_right().child(live ? `${vol}%` : ""))
      .child(div().w(6).flex_none())
      .child(this.button("sp-copy", copied ? "check" : "link", 13, 24, t, (cx) => {
        if (!link) return;
        cx.write_to_clipboard(link);
        this.copied = Date.now();
        cx.notify();
        cx.timer.after(1600, (cx) => cx.notify());
      }, { tip: copied ? "Copied" : "Copy link", active: copied }))
      .child(this.button("sp-open", "open", 13, 24, t, run(`tell application "Spotify" to activate`), { tip: "Open in Spotify" }));

    return v_flex()
      .id("spotify-popup")
      .size_full()
      .px(14)
      .py(12)
      .gap(8)
      .bg(t.popover)
      .on_mouse_down_out(() => setShared(CLOSED_KEY, Date.now()))
      .child(h_flex().items_start().gap(12).child(art).child(info).child(close))
      .child(progress)
      .child(controls)
      .child(footer);
  }

  render() {
    const t = theme();
    return this.popup ? this.renderPopup(t) : this.renderBar(t);
  }
}
