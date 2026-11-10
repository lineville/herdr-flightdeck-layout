// Right-click menu for the tree sidebar. props:
//   { kind: "space", space }
//   { kind: "worktree", space, path, branch, main, git, empty, pr: { number, url }?, ticket: { id, url }? }
// ↑/↓ move, Enter runs, Esc closes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, exec, shared, setShared } from "herdr";

const LINEAR = "#5e6ad2";

const dialog = (p, big) => openOverlay({ mod: "deck-worktree", kind: "dialog", width: big ? 560 : 460, height: big ? 480 : 280, props: p });
const open = (url) => () => exec("open", [url]).catch(() => {});
// Drops a worktree from the tree's kept list (see deck-spaces).
const hide = (space, path) => () => {
  const kept = { ...(shared("deck.kept") ?? {}) };
  kept[space] = (kept[space] ?? []).filter((k) => k.path !== path);
  if (!kept[space].length) delete kept[space];
  setShared("deck.kept", kept);
};
const icon = (name, color) => ({ svg: name.includes("/") ? name : `mods/workspace-chrome/${name}.svg`, color });

// Each item: { label, icon: { svg, color? }, run }.
function items(p) {
  if (p.kind === "space") {
    return [
      { label: "New worktree…", icon: icon("git-branch"), run: () => dialog({ space: p.space, action: "new" }) },
      { label: "Open worktree…", icon: icon("git-branch"), run: () => dialog({ space: p.space, action: "open" }, true) },
      { label: "Rename space", icon: icon("square-pen"), run: () => run("space.rename", { id: p.space }) },
      { label: "Close space", icon: icon("x"), run: () => run("space.close", { id: p.space }) },
    ];
  }
  // Tabs whose every pane is in this worktree.
  const s = spaces().find((x) => x.id === p.space);
  const mine = (s?.tabs ?? []).filter((t) => {
    const ps = panes().filter((x) => x.tab === t.id && x.terminal);
    return ps.length && ps.every((x) => x.cwd && (x.cwd === p.path || x.cwd.startsWith(p.path + "/")));
  });
  return [
    ...(p.pr?.url ? [{ label: `Open PR #${p.pr.number}`, icon: icon("mods/deck-menu/github.svg", "foreground"), run: open(p.pr.url) }] : []),
    ...(p.ticket?.url ? [{ label: `Open ${p.ticket.id} in Linear`, icon: icon("mods/deck-menu/linear.svg", LINEAR), run: open(p.ticket.url) }] : []),
    { label: "Open Pi agent", icon: icon("icons/pi.svg", "foreground"), run: () => run("tab.new", { space: p.space, folder: p.path, name: p.branch, argv: ["pi"] }) },
    { label: "New terminal", icon: icon("terminal"), run: () => run("tab.new", { space: p.space, folder: p.path, name: p.branch }) },
    ...(mine.length ? [{ label: "Close its tabs", icon: icon("x"), run: () => mine.forEach((t) => run("tab.close", { id: t.id, confirmed: true })) }] : []),
    ...(p.empty ? [{ label: "Hide from sidebar", icon: icon("x"), run: hide(p.space, p.path) }] : []),
    ...(p.git && !p.main ? [{ label: "Remove worktree…", icon: icon("archive"), run: () => dialog({ space: p.space, folder: p.path, action: "remove" }) }] : []),
  ];
}

export default class DeckMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i) {
    const p = props() ?? {};
    const it = items(p)[i];
    if (!it) return;
    closeOverlay(p.overlay);
    it.run();
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
        .child(svg(it.icon.svg).size(14).flex_none().text_color(t[it.icon.color] ?? it.icon.color ?? t.muted))
        .child(div().flex_1().truncate().child(it.label))));
  }
}
