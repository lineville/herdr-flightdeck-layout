// Flight Deck sidebar: one tree. A space is a repo; under it, each worktree that has
// had terminals open in that space; under each worktree, its agents. Worktrees are found
// from the panes' live folders, so a split or a `cd` lands in the right branch. A
// worktree stays (shared "deck.kept") after its terminals close, until git stops
// listing it or it is hidden from its menu.
// It also gives every worktree a color and publishes the tree (shared "deck.tree")
// for the tab bar and the Flight Deck.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, terminals, focused, setAgentOrder, run, openOverlay, exec, theme, shared, setShared, layout, window, pickFolder, appHome, notify, nextCommand } from "herdr";

// Worktree colors. Kept clear of status colors (green, orange, amber) and the deck's cyan.
export const HUES = ["#8cabff", "#58d6b5", "#f257a5", "#b061ff", "#d9c27a", "#c0c4ff", "#e08cff", "#7fa7c9"];
// Space avatar colors, by stored name.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const SPACE_PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const REFRESH_MS = 20000;
const PR_REFRESH_MS = 60000;
// Caffeinate: one detached `caffeinate -ims` whose pid lives in a file under the app
// folder, so it outlives mod reloads and the window. Checked every CAFFEINE_MS.
const CAFFEINE_MS = 5000;
const CAFFEINE_PID = "cache/deck-spaces/caffeinate.pid";
// $1 is the pid file. Exits 0 when its pid is a live caffeinate.
const CAFFEINE_ALIVE = 'p=$(cat "$1" 2>/dev/null) && [ -n "$p" ] && [ "$(ps -p "$p" -o comm= 2>/dev/null)" = caffeinate ]';
const RAIL = 160;
// Space avatars: the GitHub organization's logo for the space's `origin`, cached under the
// app folder (where image() looks) and fetched again after a week. A personal account's
// photo isn't a project image, so repos owned by a user keep their letter.
const AVATAR_DIR = "cache/repo-avatars";
// Prints "org" when <owner>.png is an organization's logo, "user" for a personal account,
// "none" when it couldn't tell or fetch. Owner type and logo are each kept for 7 days.
const AVATAR_SCRIPT = `
cd "$1" || exit 1; o=$2
if [ -z "$(find "$o.type" -mtime -7 2>/dev/null)" ]; then
  t=$(curl -fsSL --max-time 15 "https://api.github.com/users/$o" | grep -o '"type": *"[A-Za-z]*"' | head -1 | tr -d '" ' | cut -d: -f2)
  [ -n "$t" ] && printf %s "$t" > "$o.type"
fi
t=$(cat "$o.type" 2>/dev/null)
[ -z "$t" ] && { echo none; exit 0; }
[ "$t" = Organization ] || { rm -f "$o.png"; echo user; exit 0; }
if [ -z "$(find "$o.png" -mtime -7 2>/dev/null)" ]; then
  curl -fsSL --max-time 15 -o "$o.png.part" "https://github.com/$o.png?size=96" && mv -f "$o.png.part" "$o.png" || rm -f "$o.png.part"
fi
[ -s "$o.png" ] && echo org || echo none
`;
const AVATAR_INSET = 2; // the logo sits this far inside its tile, so a full-bleed logo isn't clipped by the corners
const AVATAR_RETRY_MS = 10 * 60 * 1000; // a space with no avatar asks again after this

// The GitHub owner in a remote URL ("git@github.com:o/r.git", "https://github.com/o/r"), or null.
export function githubOwner(url) {
  const m = /github\.com[:/]([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/[^/\s]+\s*$/.exec(url ?? "");
  return m ? m[1] : null;
}

// Pull request badges on worktree rows. `color` is a theme color name or a hex color.
const PR = {
  failing: { color: "ansi1", label: "CI failing" },
  conflict: { color: "ansi1", label: "Merge conflict" },
  draft: { color: "dim", label: "Draft" },
  changes: { color: "ansi3", label: "Changes requested" },
  running: { color: "ansi3", label: "CI running" },
  approved: { color: "ansi2", label: "Approved" },
  review: { color: "ansi2", label: "Waiting on review" },
  merged: { color: "#ab7df8", label: "Merged" }, // GitHub's merged purple; the theme's ansi5 reads as red
  closed: { color: "dim", label: "Closed" },
};
const PR_FIELDS = "number,url,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup,baseRefName,mergedAt,headRefOid";
// Merged worktrees sit in a Completed folder; one with no terminals open for this long
// after its merge is removed. The sweep runs this often.
export const CLEANUP_AFTER_MS = 7 * 86400000;
const SWEEP_MS = 30 * 60000;
const TOUCH_MS = 60000; // how stale a worktree's last-open time may get before it is written again
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

// A space's worktrees as runs to draw together: a PR stack (an open PR whose base is another
// shown worktree's branch) is one run, base first and each PR under the one it targets;
// every other worktree is a run of one. A run sits where its first worktree was.
// Each worktree in a stack gets `stack: { n, of, onto }`: its place counting from the base
// (1), the stack's size, and the branch its PR targets.
export function stackRuns(groups, prOf) {
  const byBranch = new Map(groups.filter((g) => g.git && !g.main).map((g) => [g.branch, g]));
  const parent = new Map();
  const kids = new Map();
  for (const g of groups) {
    const pr = prOf(g);
    const p = pr?.state === "OPEN" ? byBranch.get(pr.baseRefName) : null;
    if (!p || p === g) continue;
    parent.set(g, p);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(g);
  }
  const rootOf = (g) => {
    const seen = new Set();
    while (parent.has(g) && !seen.has(g)) { seen.add(g); g = parent.get(g); }
    return g;
  };
  const placed = new Set();
  const runs = [];
  for (const g of groups) {
    if (placed.has(g)) continue;
    const run = [];
    const depth = new Map();
    const walk = (n, d) => {
      if (placed.has(n)) return;
      placed.add(n);
      run.push(n);
      depth.set(n, d);
      for (const k of kids.get(n) ?? []) walk(k, d + 1);
    };
    walk(rootOf(g), 1);
    if (run.length > 1) for (const n of run) n.stack = { n: depth.get(n), of: run.length, onto: run.includes(parent.get(n)) ? parent.get(n).branch : null };
    runs.push(run);
  }
  return runs;
}

// Merged worktrees ready to remove: linked checkouts git still lists, with no terminals
// open, whose merge and last open terminal are both older than CLEANUP_AFTER_MS.
export function staleMerged(open, touched, now = Date.now()) {
  return open.filter(({ g, pr }) => {
    if (!g.done || g.main || !g.git || g.panes.length || !pr?.headRefOid) return false;
    const last = Math.max(touched[g.path] ?? now, Date.parse(pr.mergedAt ?? "") || 0);
    return now - last > CLEANUP_AFTER_MS;
  });
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
    this.avatars = {}; // space id -> { folder, path, at }; path is relative to the app folder, or null
    this.owners = {}; // GitHub owner -> Promise of its cached avatar path, or null
    this.avatarBusy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("tree.folded") ?? "[]"));
    this.expanded = new Set(JSON.parse(localStorage.getItem("tree.expanded") ?? "[]")); // Completed folders are folded unless here
    this.touched = JSON.parse(localStorage.getItem("tree.touched") ?? "{}"); // worktree path -> last time it had a terminal open
    this.sweptAt = 0;
    this.sweeping = false;
    this.drag = null; // the row being dragged: { kind, id, group, index }
    this.over = null; // the row it would land on, "<kind>:<id>"
    this.caffeine = false; // a caffeinate from this mod is running
    this.caffeineAt = 0;
    this.caffeineBusy = false;
    cx.timer.every(1000, (cx) => this.refresh(cx));
    this.refresh(cx);
    // `deck-spaces.caffeinate` toggles caffeinate, for a key in keys.json.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "caffeinate" || c?.name === "caffeinate") this.toggleCaffeine(cx);
      }
    });
  }

  save() {
    localStorage.setItem("tree.folded", JSON.stringify([...this.folded]));
    localStorage.setItem("tree.expanded", JSON.stringify([...this.expanded]));
  }

  // Completed folders ("c:<space>") start folded; every other row starts open.
  isOpen(key) {
    return key.startsWith("c:") ? this.expanded.has(key) : !this.folded.has(key);
  }

  toggle(key, cx) {
    const set = key.startsWith("c:") ? this.expanded : this.folded;
    set.has(key) ? set.delete(key) : set.add(key);
    this.save();
    cx.notify();
  }

  // Records when each shown worktree last had a terminal open. One seen for the first
  // time counts as touched now, so it gets the full week before any removal.
  touch() {
    const now = Date.now();
    let changed = false;
    for (const { g } of this.open) {
      const at = this.touched[g.path];
      if (at === undefined || g.panes.length && now - at > TOUCH_MS) { this.touched[g.path] = now; changed = true; }
    }
    if (spaces().every((s) => this.wt[s.id]?.list)) {
      const shown = new Set(this.open.map(({ g }) => g.path));
      for (const k of Object.keys(this.touched)) if (!shown.has(k)) { delete this.touched[k]; changed = true; }
    }
    if (changed) localStorage.setItem("tree.touched", JSON.stringify(this.touched));
  }

  // Every SWEEP_MS, removes merged worktrees left untouched for CLEANUP_AFTER_MS. Only
  // when the checkout is still at (or behind) the merged PR's head, and without --force,
  // so git keeps any checkout with uncommitted changes or submodules.
  sweep(cx) {
    const now = Date.now();
    if (this.sweeping || now - this.sweptAt < SWEEP_MS) return;
    const due = staleMerged(this.open.map(({ s, g }) => ({ s, g, pr: this.prs[g.path]?.branch === g.branch ? this.prs[g.path].pr : null })), this.touched, now);
    this.sweptAt = now;
    if (!due.length) return;
    this.sweeping = true;
    cx.spawn(async (cx) => {
      for (const { s, g, pr } of due) {
        try {
          const listed = this.wt[s.id]?.list;
          const main = listed?.find((w) => w.main)?.path;
          if (!main || !listed.some((w) => w.path === g.path)) continue;
          const head = await exec("git", ["rev-parse", "HEAD"], { cwd: g.path, on: s.machine });
          if (head.code !== 0) continue;
          if (head.stdout.trim() !== pr.headRefOid) {
            const behind = await exec("git", ["merge-base", "--is-ancestor", "HEAD", pr.headRefOid], { cwd: g.path, on: s.machine });
            if (behind.code !== 0) continue; // commits after the merge, or the PR head isn't here
          }
          const r = await exec("git", ["worktree", "remove", g.path], { cwd: main, on: s.machine, timeout: 600000 });
          if (r.code !== 0) continue;
          this.wt[s.id].list = listed.filter((w) => w.path !== g.path);
          delete this.touched[g.path];
          localStorage.setItem("tree.touched", JSON.stringify(this.touched));
          const kept = shared("deck.kept") ?? {};
          const next = Object.fromEntries(Object.entries(kept).map(([id, list]) => [id, list.filter((k) => k.path !== g.path)]).filter(([, list]) => list.length));
          if (JSON.stringify(next) !== JSON.stringify(kept)) setShared("deck.kept", next);
          notify({ title: "Removed merged worktree", body: `${g.branch} (#${pr.number}) was merged and untouched for 7 days.`, level: "info" });
        } catch {}
      }
      this.sweeping = false;
      cx.notify();
    });
  }

  // Reads whether the caffeinate this mod started is still running (someone may kill it).
  refreshCaffeine(cx, force = false) {
    const now = Date.now();
    if (this.caffeineBusy || !force && now - this.caffeineAt < CAFFEINE_MS) return;
    this.caffeineAt = now;
    this.caffeineBusy = true;
    cx.spawn(async (cx) => {
      let on = false;
      try { on = (await exec("sh", ["-c", CAFFEINE_ALIVE, "sh", `${appHome()}/${CAFFEINE_PID}`])).code === 0; } catch {}
      this.caffeineBusy = false;
      if (on !== this.caffeine) { this.caffeine = on; cx.notify(); }
    });
  }

  // Starts or stops caffeinate: -i idle sleep, -m disk sleep, -s system sleep (on AC
  // power only). The display may still sleep. Lid-close sleep is not prevented.
  toggleCaffeine(cx) {
    if (this.caffeineBusy) return;
    const want = !this.caffeine;
    this.caffeine = want;
    this.caffeineBusy = true;
    cx.notify();
    const file = `${appHome()}/${CAFFEINE_PID}`;
    const script = want
      ? `${CAFFEINE_ALIVE} && exit 0; mkdir -p "$(dirname "$1")" || exit 1; nohup caffeinate -ims </dev/null >/dev/null 2>&1 & echo $! > "$1"`
      : `${CAFFEINE_ALIVE} && kill "$p"; rm -f "$1"`;
    cx.spawn(async (cx) => {
      try { await exec("sh", ["-c", script, "sh", file]); } catch {}
      this.caffeineBusy = false;
      this.refreshCaffeine(cx, true);
    });
  }

  caffeineButton(t) {
    const on = this.caffeine;
    return div().id("caffeinate").size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .tooltip(on ? "Caffeinated: the Mac won't sleep while plugged in. Click to allow sleep." : "Caffeinate: keep the Mac awake so agents keep running")
      .when(on, (el) => el.bg(t.selected).text_color(t.working))
      .when(!on, (el) => el.hover((st) => st.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => this.toggleCaffeine(cx))
      .child(svg("mods/deck-spaces/coffee.svg").size(14));
  }

  // Reads each space's worktrees when it is new, when a pane sits outside every
  // known worktree (one was just made), or every REFRESH_MS while the window is in front.
  refresh(cx) {
    this.refreshCaffeine(cx);
    this.refreshPrs(cx);
    this.sweep(cx);
    this.refreshAvatars(cx);
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

  // Looks up each space's avatar when it is new, when its folder changes, or, if it had
  // none, every AVATAR_RETRY_MS.
  refreshAvatars(cx) {
    if (this.avatarBusy) return;
    const now = Date.now();
    const due = spaces().filter((s) => {
      const known = this.avatars[s.id];
      return s.folder && (!known || known.folder !== s.folder || !known.path && now - known.at > AVATAR_RETRY_MS);
    });
    if (!due.length) return;
    this.avatarBusy = true;
    cx.spawn(async (cx) => {
      for (const s of due) {
        let path = null;
        try {
          const r = await exec("git", ["remote", "get-url", "origin"], { cwd: s.folder, on: s.machine });
          const owner = r.code === 0 ? githubOwner(r.stdout) : null;
          if (owner) path = await this.avatarFile(owner);
        } catch {}
        this.avatars[s.id] = { folder: s.folder, path, at: Date.now() };
      }
      this.avatarBusy = false;
      cx.notify();
    });
  }

  // The organization's logo as a path image() takes, or null for a personal account or
  // when it couldn't be fetched (asked again on the next lookup).
  async avatarFile(owner) {
    const name = owner.toLowerCase();
    this.owners[name] ??= (async () => {
      const dir = `${appHome()}/${AVATAR_DIR}`;
      await exec("mkdir", ["-p", dir]);
      const r = await exec("sh", ["-c", AVATAR_SCRIPT, "sh", dir, name], { timeout: 40000 }).catch(() => null);
      return r?.code === 0 ? r.stdout.trim() : "none";
    })();
    const p = this.owners[name];
    const kind = await p;
    if (kind === "none" && this.owners[name] === p) delete this.owners[name];
    return kind === "org" ? `${AVATAR_DIR}/${name}.png` : null;
  }

  // A space's mark: its organization's logo, else its initial on its color. A logo that
  // more than one space shows sits on the space's color, so those spaces stay apart.
  mark(s, fill, size, text) {
    const pic = this.avatars[s.id]?.path;
    if (pic) {
      const shared = (this.avatarUse?.get(pic) ?? 0) > 1;
      return h_flex().size(size).flex_none().rounded(5).items_center().justify_center().when(shared, (el) => el.bg(fill))
        .child(image(pic).size(size - 2 * AVATAR_INSET).flex_none());
    }
    return h_flex().size(size).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(text).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?");
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
      .text_color(t[look.color] ?? (look.color.startsWith("#") ? look.color : t.dim)).hover((st) => st.bg(t.hover)).tooltip(`${look.label}: ${info.tip}`)
      .on_click((_e, cx) => { cx.stop_propagation(); exec("open", [known.pr.url]).catch(() => {}); })
      .child(svg(`mods/deck-spaces/pr/${icon}.svg`).size(12));
  }

  // A space's worktrees that have terminals open or are kept, main checkout first,
  // then in the order they were first seen, each with its tabs, panes and agents.
  groups(s, ps, list, kept) {
    const listed = this.wt[s.id]?.list;
    const known = listed ?? [];
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
    for (const k of kept) {
      if (by.has(k.path)) continue;
      const wt = known.find((w) => w.path === k.path);
      if (listed && !wt) continue; // git dropped it; keep() forgets it
      by.set(k.path, { path: k.path, branch: wt ? wt.branch ?? "detached" : k.branch, main: wt ? wt.main : k.main, git: true, tabs: [], panes: [], agents: [], order: by.size });
    }
    const rank = (g) => { const i = kept.findIndex((k) => k.path === g.path); return i < 0 ? Infinity : i; };
    return [...by.values()].sort((a, b) => b.main - a.main || rank(a) - rank(b) || a.order - b.order);
  }

  // Remembers every git worktree with terminals open, so it stays when they close.
  // Forgets those git no longer lists and those of closed spaces.
  keep(trees, old) {
    const next = {};
    for (const { s, groups } of trees) {
      const listed = this.wt[s.id]?.list;
      const list = (old[s.id] ?? []).filter((k) => !listed || listed.some((w) => w.path === k.path));
      for (const g of groups) {
        const at = list.findIndex((k) => k.path === g.path);
        if (at >= 0) list[at] = { path: g.path, branch: g.branch, main: g.main };
        else if (g.git && g.panes.length) list.push({ path: g.path, branch: g.branch, main: g.main });
      }
      if (list.length) next[s.id] = list;
    }
    if (!trees.length) return;
    if (JSON.stringify(next) !== JSON.stringify(old)) setShared("deck.kept", next);
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

  chevron(key, t) {
    const open = this.isOpen(key);
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
    const empty = g.panes.length === 0;
    const count = 2 + (pr ? 1 : 0) + (ticket ? 1 : 0) + (mine.length ? 1 : 0) + (empty ? 1 : 0) + (g.git && !g.main ? 1 : 0);
    this.menu({ kind: "worktree", space: s.id, path: g.path, branch: g.branch, main: g.main, git: g.git, empty, pr, ticket }, 36 + count * 30);
  }

  // Drag to reorder: press a row and release it on another row of the same kind and
  // group. While dragged, the source dims and an accent line shows where it lands:
  // under the target when moving down, above it when moving up.
  draggable(el, item, t, drop) {
    const key = `${item.kind}:${item.id}`;
    const d = this.drag;
    const mine = d && d.kind === item.kind && d.id === item.id;
    const over = d && !mine && this.over === key;
    return el.relative()
      .when(Boolean(mine) && this.over !== key, (el) => el.opacity(0.5))
      .when(Boolean(over), (el) => el.child(div().absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
        .when(d.index < item.index, (line) => line.bottom(0)).when(d.index > item.index, (line) => line.top(0))))
      .on_mouse_down("left", () => { this.drag = item; this.over = key; })
      .on_mouse_move((_e, cx) => {
        const d = this.drag;
        if (!d) return;
        const next = d.kind === item.kind && d.group === item.group ? key : null;
        if (this.over !== next) { this.over = next; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const d = this.drag;
        const landed = d && this.over === key && d.id !== item.id;
        this.drag = null;
        this.over = null;
        if (landed) drop(d);
        cx.notify();
      });
  }

  // Moves a worktree in its space's kept list, before `to` when moving up, after it
  // when moving down. The tree sorts worktrees by that list.
  moveWorktree(space, from, to) {
    const kept = shared("deck.kept") ?? {};
    const list = [...(kept[space] ?? [])];
    const i = list.findIndex((k) => k.path === from);
    const j = list.findIndex((k) => k.path === to);
    if (i < 0 || j < 0 || i === j) return;
    const [item] = list.splice(i, 1);
    list.splice(j, 0, item);
    setShared("deck.kept", { ...kept, [space]: list });
  }

  spaceRow(s, groups, fill, t) {
    const key = `s:${s.id}`;
    const folded = this.folded.has(key);
    const all = groups.flatMap((g) => g.agents);
    const worst = top(all.map((a) => a.status));
    const index = spaces().findIndex((x) => x.id === s.id);
    const item = { kind: "s", id: s.id, group: s.machine ?? "", index };
    return this.draggable(h_flex(), item, t, (d) => run("space.move", { id: d.id, index: index + 1 })).id(`space-${s.id}`).h(30).flex_none().pl(4).pr(6).gap(6).items_center().rounded(7)
      .when(this.lit === key, (el) => el.bg(t.selected)).when(this.lit !== key, (el) => el.hover((st) => st.bg(t.hover)))
      .on_click(() => { this.picked = null; run("space.select", { id: s.id }); })
      .on_mouse_down("right", () => this.menu({ kind: "space", space: s.id }))
      .child(this.chevron(key, t))
      .child(this.mark(s, fill, 18, 10.5))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(s.name))
      .when(folded && all.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(all.length))))
      .when(folded && worst && worst !== "idle", (el) => el.child(this.status(t, worst)))
      .child(this.plus(`wt-new-${s.id}`, "New worktree", t, () => openOverlay({ mod: "deck-worktree", kind: "dialog", width: 460, height: 280, props: { space: s.id, action: "new" } })));
  }

  // A PR stack's worktrees, framed together by a faint rounded outline.
  stackBox(s, run, rows, t) {
    return v_flex().id(`stack-${s.id}-${run[0].path}`).flex_none().gap(1).my(2).py(2).rounded(9).border_1().border_color(t.border)
      .when(/^#[0-9a-f]{6}$/i.test(t.hover ?? ""), (el) => el.bg(`${t.hover}40`)) // 25%
      .children(rows);
  }

  // The one row that shows the selection: the focused agent when its row is visible, else
  // the shown tab's worktree, else the shown space (folded, or with no tab shown).
  // A sub-agent row wins when its terminal has focus, or when it was the last row clicked
  // and nothing else has been selected since (a peek doesn't move focus).
  litRow(trees) {
    const base = this.baseLit(trees);
    const shown = this.shownSubs(trees);
    const f = focused();
    const hit = [f?.terminal, f?.shown, f?.agent, ...this.ps.filter((p) => p.focused && p.terminal).map((p) => p.terminal)]
      .find((x) => x && shown.has(x) && !this.listedTop.has(x));
    if (hit) return `k:${hit}`;
    if (this.picked && (!shown.has(this.picked.addr) || this.picked.base !== base)) this.picked = null;
    return this.picked ? `k:${this.picked.addr}` : base;
  }

  // Addresses of the sub-agent rows the tree shows now.
  shownSubs(trees) {
    const out = new Set();
    for (const { s, groups } of trees) {
      if (this.folded.has(`s:${s.id}`)) continue;
      for (const g of groups) {
        if (g.done && !this.isOpen(`c:${s.id}`)) continue;
        if (this.folded.has(`w:${s.id}:${g.path}`)) continue;
        for (const a of g.agents) for (const { k } of this.kids(a.address)) out.add(k.address);
      }
    }
    return out;
  }

  baseLit(trees) {
    const at = trees.find(({ s }) => s.active);
    if (!at) return null;
    const { s, groups } = at;
    if (this.folded.has(`s:${s.id}`)) return `s:${s.id}`;
    const g = groups.find((g) => s.tabs.some((x) => x.active && g.tabs.includes(x.id)));
    if (!g) return `s:${s.id}`;
    if (g.done && !this.isOpen(`c:${s.id}`)) return `c:${s.id}`;
    const a = !this.folded.has(`w:${s.id}:${g.path}`) && g.agents.find((a) => a.focused);
    return a ? `a:${a.address}` : `w:${s.id}:${g.path}`;
  }

  // A stacked worktree's place in its stack, counting from the base PR.
  stackNumber(s, g, t) {
    const { n, of, onto } = g.stack;
    return h_flex().id(`stack-n-${s.id}-${g.path}`).h(15).min_w(15).px(3).flex_none().rounded(4).items_center().justify_center()
      .border_1().border_color(t.border).text_size(10).font_semibold().text_color(t.muted)
      .tooltip(onto ? `Stack ${n} of ${of}, on ${onto}` : `Stack ${n} of ${of}, the base`)
      .child(String(n));
  }

  // A space's merged worktrees, folded by default.
  completedRow(s, done, t) {
    const key = `c:${s.id}`;
    const open = this.isOpen(key);
    const worst = top(done.flatMap((g) => g.agents.map((a) => a.status)));
    return h_flex().id(`done-${s.id}`).h(26).flex_none().pl(18).pr(6).gap(6).items_center().rounded(7)
      .when(this.lit === key, (el) => el.bg(t.selected)).when(this.lit !== key, (el) => el.hover((st) => st.bg(t.hover)))
      .tooltip("Merged worktrees. Each is removed after 7 days with no terminals open.")
      .on_click((_e, cx) => this.toggle(key, cx))
      .child(this.chevron(key, t))
      .child(svg("mods/deck-spaces/pr/merged.svg").size(12).flex_none().text_color(PR.merged.color))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child("Completed"))
      .child(div().text_size(11).text_color(t.dim).child(String(done.length)))
      .when(!open && worst && worst !== "idle", (el) => el.child(this.status(t, worst)));
  }

  worktreeRow(s, g, color, t, indent = 0) {
    const key = `w:${s.id}:${g.path}`;
    const folded = this.folded.has(key);
    const worst = top(g.agents.map((a) => a.status));
    const badge = this.prBadge(s, g, t);
    const empty = g.tabs.length === 0;
    // Linked worktrees move within their section (open or Completed); the main checkout stays first.
    const index = (this.keptNow[s.id] ?? []).findIndex((k) => k.path === g.path);
    const row = g.git && !g.main && index >= 0
      ? this.draggable(h_flex(), { kind: "w", id: g.path, group: `${s.id}:${g.done ? "done" : "open"}`, index }, t, (d) => this.moveWorktree(s.id, d.id, g.path))
      : h_flex();
    return row.id(`wt-${s.id}-${g.path}`).h(26).flex_none().pl(18 + indent).pr(6).gap(6).items_center().rounded(7)
      .when(this.lit === key, (el) => el.bg(t.selected)).when(this.lit !== key, (el) => el.hover((st) => st.bg(t.hover)))
      .when(empty, (el) => el.tooltip("No terminals open. Click for a terminal here."))
      .on_click(() => {
        this.picked = null;
        run("space.select", { id: s.id });
        if (empty) run("tab.new", { space: s.id, folder: g.path, name: g.branch });
        else run("tab.select", { id: g.tabs[0] });
      })
      .on_mouse_down("right", () => this.worktreeMenu(s, g))
      .child(g.agents.length ? this.chevron(key, t) : div().w(16).flex_none())
      .child(div().size(8).flex_none().rounded(4).bg(color))
      .when(Boolean(g.stack), (el) => el.child(this.stackNumber(s, g, t)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(empty ? t.muted : t.foreground).child(g.branch))
      .when(folded && g.agents.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(g.agents.length))))
      .when(folded && worst && worst !== "idle", (el) => el.child(this.status(t, worst)))
      .when(Boolean(badge), (el) => el.child(badge))
      .child(this.plus(`ag-new-${s.id}-${g.path}`, "New Pi agent here", t, () => run("tab.new", { space: s.id, folder: g.path, name: g.branch, argv: ["pi"] })));
  }

  agentRows(g, color, t, indent = 0) {
    const cwdOf = new Map(this.ps.map((p) => [p.pane, p.cwd]));
    return g.agents.flatMap((a) => {
      const p = a.program;
      const pic = p?.icon ? (p.tint ? svg(p.icon).size(13).flex_none().text_color(t.muted) : image(p.icon).w(13).h(13).flex_none()) : div().w(13);
      const quiet = a.status === "idle" && !a.focused;
      const head = h_flex().id(`ag-${a.address}`).h(24).flex_none().pl(40 + indent).pr(8).gap(7).items_center().rounded(7).text_size(12.5).cursor_pointer()
        .when(this.lit === `a:${a.address}`, (el) => el.bg(t.selected)).when(this.lit !== `a:${a.address}`, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click(() => { this.picked = null; run("pane.focus", { pane: a.pane }); })
        .child(div().absolute().left(25 + indent).top(0).bottom(0).w(1).bg(color + "66"))
        .child(pic)
        .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(agentLabel(a, cwdOf.get(a.pane))))
        .child(this.status(t, a.status));
      const subs = this.kids(a.address).map(({ k, depth }) => h_flex().id(`sub-${k.address}`).h(22).flex_none().pl(40 + indent + 12 * depth).pr(8).gap(7).items_center().rounded(7).text_size(12).cursor_pointer()
        .when(this.lit === `k:${k.address}`, (el) => el.bg(t.selected)).when(this.lit !== `k:${k.address}`, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click((_e, cx) => {
          this.picked = { addr: k.address, base: this.base };
          if (this.listed.has(k.address)) run("pane.focus", { terminal: k.address });
          else run("terminal.peek", { terminal: k.address });
          cx.notify();
        })
        .child(div().absolute().left(25 + indent).top(0).bottom(0).w(1).bg(color + "66"))
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
        .child(this.mark(s, MARK[c] ?? t[c] ?? c, 20, 11))
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
    const kept = shared("deck.kept") ?? {};
    this.keptNow = kept;
    const prOf = (g) => (this.prs[g.path]?.branch === g.branch ? this.prs[g.path].pr : null);
    // Merged worktrees leave their stacks and go to the space's Completed folder, last.
    const trees = sp.map((s) => {
      const all = this.groups(s, this.ps, tops.filter((a) => a.space === s.id), kept[s.id] ?? []);
      for (const g of all) g.done = !g.main && prOf(g)?.state === "MERGED";
      const done = all.filter((g) => g.done);
      const runs = stackRuns(all.filter((g) => !g.done), prOf);
      return { s, runs, done, groups: [...runs.flat(), ...done] };
    });
    this.keep(trees, kept);
    this.listedTop = new Set(tops.map((a) => a.address));
    this.base = this.baseLit(trees);
    this.lit = this.litRow(trees);
    this.open = trees.flatMap(({ s, groups }) => groups.map((g) => ({ s, g })));
    this.touch();
    const colors = this.colors(trees);
    const spaceColors = this.spaceColors(sp);
    this.avatarUse = new Map();
    for (const s of sp) {
      const pic = this.avatars[s.id]?.path;
      if (pic) this.avatarUse.set(pic, (this.avatarUse.get(pic) ?? 0) + 1);
    }
    this.publish(trees, colors);
    setAgentOrder(trees.flatMap(({ groups }) => groups.flatMap((g) => g.agents.map((a) => a.address))));

    const narrow = (find(layout(), "sidebar")?.size?.px ?? Infinity) < RAIL;
    const needs = list.filter((a) => a.status === "blocked").length;
    const busy = list.filter((a) => a.status === "working").length;
    const newSpace = () => pickFolder({ prompt: "Open a repository as a space" }).then((folder) => folder && run("space.new", { folder }));
    const body = narrow
      ? this.rail(trees, spaceColors, t)
      : trees.flatMap(({ s, groups, runs, done }) => {
        const c = spaceColors[s.id] ?? "ansi6";
        const rows = [this.spaceRow(s, groups, MARK[c] ?? t[c] ?? c, t)];
        if (this.folded.has(`s:${s.id}`)) return rows;
        for (const run of runs) {
          const part = run.flatMap((g) => {
            const color = colors[g.path] ?? HUES[0];
            return [this.worktreeRow(s, g, color, t), ...(this.folded.has(`w:${s.id}:${g.path}`) ? [] : this.agentRows(g, color, t))];
          });
          rows.push(...(run.length > 1 ? [this.stackBox(s, run, part, t)] : part));
        }
        if (done.length) {
          rows.push(this.completedRow(s, done, t));
          if (this.isOpen(`c:${s.id}`)) for (const g of done) {
            const color = colors[g.path] ?? HUES[0];
            rows.push(this.worktreeRow(s, g, color, t, 12), ...(this.folded.has(`w:${s.id}:${g.path}`) ? [] : this.agentRows(g, color, t, 12)));
          }
        }
        return [...rows, div().h(6).flex_none()];
      });

    const endDrag = (_e, cx) => { if (!this.drag) return; this.drag = null; this.over = null; cx.notify(); };
    return v_flex().id("deck-spaces").size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_mouse_up("left", endDrag).on_mouse_down_out(endDrag)
      .child(h_flex().h(31).flex_none().pl(narrow ? 0 : 14).pr(narrow ? 0 : 8).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(narrow, (el) => el.justify_center())
        .when(!narrow, (el) => el.child(h_flex().gap(8).items_center()
          .child("Spaces")
          .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`${needs} need${needs === 1 ? "s" : ""} you`)))
          .when(busy > 0, (el) => el.child(div().text_color(t.working).child(`${busy} working`)))))
        .child(h_flex().gap(2).items_center()
          .when(!narrow, (el) => el.child(this.caffeineButton(t)))
          .child(div().id("space-new").size(24).flex_none().flex().items_center().justify_center().rounded(6).tooltip("Open a repo as a space")
            .hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click(newSpace)
            .child(svg("mods/workspace-chrome/folder-plus.svg").size(14)))))
      .child(v_flex().id("tree").flex_1().min_h(0).px(narrow ? 0 : 6).pb(14).gap(1).overflow_y_scrollbar().children(body));
  }
}
