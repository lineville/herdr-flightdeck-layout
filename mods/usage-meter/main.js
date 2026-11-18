// Quiet usage meters for the Flight Deck status bar: Claude Code and Codex, one
// chip per limit window (Claude: 5h and wk; Codex: wk), each a tag, a thin bar
// and its percent. A faint tick on the bar marks how much of the window has
// elapsed: a fill past it is using the limit faster than it resets. Hover for
// every window's percent, plus per-model limits (Fable today); click
// anything to refresh.
// fetch.py reads the CLIs' own tokens and calls their usage endpoints.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, props, theme, appHome, checking } from "herdr";

const POLL_MS = 3 * 60 * 1000;
const DEMO = {
  claude: {
    windows: [{ label: "5h", percent: 42, resets: null }, { label: "week", percent: 18, resets: null }],
    extras: [{ label: "Fable week", percent: 11, resets: null }],
  },
  codex: { windows: [{ label: "week", percent: 7, resets: null }] },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default class UsageMeter extends View {
  init(_props, cx) {
    this.demo = Boolean(props()?.demo);
    this.data = this.demo ? DEMO : null;
    this.busy = false;
    if (this.demo || checking()) return;
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.busy || this.demo) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/usage-meter/fetch.py`], { timeout: 30000 });
        this.data = JSON.parse(r.stdout.trim());
      } catch {
        this.data = { claude: { error: "failed" }, codex: { error: "failed" } };
      }
      this.busy = false;
      cx.notify();
    });
  }

  color(pct, t) {
    return pct >= 90 ? t.blocked : pct >= 75 ? t.ansi3 : t.accent;
  }

  // How far into the window we are, 0..1, or null when the window's length or reset is unknown.
  elapsed(w) {
    if (!w.length || !w.resets) return null;
    return clamp(1 - (w.resets - Date.now() / 1000) / w.length, 0, 1);
  }

  // One window: a short tag (5h, wk), a thin bar with a pace tick, and its percent.
  chip(id, w, tip, t) {
    const pct = clamp(w.percent, 0, 100);
    const pace = this.elapsed(w);
    const hot = w.percent >= 75 || (pace != null && w.percent / 100 > pace + 0.02);
    const bar = div().relative().w(30).h(4).flex_none().rounded(2).bg(t.raised).flex()
      .child(div().h(4).rounded(2).bg(this.color(w.percent, t)).flex_basis(`${pct}%`))
      .when(pace != null, (el) => el.child(
        div().absolute().top(-2).h(8).w(1).bg(t.foreground).opacity(0.55).left(`${Math.round(pace * 1000) / 10}%`)));
    return h_flex().id(id).h(22).px(5).gap(5).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_click((_e, cx) => this.refresh(cx))
      .child(div().text_size(10).text_color(t.dim).child(w.label === "week" ? "wk" : w.label))
      .child(bar)
      .child(div().min_w(24).text_right().text_color(w.percent >= 75 ? this.color(w.percent, t) : hot ? t.foreground : t.muted)
        .child(`${Math.round(w.percent)}%`));
  }

  meter(id, name, info, t) {
    const windows = info?.windows ?? [];
    const label = (l) => (l === "week" ? "Weekly" : l.replace(/ week$/, ""));
    const tip = info?.error
      ? `${name}: ${info.error}`
      : windows.length
        ? [...windows, ...(info?.extras ?? [])].map((w) => `${label(w.label)} ${Math.round(w.percent)}%`).join(" · ")
        : "Loading";
    const head = div().id(`${id}-name`).px(4).text_color(t.dim).tooltip(tip)
      .cursor_pointer().on_click((_e, cx) => this.refresh(cx)).child(name);
    const row = h_flex().items_center().child(head);
    if (info?.error || !windows.length) {
      return row.child(div().px(4).text_color(t.dim).tooltip(tip).child(info?.error ? "–" : "…"));
    }
    return row.children(windows.map((w, i) => this.chip(`${id}-${i}`, w, tip, t)));
  }

  render() {
    const t = theme();
    const d = this.data;
    return h_flex().size_full().px(6).gap(2).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_l(1).border_color(t.border)
      .text_size(11.8)
      .child(this.meter("um-claude", "Claude", d?.claude, t))
      .child(div().w(1).h(12).mx(4).bg(t.border))
      .child(this.meter("um-codex", "Codex", d?.codex, t));
  }
}
