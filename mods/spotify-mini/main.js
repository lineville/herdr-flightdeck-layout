// A tiny Spotify player. In a layout block (the Flight Deck status bar) it is a
// slim now-playing item with play/pause; clicking it toggles a popup player
// (mod.open spotify-mini) with artwork, progress, and -15s, previous,
// play/pause, next and +15s. Talks to the Spotify app on macOS through
// osascript; it never launches Spotify by itself.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, props, run, theme, appHome } from "herdr";

const DIR = "mods/spotify-mini";
const ART_DIR = "cache/spotify-mini"; // under the app home, outside the mod folder so saves don't reload it
const SEP = "\u001f";

const READ = `
if application "Spotify" is not running then return "off"
tell application "Spotify"
  set s to player state as string
  if s is "stopped" then return "stopped"
  set t to current track
  set sep to character id 31
  return s & sep & (name of t) & sep & (artist of t) & sep & (album of t) & sep & (artwork url of t) & sep & (player position as string) & sep & ((duration of t) as string)
end tell`;

const SKIP = (sec) =>
  `tell application "Spotify"
  set p to (player position) + (${sec})
  if p < 0 then set p to 0
  set player position to p
end tell`;

const fmt = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

export default class SpotifyMini extends View {
  init(_props, cx) {
    this.popup = Boolean(props()?.overlay);
    this.state = "loading"; // off | stopped | playing | paused | loading | error
    this.track = null;
    this.art = null;
    this.width = 340;
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
    const [state, name, artist, album, artUrl, pos, dur] = out.split(SEP);
    this.state = state;
    this.track = {
      name,
      artist: artist || album,
      pos: parseFloat((pos ?? "").replace(",", ".")),
      dur: parseFloat(dur) / 1000,
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

  tell(cmd) {
    return `tell application "Spotify" to ${cmd}`;
  }

  get live() {
    return Boolean(this.track) && (this.state === "playing" || this.state === "paused");
  }

  get message() {
    return this.state === "off" ? "Spotify isn't running" :
      this.state === "stopped" ? "Nothing playing" :
      this.state === "error" ? "Can't reach Spotify" : "Loading…";
  }

  button(id, icon, size, script, t, label) {
    return h_flex()
      .id(id)
      .flex_none()
      .h(size + 12)
      .min_w(size + 12)
      .px(label ? 6 : 0)
      .gap(2)
      .rounded((size + 12) / 2)
      .items_center()
      .justify_center()
      .cursor_pointer()
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.control(script, cx); })
      .child(svg(`${DIR}/${icon}.svg`).size(size))
      .when(Boolean(label), (el) => el.child(div().text_size(10).font_semibold().child(label)));
  }

  renderBar(t) {
    const live = this.live;
    const playing = this.state === "playing";
    const text = live ? `${this.track.name}${this.track.artist ? `  ·  ${this.track.artist}` : ""}` : this.message;
    return h_flex()
      .id("spotify-bar")
      .size_full()
      .pl(12)
      .pr(6)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_l(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("mod.open", { name: "spotify-mini" }))
      .child(div().flex_none().text_color(playing ? t.accent : t.dim).child(svg(`${DIR}/note.svg`).size(13)))
      .child(div().flex_1().min_w(0).truncate().text_color(live ? t.foreground : t.dim).child(text))
      .when(live, (el) => el.child(
        this.button("bar-play", playing ? "pause" : "play", 11, this.tell("playpause"), t)));
  }

  renderPopup(t) {
    const tr = this.track;
    const live = this.live;
    const frac = live && tr.dur > 0 ? Math.min(1, Math.max(0, tr.pos / tr.dur)) : 0;

    const art = this.art && live
      ? image(this.art).size(56).rounded(6).flex_none()
      : div().size(56).rounded(6).flex_none().bg(t.raised).flex().items_center().justify_center()
          .text_color(t.dim).child(svg(`${DIR}/note.svg`).size(22));

    const info = v_flex().flex_1().min_w(0).gap(2)
      .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(live ? tr.name : this.message))
      .child(div().truncate().text_size(12).text_color(t.muted).child(live ? tr.artist : "Spotify"));

    const barW = Math.max(0, this.width - 28 - 84);
    const progress = h_flex().items_center().gap(8).text_size(10).text_color(t.dim)
      .child(div().w(34).flex_none().child(live ? fmt(tr.pos) : ""))
      .child(div().flex_1().h(3).rounded(2).bg(t.raised)
        .child(div().h(3).rounded(2).bg(t.accent).w(barW * frac)))
      .child(div().w(34).flex_none().text_right().child(live ? fmt(tr.dur) : ""));

    const controls = h_flex().items_center().justify_center().gap(6)
      .child(this.button("sp-back", "back15", 13, SKIP(-15), t, "15"))
      .child(this.button("sp-prev", "prev", 14, this.tell("previous track"), t))
      .child(this.button("sp-play", this.state === "playing" ? "pause" : "play", 18, this.tell("playpause"), t))
      .child(this.button("sp-next", "next", 14, this.tell("next track"), t))
      .child(this.button("sp-fwd", "fwd15", 13, SKIP(15), t, "15"));

    return v_flex()
      .id("spotify-popup")
      .size_full()
      .px(14)
      .py(12)
      .gap(8)
      .bg(t.popover)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(h_flex().items_center().gap(12).child(art).child(info))
      .child(progress)
      .child(controls);
  }

  render() {
    const t = theme();
    return this.popup ? this.renderPopup(t) : this.renderBar(t);
  }
}
