// A lazy file browser for the focused pane's folder, with bounded read-only previews,
// and a search box that finds files by name anywhere under that folder.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, shared } from "herdr";

const INDEX_MAX = 100000; // files the search knows about
const INDEX_TTL = 10000; // a search reads the file list again when it is older than this
const RESULTS = 100;

// Paths matching `query` by name, best first: the query inside the file name (at its
// start best), then inside the path, then its letters in order anywhere in the path
// (letters starting a word, fewer gaps and more letters in the name rank higher). Spaces
// in the query are ignored.
export function matchFiles(paths, query, limit = RESULTS) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  const out = [];
  for (const path of paths) {
    const lp = path.toLowerCase();
    const slash = lp.lastIndexOf("/");
    const name = lp.slice(slash + 1);
    let score;
    const inName = name.indexOf(q);
    const inPath = inName < 0 ? lp.indexOf(q) : -1;
    if (inName >= 0) score = 2000 + (inName === 0 ? 500 : 0) - inName - (name.length - q.length);
    else if (inPath >= 0) score = 1000 - inPath;
    else {
      score = fuzzy(path, lp, q, slash);
      if (score === null) continue;
    }
    out.push({ path, score: score - path.length / 100 });
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const top = out.slice(0, limit).map((r) => r.path);
  top.pool = out.map((r) => r.path); // every match: a longer query only needs to search these
  return top;
}

// The query's letters in order in `lp`, scored from each of the first 16 places its
// first letter appears, keeping the best; null when they don't all appear.
const WORD = /[\/\-_. ]/;
function fuzzy(path, lp, q, slash) {
  let best = null;
  for (let start = lp.indexOf(q[0]), tries = 0; start >= 0 && tries < 16; start = lp.indexOf(q[0], start + 1), tries++) {
    let i = 0, gaps = 0, last = -1, named = 0, words = 0;
    for (let j = start; j < lp.length && i < q.length; j++) {
      if (lp[j] !== q[i]) continue;
      if (last >= 0) gaps += j - last - 1;
      if (j > slash) named++;
      if (j === 0 || WORD.test(lp[j - 1]) || path[j] !== lp[j] && path[j - 1] === lp[j - 1]) words++;
      last = j; i++;
    }
    if (i < q.length) break; // a later start can't match more
    const score = 500 - gaps + named * 10 + words * 15;
    if (best === null || score > best) best = score;
  }
  return best;
}

// Every file under `cwd`, relative to it: git's tracked and untracked-but-not-ignored
// files in a repo, else `find` (skipping .git and node_modules).
async function fileIndex(cwd, on) {
  const git = await exec("git", ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, on, timeout: 30000 }).catch(() => null);
  if (git?.code === 0) return [...new Set(git.stdout.split("\0").filter(Boolean))].slice(0, INDEX_MAX);
  const r = await exec("sh", ["-c", `find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print | head -n ${INDEX_MAX}`], { cwd, on, timeout: 30000 });
  return r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.handle = cx.focus_handle();
    this.query = ""; this.results = []; this.at = 0;
    this.index = null; this.indexKey = null; this.indexAt = 0; this.indexing = false;
    this.stamp = null; // the last shared "files.search" request acted on
    this.input = InputState.new({ placeholder: "Search files by name" });
    this.input.on("change", (_e, cx) => this.search(this.input.value(), cx));
    this.input.on("submit", (_e, cx) => this.openResult(cx));
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; this.ensureIndex(cx); cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  search(text, cx) {
    const narrower = this.results.pool && this.query.trim() && text.startsWith(this.query);
    this.query = text;
    this.at = 0;
    if (this.file) this.show(null);
    this.results = this.index ? matchFiles(narrower ? this.results.pool : this.index, text) : [];
    if (text.trim()) this.ensureIndex(cx);
    cx.notify();
  }

  // Reads this folder's file list when it has none, the folder changed, or it is stale.
  ensureIndex(cx) {
    const context = this.context;
    if (!context?.cwd || this.indexing) return;
    if (this.index && this.indexKey === context.key && Date.now() - this.indexAt < INDEX_TTL) return;
    this.indexing = true;
    cx.spawn(async (cx) => {
      try {
        const list = await fileIndex(context.cwd, context.on);
        if (!this.current(context)) return;
        this.index = list; this.indexKey = context.key; this.indexAt = Date.now();
        this.results = matchFiles(list, this.query);
        this.at = Math.min(this.at, Math.max(0, this.results.length - 1));
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { this.indexing = false; cx.notify(); }
    });
  }

  openResult(cx) {
    const path = this.results[this.at];
    if (path) this.show(path, cx);
    cx.notify();
  }

  key(e, cx) {
    if (!this.query.trim() || this.file) return;
    const n = this.results.length;
    if (e.key === "escape") { this.input.set_value(""); this.search("", cx); }
    else if ((e.key === "down" || e.key === "up") && n) { this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n; cx.notify(); }
    else return;
    cx.stop_propagation();
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      this.index = null; this.results = []; this.at = 0;
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/deck-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/deck-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // Search results: the file name, its folder in dim, its git mark. Click or Enter opens it.
  resultRows(t) {
    return this.results.map((path, i) => {
      const slash = path.lastIndexOf("/"), mark = this.marks[`${this.root}/${path}`];
      return h_flex().id(`hit-${path}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(i === this.at, el => el.bg(t.selected)).when(i !== this.at, el => el.hover(s => s.bg(t.hover)))
        .on_click((_e, cx) => { this.at = i; this.openResult(cx); })
        .child(svg("mods/deck-files/file.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().max_w_full().truncate().child(path.slice(slash + 1)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(slash >= 0 ? path.slice(0, slash) : ""))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
    });
  }

  searchBar(t) {
    return h_flex().h(40).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).h(28).pl(8).gap(6).items_center().rounded(6).border(1)
        .border_color(this.inputFocused ? t.accent : t.input ?? t.border).bg(t.background)
        .child(svg("mods/deck-files/search.svg").size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().min_w(0).h(26).items_center().text_color(t.foreground))
        .when(Boolean(this.query), el => el.child(div().id("files-search-clear").size(20).mr(3).flex_none().flex().items_center().justify_center()
          .rounded(4).cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.input.set_value(""); this.search("", cx); })
          .child(svg("mods/deck-files/x.svg").size(11)))));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    // Cmd+Shift+O (through deck-tabs) asks for the search box with a fresh shared stamp.
    const ask = shared("files.search");
    if (ask && ask !== this.stamp) {
      this.stamp = ask;
      if (Date.now() - ask < 5000) {
        if (this.file) this.show(null);
        cx.timer.after(50, () => this.input.focus());
      }
    }
    const t = theme();
    const searching = Boolean(this.query.trim());
    const status = this.indexing && !this.index ? "Indexing files…" : this.results.length ? `${this.results.length === RESULTS ? `Top ${RESULTS}` : this.results.length} match${this.results.length === 1 ? "" : "es"}` : this.indexing ? "Indexing files…" : "No matching files";
    return v_flex().id("files").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx)).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(this.searchBar(t)))
      .when(!this.file && searching, el => el.child(v_flex().id("files-hits").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .child(div().px(8).pb(4).text_size(11).text_color(t.dim).child(status))
        .children(this.resultRows(t))))
      .when(!this.file && !searching, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
