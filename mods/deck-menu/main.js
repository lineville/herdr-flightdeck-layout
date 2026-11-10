// Right-click menu for the tree sidebar. props:
//   { kind: "space", space }
//   { kind: "worktree", space, path, branch, main, git, empty, pr: { number, url }?, ticket: { id, url }? }
// A worktree's "Open agent" opens a sub-panel of the installed agents, as the tab bar's
// + menu lists them. ↑/↓ move, Enter or → runs or opens, ← or Esc goes back or closes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, exec, knownAgents, shared, setShared } from "herdr";

// The same cache the + menu (deck-new-menu) keeps: the last agents each machine reported.
const KNOWN = "new-menu.agents";
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

// Each item: { label, icon: { svg, color? } | { image }, run?, sub? }.
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
    { label: "Open agent", icon: icon("plus"), sub: true },
    { label: "New terminal", icon: icon("terminal"), run: () => run("tab.new", { space: p.space, folder: p.path, name: p.branch }) },
    ...(mine.length ? [{ label: "Close its tabs", icon: icon("x"), run: () => mine.forEach((t) => run("tab.close", { id: t.id, confirmed: true })) }] : []),
    ...(p.empty ? [{ label: "Hide from sidebar", icon: icon("x"), run: hide(p.space, p.path) }] : []),
    ...(p.git && !p.main ? [{ label: "Remove worktree…", icon: icon("archive"), run: () => dialog({ space: p.space, folder: p.path, action: "remove" }) }] : []),
  ];
}

export default class DeckMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.sub = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props() ?? {};
    if (p.kind !== "worktree") return;
    const machine = spaces().find((s) => s.id === p.space)?.machine ?? null;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      } catch { this.failed = true; }
      cx.notify();
    });
  }

  // The agent sub-panel: back, then each installed agent, started as a tab in the worktree.
  agentItems(p) {
    const back = { label: "Open agent", icon: icon("chevron-left"), back: true };
    const list = (this.agents ?? []).filter((a) => a.installed).map((a) => ({
      label: a.name,
      icon: a.tint ? { svg: a.icon, color: "foreground" } : { image: a.icon },
      run: () => run("tab.new", { space: p.space, folder: p.path, name: p.branch, argv: a.run }),
    }));
    return [back, ...list];
  }

  list(p) {
    return this.sub ? this.agentItems(p) : items(p);
  }

  enter(sub, cx) {
    this.sub = sub;
    this.at = sub ? 1 : Math.max(0, items(props() ?? {}).findIndex((it) => it.sub));
    cx.notify();
  }

  choose(i, cx) {
    const p = props() ?? {};
    const it = this.list(p)[i];
    if (!it) return;
    if (it.sub) return this.enter(true, cx);
    if (it.back) return this.enter(false, cx);
    closeOverlay(p.overlay);
    it.run();
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const list = this.list(p);
    const waiting = this.sub && list.length === 1;
    const glyph = (ic) => ic.image
      ? image(ic.image).size(14).flex_none()
      : svg(ic.svg).size(14).flex_none().text_color(t[ic.color] ?? ic.color ?? t.muted);
    return v_flex().id("deck-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") return this.choose(this.at, cx);
        else if (e.key === "right" && list[this.at]?.sub) return this.enter(true, cx);
        else if ((e.key === "left" || e.key === "escape") && this.sub) return this.enter(false, cx);
        else if (e.key === "escape") return closeOverlay(p.overlay);
        else return;
        cx.notify();
      })
      .when(p.kind === "worktree", (el) => el.child(div().px(8).pt(4).pb(5).text_size(11).text_color(t.dim).truncate().child(p.branch ?? "")))
      .children(list.map((it, i) => h_flex().id(`mi-${this.sub ? "a" : "m"}-${i}`).h(30).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(i, cx))
        .child(glyph(it.icon))
        .child(div().flex_1().truncate().when(Boolean(it.back), (el) => el.text_color(t.muted)).child(it.label))
        .when(Boolean(it.sub), (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(12).flex_none().text_color(t.dim)))))
      .when(waiting, (el) => el.child(div().px(8).py(6).text_color(t.dim).child(this.failed ? "Could not check installed agents" : "Checking installed agents…")));
  }
}
