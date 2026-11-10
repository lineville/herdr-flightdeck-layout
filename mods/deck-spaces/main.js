// Flight Deck sidebar: one tree. A space is a repo; under it, each worktree that has
// terminals open in that space; under each worktree, its agents. Worktrees are found
// from the panes' live folders, so a split or a `cd` lands in the right branch.
// It also gives every worktree a color and publishes the tree (shared "deck.tree")
// for the tab bar and the Flight Deck.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, terminals, setAgentOrder, run, openOverlay, exec, theme, shared, setShared, layout, window, pickFolder } from "herdr";

// Worktree colors. Kept clear of status colors (green, orange, amber) and the deck's cyan.
export const HUES = ["#8cabff", "#58d6b5", "#f257a5", "#b061ff", "#d9c27a", "#c0c4ff", "#e08cff", "#7fa7c9"];
// Space avatar colors, by stored name.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const SPACE_PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const REFRESH_MS = 20000;
const PR_REFRESH_MS = 60000;
const RAIL = 160;

// Pull request badges on worktree rows. `color` is a theme color name.
const PR = {
  failing: { color: "ansi1", label: "CI failing" },
  conflict: { color: "ansi1", label: "Merge conflict" },
  draft: { color: "dim", label: "Draft" },
  changes: { color: "ansi3", label: "Changes requested" },
  running: { color: "ansi3", label: "CI running" },
  approved: { color: "ansi2", label: "Approved" },
  review: { color: "ansi2", label: "Waiting on review" },
  merged: { color: "ansi5", label: "Merged" },
  closed: { color: "dim", label: "Closed" },
};
const PR_FIELDS = "number,url,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup";
const LINEAR_LINK = /https:\/\/linear\.app\/([\w-]+)\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d+)/g;

// A Linear ticket ID in a branch ("eng-123-fix", "cursor/eng-123-fix") or a PR title
// ("ENG-123: Fix"), upper-cased. Number 0 is a placeholder, not a ticket.
export function ticketId(text) {
  const m = /(?:^|[\/\s\[(])([a-z][a-z0-9]{1,9})-(\d+)(?=$|[-\/\s:\])_])/i.exec(text ?? "");
  return m && Number(m[2]) > 0 ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

// The Linear issue links in some text, in order, without repeats.
export function linearLinks(text) {
  const seen = new Map();
  for (const m of (text ?? "").matchAll(LINEAR_LINK)) {
    const id = m[2].toUpperCase();
    if (!seen.has(id)) seen.set(id, { id, workspace: m[1], url: `https://linear.app/${m[1]}/issue/${id}` });
  }
  return [...seen.values()];
}

// The PR's own ticket among its Linear links: the one the branch or title names,
// else the only one, else the first in the body.
export function pickTicket(links, branch, title, body) {
  const want = [ticketId(branch), ticketId(title)].filter(Boolean);
  for (const id of want) {
    const hit = links.find((l) => l.id === id);
    if (hit) return hit;
  }
  if (links.length === 1) return links[0];
  return linearLinks(body)[0] ?? links[0] ?? null;
}
const CHECK_FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const CHECK_STUCK_MS = 90 * 60000; // pending this long (codecov, say) never finishes
const GH = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

// A PR from `gh pr view --json` as one state and a tooltip. Draft wins: CI only
// matters once a PR is open for review.
export function prState(pr, now = Date.now()) {
  if (!pr) return null;
  if (pr.state === "MERGED") return { state: "merged", tip: `#${pr.number} merged` };
  if (pr.state === "CLOSED") return { state: "closed", tip: `#${pr.number} closed` };
  const checks = pr.statusCheckRollup ?? [];
  const failed = checks.filter((c) => CHECK_FAIL.has(c.conclusion || c.state));
  const pending = checks.filter((c) => {
    const waiting = c.__typename === "StatusContext" ? c.state === "PENDING" || c.state === "EXPECTED" : c.status && c.status !== "COMPLETED";
    const started = Date.parse(c.startedAt ?? "");
    return waiting && !(started && now - started > CHECK_STUCK_MS);
  });
  if (pr.isDraft) return { state: "draft", tip: `#${pr.number} draft` };
  const state = failed.length ? "failing"
    : pr.mergeable === "CONFLICTING" ? "conflict"
    : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes"
    : pending.length ? "running"
    : pr.reviewDecision === "APPROVED" ? "approved"
    : "review";
  const parts = [`#${pr.number}`];
  if (failed.length) parts.push(`${failed.length} check${failed.length === 1 ? "" : "s"} failing`);
  else if (pending.length) parts.push(`${pending.length} check${pending.length === 1 ? "" : "s"} running`);
  if (pr.mergeable === "CONFLICTING") parts.push("merge conflict");
  parts.push(pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : "waiting on review");
  return { state, tip: parts.join(" · ") };
}

const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
const base = (p) => (p ?? "").replace(/\/+$/, "").split("/").pop();
const top = (list) => list.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// What an agent is called: Pi's session name ("π - <name> - <folder>"), else the
// agent's own title, else its program.
export function agentLabel(a, cwd) {
  const title = (a.title ?? "").trim();
  const pi = /^π\s+-\s+(.*)$/.exec(title);
  if (pi) {
    let rest = pi[1];
    const folder = base(cwd);
    if (folder && rest === folder) rest = "";
    else if (folder && rest.endsWith(` - ${folder}`)) rest = rest.slice(0, -(folder.length + 3));
    return rest || "new session";
  }
  const prog = a.program?.name;
  const live = title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const telling = live && live !== prog && !/^[~/]/.test(live) && !live.includes("@") && live.toLowerCase() !== a.program?.key;
  return telling ? live : prog || a.address;
}

// `git worktree list --porcelain` as [{ path, branch, main }].
function parseWorktrees(out) {
  const list = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.includes("bare")) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    list.push({ path, branch, main: list.length === 0 });
  }
  return list;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.wt = {}; // space id -> { key, list, at }
    this.busy = false;
    this.prs = {}; // worktree path -> { branch, at, pr }
    this.prBusy = false;
    this.tickets = {}; // worktree path -> { number, ticket: { id, url } | null }
    this.teams = JSON.parse(localStorage.getItem("linear.teams") ?? "{}"); // "ENG" -> Linear workspace
    this.open = []; // [{ s, g }] worktrees shown, set on render
    this.folded = new Set(JSON.parse(localStorage.getItem("tree.folded") ?? "[]"));
    cx.timer.every(1000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  save() {
    localStorage.setItem("tree.folded", JSON.stringify([...this.folded]));
  }

  toggle(key, cx) {
    this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key);
    this.save();
    cx.notify();
  }

  // Reads each space's worktrees when it is new, when a pane sits outside every
  // known worktree (one was just made), or every REFRESH_MS while the window is in front.
  refresh(cx) {
    this.refreshPrs(cx);
    if (this.busy) return;
    const now = Date.now();
    const ps = panes();
    const due = [];
    for (const s of spaces()) {
      const tabs = new Set(s.tabs.map((t) => t.id));
      const cwds = ps.filter((p) => tabs.has(p.tab) && p.cwd).map((p) => p.cwd);
      const from = cwds[0] ?? s.folder;
      if (!from) continue;
      const known = this.wt[s.id];
      const stray = known?.list && cwds.some((c) => !known.list.some((w) => inside(c, w.path)));
      const stale = window()?.active && now - (known?.at ?? 0) > REFRESH_MS;
      if (!known || known.from !== from && !known.list || stray && now - known.at > 3000 || stale) due.push([s, from]);
    }
    if (!due.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      for (const [s, from] of due) {
        try {
          const r = await exec("git", ["worktree", "list", "--porcelain"], { cwd: from, on: s.machine });
          this.wt[s.id] = { from, at: Date.now(), list: r.code === 0 ? parseWorktrees(r.stdout) : null };
        } catch {
          this.wt[s.id] = { from, at: Date.now(), list: this.wt[s.id]?.list ?? null };
        }
      }
      this.busy = false;
      cx.notify();
    });
  }

  // Runs gh, finding it once: the app may not have Homebrew on its PATH.
  async gh(args, cwd, on) {
    if (on) return exec("gh", args, { cwd, on, timeout: 20000 });
    for (const bin of this.ghBin ? [this.ghBin] : GH) {
      try {
        const r = await exec(bin, args, { cwd, timeout: 20000 });
        if (r.code === 127) continue;
        this.ghBin = bin;
        return r;
      } catch {}
    }
    return null;
  }

  // Reads each shown branch worktree's PR when its branch changes, or every
  // PR_REFRESH_MS while the window is in front. No PR is remembered as null.
  refreshPrs(cx) {
    if (this.prBusy) return;
    const now = Date.now();
    const active = window()?.active;
    const due = this.open.filter(({ g }) => {
      if (!g.git || ["detached", "main", "master"].includes(g.branch)) return false;
      const known = this.prs[g.path];
      return !known || known.branch !== g.branch || active && now - known.at > PR_REFRESH_MS;
    });
    if (!due.length) return;
    this.prBusy = true;
    cx.spawn(async (cx) => {
      for (const { s, g } of due) {
        let pr = null;
        try {
          const r = await this.gh(["pr", "view", g.branch, "--json", PR_FIELDS], g.path, s.machine);
          if (r?.code === 0) pr = JSON.parse(r.stdout);
        } catch {}
        this.prs[g.path] = { branch: g.branch, at: Date.now(), pr };
        if (pr && this.tickets[g.path]?.number !== pr.number) await this.readTicket(s, g, pr);
      }
      this.prBusy = false;
      cx.notify();
    });
  }

  prBadge(s, g, t) {
    const known = this.prs[g.path];
    if (!known?.pr || known.branch !== g.branch) return null;
    const info = prState(known.pr);
    const look = PR[info.state];
    const icon = info.state === "draft" || info.state === "merged" || info.state === "closed" ? info.state
      : info.state === "review" ? "open" : info.state;
    return div().id(`pr-${s.id}-${g.path}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t[look.color] ?? t.dim).hover((st) => st.bg(t.hover)).tooltip(`${look.label}: ${info.tip}`)
      .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [known.pr.url]).catch(() => {}); })
      .child(svg(`mods/deck-spaces/pr/${icon}.svg`).size(12));
  }

  // A space's worktrees that have terminals open, main checkout first, each with
  // its tabs, panes and agents.
  groups(s, ps, list) {
    const known = this.wt[s.id]?.list ?? [];
    const tabs = new Set(s.tabs.map((t) => t.id));
    const by = new Map();
    for (const p of ps) {
      if (!tabs.has(p.tab) || !p.terminal) continue;
      const cwd = p.cwd ?? s.folder;
      const wt = known.filter((w) => cwd && inside(cwd, w.path)).sort((a, b) => b.path.length - a.path.length)[0];
      const path = wt?.path ?? cwd ?? "";
      if (!by.has(path)) by.set(path, { path, branch: wt ? wt.branch ?? "detached" : p.branch ?? base(cwd), main: Boolean(wt?.main), git: Boolean(wt), tabs: [], panes: [], agents: [], order: by.size });
      const g = by.get(path);
      g.panes.push(p.pane);
      if (!g.tabs.includes(p.tab)) g.tabs.push(p.tab);
    }
    const paneOf = new Map();
    for (const g of by.values()) for (const p of g.panes) paneOf.set(p, g);
    for (const a of list) paneOf.get(a.pane)?.agents.push(a);
    return [...by.values()].sort((a, b) => b.main - a.main || a.order - b.order);
  }

  // Gives every open worktree a color that sticks, the least used first. Colors of
  // worktrees git no longer lists are dropped.
  colors(trees) {
    const old = shared("worktree.colors") ?? {};
    const next = { ...old };
    const listed = new Set(Object.values(this.wt).flatMap((w) => (w.list ?? []).map((x) => x.path)));
    const open = new Set(trees.flatMap((t) => t.groups.map((g) => g.path)));
    const loaded = spaces().every((s) => this.wt[s.id]);
    if (loaded) for (const k of Object.keys(next)) if (!listed.has(k) && !open.has(k)) delete next[k];
    for (const path of open) {
      if (next[path]) continue;
      const uses = (c) => Object.values(next).filter((v) => v === c).length;
      next[path] = HUES.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    }
    if (JSON.stringify(next) !== JSON.stringify(old)) setShared("worktree.colors", next);
    return next;
  }

  spaceColors(sp) {
    const old = shared("space.colors") ?? {};
    const ids = new Set(sp.map((s) => s.id));
    const kept = Object.fromEntries(Object.entries(old).filter(([id]) => ids.has(id)));
    for (const s of sp) {
      if (kept[s.id]) continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[s.id] = SPACE_PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    }
    if (JSON.stringify(kept) !== JSON.stringify(old)) setShared("space.colors", kept);
    return kept;
  }

  // What the tab bar and the Flight Deck need: each pane's worktree, each worktree's look.
  publish(trees, colors) {
    const tree = { panes: {}, worktrees: {}, spaces: {} };
    for (const { s, groups } of trees) {
      tree.spaces[s.id] = groups.map((g) => g.path);
      for (const g of groups) {
        const pr = this.prs[g.path]?.branch === g.branch ? this.prs[g.path].pr : null;
        tree.worktrees[g.path] = { branch: g.branch, main: g.main, color: colors[g.path] ?? HUES[0], space: s.id, pr: pr ? { number: pr.number, url: pr.url, state: prState(pr).state } : null };
        for (const p of g.panes) tree.panes[p] = g.path;
      }
    }
    if (JSON.stringify(tree) !== JSON.stringify(shared("deck.tree"))) setShared("deck.tree", tree);
  }

  // Live sub-agents of `addr`, depth first.
  kids(addr, depth = 1) {
    return this.terms.filter((k) => k.parent === addr && k.state === "live").flatMap((k) => [{ k, depth }, ...this.kids(k.address, depth + 1)]);
  }

  status(t, s, size = 12) {
    if (s === "working") return svg("mods/workspace-chrome/spinner.svg").size(size).flex_none().text_color(t.working).spin(900);
    if (s === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (s === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done ?? t.dim);
    if (s === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none();
  }

  chevron(key, t, cx) {
    const open = !this.folded.has(key);
    return div().id(`fold-${key}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(key, cx); })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11));
  }

  plus(id, tip, t, action) {
    return div().id(id).size(18).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); })
      .child(svg("mods/workspace-chrome/plus.svg").size(11));
  }

  // Finds the PR's Linear ticket in its body and comments (the Linear bot links it in a
  // comment), once per PR, and learns which workspace each team prefix lives in.
  async readTicket(s, g, pr) {
    try {
      const r = await this.gh(["pr", "view", String(pr.number), "--json", "body,comments"], g.path, s.machine);
      if (r?.code !== 0) return;
      const { body, comments } = JSON.parse(r.stdout);
      const links = linearLinks([body, ...(comments ?? []).map((c) => c.body)].join("\n"));
      let learned = false;
      for (const l of links) {
        const team = l.id.split("-")[0];
        if (this.teams[team] !== l.workspace) { this.teams[team] = l.workspace; learned = true; }
      }
      if (learned) localStorage.setItem("linear.teams", JSON.stringify(this.teams));
      const hit = pickTicket(links, g.branch, pr.title, body);
      this.tickets[g.path] = { number: pr.number, ticket: hit && { id: hit.id, url: hit.url } };
    } catch {}
  }

  // The worktree's PR and Linear ticket, for its right-click menu.
  links(g) {
    const known = this.prs[g.path];
    const pr = known?.branch === g.branch ? known.pr : null;
    let ticket = pr && this.tickets[g.path]?.number === pr.number ? this.tickets[g.path].ticket : null;
    if (!ticket) {
      const id = ticketId(g.branch) ?? ticketId(pr?.title);
      const workspace = id && this.teams[id.split("-")[0]];
      if (workspace) ticket = { id, url: `https://linear.app/${workspace}/issue/${id}` };
    }
    return { pr: pr && { number: pr.number, url: pr.url }, ticket };
  }

  menu(props, height = 220) {
    openOverlay({ mod: "deck-menu", kind: "popup", width: 220, height, props });
  }

  // Height of the worktree menu: a branch label, then its items (see deck-menu).
  worktreeMenu(s, g) {
    const { pr, ticket } = this.links(g);
    const mine = s.tabs.filter((tab) => {
      const ps = this.ps.filter((x) => x.tab === tab.id && x.terminal);
      return ps.length && ps.every((x) => x.cwd && inside(x.cwd, g.path));
    });
    const count = 3 + (pr ? 1 : 0) + (ticket ? 1 : 0) + (mine.length ? 1 : 0) + (g.git && !g.main ? 1 : 0);
    this.menu({ kind: "worktree", space: s.id, path: g.path, branch: g.branch, main: g.main, git: g.git, pr, ticket }, 36 + count * 30);
  }

  spaceRow(s, groups, fill, t) {
    const key = `s:${s.id}`;
    const folded = this.folded.has(key);
    const all = groups.flatMap((g) => g.agents);
    const worst = top(all.map((a) => a.status));
    return h_flex().id(`space-${s.id}`).h(30).flex_none().pl(4).pr(6).gap(6).items_center().rounded(7)
      .when(s.active, (el) => el.bg(t.selected)).when(!s.active, (el) => el.hover((st) => st.bg(t.hover)))
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => this.menu({ kind: "space", space: s.id }))
      .child(this.chevron(key, t))
      .child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?"))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(s.name))
      .when(folded && all.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(all.length))))
      .when(folded && worst && worst !== "idle", (el) => el.child(this.status(t, worst)))
      .child(this.plus(`wt-new-${s.id}`, "New worktree", t, () => openOverlay({ mod: "deck-worktree", kind: "dialog", width: 460, height: 280, props: { space: s.id, action: "new" } })));
  }

  worktreeRow(s, g, color, t) {
    const key = `w:${s.id}:${g.path}`;
    const folded = this.folded.has(key);
    const shown = s.active && s.tabs.find((x) => x.active && g.tabs.includes(x.id));
    const worst = top(g.agents.map((a) => a.status));
    const badge = this.prBadge(s, g, t);
    return h_flex().id(`wt-${s.id}-${g.path}`).h(26).flex_none().pl(18).pr(6).gap(6).items_center().rounded(7)
      .when(Boolean(shown), (el) => el.bg(t.hover)).hover((st) => st.bg(t.hover))
      .on_click(() => { run("space.select", { id: s.id }); run("tab.select", { id: g.tabs[0] }); })
      .on_mouse_down("right", () => this.worktreeMenu(s, g))
      .child(g.agents.length ? this.chevron(key, t) : div().w(16).flex_none())
      .child(div().size(8).flex_none().rounded(4).bg(color))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(g.branch))
      .when(folded && g.agents.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(g.agents.length))))
      .when(folded && worst && worst !== "idle", (el) => el.child(this.status(t, worst)))
      .when(Boolean(badge), (el) => el.child(badge))
      .child(this.plus(`ag-new-${s.id}-${g.path}`, "New Pi agent here", t, () => run("tab.new", { space: s.id, folder: g.path, name: g.branch, argv: ["pi"] })));
  }

  agentRows(g, color, t) {
    const cwdOf = new Map(this.ps.map((p) => [p.pane, p.cwd]));
    return g.agents.flatMap((a) => {
      const p = a.program;
      const pic = p?.icon ? (p.tint ? svg(p.icon).size(13).flex_none().text_color(t.muted) : image(p.icon).w(13).h(13).flex_none()) : div().w(13);
      const quiet = a.status === "idle" && !a.focused;
      const head = h_flex().id(`ag-${a.address}`).h(24).flex_none().pl(40).pr(8).gap(7).items_center().rounded(7).text_size(12.5).cursor_pointer()
        .when(a.focused, (el) => el.bg(t.selected)).when(!a.focused, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .child(div().absolute().left(25).top(0).bottom(0).w(1).bg(color + "66"))
        .child(pic)
        .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(agentLabel(a, cwdOf.get(a.pane))))
        .child(this.status(t, a.status));
      const subs = this.kids(a.address).map(({ k, depth }) => h_flex().id(`sub-${k.address}`).h(22).flex_none().pl(40 + 12 * depth).pr(8).gap(7).items_center().rounded(7).text_size(12).cursor_pointer()
        .hover((st) => st.bg(t.hover))
        .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : run("terminal.peek", { terminal: k.address })))
        .child(div().absolute().left(25).top(0).bottom(0).w(1).bg(color + "66"))
        .child(div().flex_none().text_color(t.dim).child("\u2514"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(k.name || k.template || k.program?.name || k.address))
        .child(this.status(t, k.status === "error" ? "blocked" : k.status === "done" ? "idle" : this.listed.get(k.address) ?? k.status)));
      return [head.relative(), ...subs.map((r) => r.relative())];
    });
  }

  rail(trees, spaceColors, t) {
    return trees.map(({ s, groups }) => {
      const worst = top(groups.flatMap((g) => g.agents.map((a) => a.status)));
      const c = spaceColors[s.id] ?? "ansi6";
      return h_flex().flex_none().justify_center().child(h_flex().id(`rail-${s.id}`).relative().size(32).rounded(7).items_center().justify_center()
        .when(s.active, (el) => el.bg(t.selected)).when(!s.active, (el) => el.hover((st) => st.bg(t.hover)))
        .tooltip(s.name).on_click(() => run("space.select", { id: s.id }))
        .child(h_flex().size(20).rounded(5).bg(MARK[c] ?? t[c] ?? c).items_center().justify_center().text_size(11).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?"))
        .when(worst === "blocked" || worst === "done", (el) => el.child(div().absolute().right(3).top(3).size(7).rounded(4).bg(t[worst]))));
    });
  }

  render() {
    const t = theme();
    const sp = spaces();
    this.ps = panes();
    const list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    this.terms = terminals();
    // A sub-agent with its own pane shows under its parent, not as its own row.
    const nested = new Set(list.flatMap((a) => this.kids(a.address).map((x) => x.k.address)));
    const tops = list.filter((a) => !nested.has(a.address));
    const trees = sp.map((s) => ({ s, groups: this.groups(s, this.ps, tops.filter((a) => a.space === s.id)) }));
    this.open = trees.flatMap(({ s, groups }) => groups.map((g) => ({ s, g })));
    const colors = this.colors(trees);
    const spaceColors = this.spaceColors(sp);
    this.publish(trees, colors);
    setAgentOrder(trees.flatMap(({ groups }) => groups.flatMap((g) => g.agents.map((a) => a.address))));

    const narrow = (find(layout(), "sidebar")?.size?.px ?? Infinity) < RAIL;
    const needs = list.filter((a) => a.status === "blocked").length;
    const busy = list.filter((a) => a.status === "working").length;
    const newSpace = () => pickFolder({ prompt: "Open a repository as a space" }).then((folder) => folder && run("space.new", { folder }));
    const body = narrow
      ? this.rail(trees, spaceColors, t)
      : trees.flatMap(({ s, groups }) => {
        const c = spaceColors[s.id] ?? "ansi6";
        const rows = [this.spaceRow(s, groups, MARK[c] ?? t[c] ?? c, t)];
        if (this.folded.has(`s:${s.id}`)) return rows;
        for (const g of groups) {
          const color = colors[g.path] ?? HUES[0];
          rows.push(this.worktreeRow(s, g, color, t));
          if (!this.folded.has(`w:${s.id}:${g.path}`)) rows.push(...this.agentRows(g, color, t));
        }
        return [...rows, div().h(6).flex_none()];
      });

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).flex_none().pl(narrow ? 0 : 14).pr(narrow ? 0 : 8).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(narrow, (el) => el.justify_center())
        .when(!narrow, (el) => el.child(h_flex().gap(8).items_center()
          .child("Spaces")
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`${needs} need${needs === 1 ? "s" : ""} you`)))
          .when(busy > 0, (el) => el.child(div().text_color(t.working).child(`${busy} working`)))))
        .child(div().id("space-new").size(24).flex_none().flex().items_center().justify_center().rounded(6).tooltip("Open a repo as a space")
          .hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click(newSpace)
          .child(svg("mods/workspace-chrome/folder-plus.svg").size(14))))
      .child(v_flex().id("tree").flex_1().min_h(0).px(narrow ? 0 : 6).pb(14).gap(1).overflow_y_scrollbar().children(body));
  }
}
