// Right-click menu for the tree sidebar. props:
//   { kind: "space", space }
//   { kind: "worktree", space, path, branch, main, git }
// ↑/↓ move, Enter runs, Esc closes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes } from "herdr";

const dialog = (p, big) => openOverlay({ mod: "deck-worktree", kind: "dialog", width: big ? 560 : 460, height: big ? 480 : 280, props: p });

function items(p) {
  if (p.kind === "space") {
    return [
      ["New worktree…", "git-branch", () => dialog({ space: p.space, action: "new" })],
      ["Open worktree…", "git-branch", () => dialog({ space: p.space, action: "open" }, true)],
      ["Rename space", "square-pen", () => run("space.rename", { id: p.space })],
      ["Close space", "x", () => run("space.close", { id: p.space })],
    ];
  }
  const tab = (argv, name) => () => run("tab.new", { space: p.space, folder: p.path, name: p.branch, argv });
  // Tabs whose every pane is in this worktree.
  const s = spaces().find((x) => x.id === p.space);
  const mine = (s?.tabs ?? []).filter((t) => {
    const ps = panes().filter((x) => x.tab === t.id && x.terminal);
    return ps.length && ps.every((x) => x.cwd && (x.cwd === p.path || x.cwd.startsWith(p.path + "/")));
  });
  return [
    ["New Pi agent", "plus", tab(["pi"])],
    ["New Claude agent", "plus", tab(["claude"])],
    ["New terminal", "terminal", tab(undefined)],
    ...(mine.length ? [["Close its tabs", "x", () => mine.forEach((t) => run("tab.close", { id: t.id, confirmed: true }))]] : []),
    ...(p.git && !p.main ? [["Remove worktree…", "archive", () => dialog({ space: p.space, folder: p.path, action: "remove" })]] : []),
  ];
}

export default class DeckMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i) {
    const it = items(props() ?? {})[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    it[2]();
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const list = items(p);
    return v_flex().id("deck-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .when(p.kind === "worktree", (el) => el.child(div().px(8).pt(4).pb(5).text_size(11).text_color(t.dim).truncate().child(p.branch ?? "")))
      .children(list.map((it, i) => h_flex().id(`mi-${i}`).h(30).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click(() => this.choose(i))
        .child(svg(`mods/workspace-chrome/${it[1]}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(it[0]))));
  }
}
