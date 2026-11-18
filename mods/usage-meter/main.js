// Two quiet usage meters for the Flight Deck status bar: Claude Code and Codex,
// each with a thin bar per limit window (Claude: 5h and week; Codex: week) and
// the highest percent. Hover for the windows and reset times; click to refresh.
// fetch.py reads the CLIs' own tokens and calls their usage endpoints.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, props, theme, appHome, checking } from "herdr";

const POLL_MS = 3 * 60 * 1000;
const DEMO = {
  claude: { windows: [{ label: "5h", percent: 42, resets: null }, { label: "week", percent: 18, resets: null }] },
  codex: { windows: [{ label: "week", percent: 7, resets: null }] },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const until = (epoch) => {
  if (!epoch) return "";
  const s = Math.max(0, epoch - Date.now() / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

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

  meter(id, name, info, t) {
    const windows = info?.windows ?? [];
    const top = windows.length ? Math.max(...windows.map((w) => w.percent)) : null;
    const tip = info?.error
      ? `${name}: ${info.error}`
      : windows.length
        ? `${name} · ${windows.map((w) => `${w.label} ${Math.round(w.percent)}%${w.resets ? ` (resets in ${until(w.resets)})` : ""}`).join(" · ")}`
        : `${name}: loading`;
    const bars = v_flex().w(40).flex_none().gap(2).justify_center()
      .children((windows.length ? windows : [{ percent: 0 }]).map((w) =>
        div().w_full().h(3).rounded(2).bg(t.raised).flex()
          .child(div().h(3).rounded(2).bg(this.color(w.percent, t)).flex_basis(`${clamp(w.percent, 0, 100)}%`))));
    return h_flex().id(id).h(22).px(6).gap(6).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_click((_e, cx) => this.refresh(cx))
      .child(div().text_color(t.dim).child(name))
      .child(bars)
      .child(div().w(28).flex_none().text_right()
        .text_color(info?.error ? t.dim : top == null ? t.dim : top >= 75 ? this.color(top, t) : t.muted)
        .child(info?.error ? "–" : top == null ? "…" : `${Math.round(top)}%`));
  }

  render() {
    const t = theme();
    const d = this.data;
    return h_flex().size_full().px(6).gap(2).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_l(1).border_color(t.border)
      .text_size(11.8)
      .child(this.meter("um-claude", "Claude", d?.claude, t))
      .child(this.meter("um-codex", "Codex", d?.codex, t));
  }
}
