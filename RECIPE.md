# Flight Deck layout

Herdr's main layout reorganised around repos, worktrees and agents, with Flight Deck docked beside your work. The sidebar is one tree: each space is a repo, under it each worktree you've opened (it stays after its terminals close), under each worktree its agents. On the right, Flight Deck shows every space as a planet, with each agent as a craft orbiting in its worktree's color: it launches when it starts work, orbits while it works, holds when it needs you, and lands when it's done.

![Flight Deck layout](preview.png)

## What you see

Left to right:

- **Sidebar**, 268px on `chrome`: Herdr's brand bar (46px, `workspace-chrome`), the tree (`deck-spaces`), and the footer (69px, `workspace-chrome`).
  - **Header**, 31px: `Spaces` in `dim` 11.5, then `N need(s) you` in `blocked` and `N working` in `working` when there are any, and a folder-plus button that opens a repo as a new space.
  - **Space rows**, 30px, radius 7: a fold chevron, an 18px rounded avatar in the space's color with its first letter in white, the name in semibold, and a `+` that opens New worktree. Folded, it shows its agent count and most urgent status. The shown space is `selected`.
  - **Worktree rows**, 26px, indented 18px: a chevron (when it has agents), an 8px dot in the worktree's color, the branch name, a pull request badge (below), and a `+` that starts Pi in that worktree as a new tab. The row whose tab is shown is `hover`. A worktree with no terminals open shows its branch in `muted`.
  - **PR badges**, 18px with a 12px Lucide icon (`mods/deck-spaces/pr/*.svg`), on worktree rows whose branch has a pull request. One state shows, in this order: draft (`git-pull-request-draft`, `dim`; CI is ignored until the PR is open for review), CI failing (`circle-x`, `ansi1`), merge conflict (`triangle-alert`, `ansi1`), changes requested (`circle-alert`, `ansi3`), CI running (`clock`, `ansi3`), approved (`circle-check`, `ansi2`), waiting on review (`git-pull-request`, `ansi2`). Merged (`git-merge`, `ansi5`) and closed (`git-pull-request-closed`, `dim`) PRs show too. No PR, no badge.
  - **Agent rows**, 24px, indented 40px, with a 1px guide line in the worktree's color at 40%: the program icon, the agent's name (Pi's session name from its title, else its own title, else the program; idle and unfocused in `muted`), and its status: a spinning ring (working), a `!` tile (blocked), a filled dot (done) or a hollow dot (idle). Sub-agents follow, indented 12px per level with `└`.
  - Narrower than 160px, the tree becomes a rail of space avatars with a status dot.
- **Work column**:
  - **Tab bar**, 42px (`deck-tabs`): tabs as pills, each with its worktree's color dot, program icon and the agent's session name (else the tab's name); tooltip shows the branch. `+` opens `deck-new-menu`; `Flight Deck`, `Files` and `Changes` toggle their panels.
  - **Work body**, a row with 8px padding and 8px gaps:
    - **The shown tab** (`tab: "active"`), its panes as cards with a 30px `pane` header, radius 10, 1px `border`, `accent` focus ring. At least 360px.
    - **Flight Deck**, at least 320px, radius 10, 1px `border`: Fleet mode shows every space as a planet on a grid that fits the block (stacked when tall and narrow); System mode shows one. See `mods/flightdeck` and the mod's recipe for every detail.
    - **Files and Changes**, Herdr's panel, hidden until opened from the tab bar, 368px.
  - **Status bar**, 28px, Herdr's `workspace-status` mod.

The window keeps the person's own theme and fonts; Flight Deck draws on its own dark colours with a cyan accent (`#2ee6ff`).

## How it behaves

- **A space is a repo; a worktree is tabs in it.** The tree reads each space's `git worktree list` (when new, when a pane sits outside every known worktree, and every 20 seconds while the window is in front) and groups terminals by the worktree their live folder is in, the deepest match winning. A split or a `cd` moves a terminal to the right branch.
- **Worktrees stay.** Every git worktree seen with terminals open is kept in `shared("deck.kept")` (`{ <space id>: [{ path, branch, main }] }`, in the order first seen) and stays in the tree after its terminals close. It goes when git stops listing it, when Remove worktree deletes it, when its space closes, or when Hide from sidebar is chosen. Worktrees sort main checkout first, then in the order they were first seen.
- **Worktree colors** stick: each open worktree gets the least used of `#8cabff`, `#58d6b5`, `#f257a5`, `#b061ff`, `#d9c27a`, `#c0c4ff`, `#e08cff`, `#7fa7c9` (kept clear of status green, orange and amber and of the deck's cyan), saved in `shared("worktree.colors")`. Colors of worktrees git no longer lists are dropped.
- **PR status**: the tree runs `gh pr view <branch> --json number,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup` in each shown worktree (skipping `main`, `master` and detached checkouts) when its branch changes, and every 60 seconds while the window is in front. A check with conclusion or state FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE or ERROR counts as failing. A check still pending after 90 minutes is ignored, since some (Codecov project checks) never finish. Once per PR it also reads the PR's body and comments (`gh pr view <n> --json body,comments`) for `linear.app/<workspace>/issue/<ID>` links, since the Linear bot posts the link as a comment. The ticket is the link whose ID the branch (`eng-123-...`, `cursor/eng-123-...`) or the PR title (`ENG-123: ...`) names, else the only link, else the first in the body. Each team prefix's workspace is remembered (`localStorage` `linear.teams`), so a branch with no PR yet still gets a Linear link when its prefix is known. ID 0 (`eng-0000-...`) is never a ticket. The badge's tooltip reads like `CI failing: #123 · 2 checks failing · waiting on review`; clicking it opens the PR with `open`.
- **Clicks**: a space row shows that space; a worktree row shows its first tab, or opens a terminal tab in it when it has none; an agent row focuses its pane; a sub-agent focuses or peeks it. Chevrons fold (saved per copy). `agent.next` / `agent.prev` follow the tree's order.
- **Right-click** a space: New worktree, Open worktree, Rename space, Close space. Right-click a worktree: Open PR #N (GitHub mark) and Open <ID> in Linear (Linear logo in `#5e6ad2`), each only when known and opened in the browser with `open`; Open Pi agent (Pi's icon, `icons/pi.svg`), which starts Pi as a tab in the worktree named after its branch; New terminal, for any other agent; Close its tabs (when some tabs are wholly in it), Hide from sidebar (when it has no terminals), Remove worktree (linked worktrees only).
- **New worktree** (`deck-worktree`) checks out the branch (new from the current HEAD, or existing) in `~/.herdr/worktrees/<repo>/<branch>` and opens it as a tab named after the branch in the repo's space, running Pi. **Open worktree** lists the repo's checkouts, shows `open` for those with a tab, and selects that tab or opens a new one. **Remove worktree** closes the tabs wholly in it and the panes in it of mixed tabs (opening a tab at the main checkout first if nothing would be left), then runs `git worktree remove` and drops it from `deck.kept`; the space stays.
- Flight Deck: clicking a planet shows that space, double-clicking opens it in System mode, clicking a craft or manifest row focuses that agent on the left. Drag to turn, scroll to zoom.
- Pi sessions show their names everywhere once named (`/name`, or an extension that names them after the first prompt): Pi sets its title to `π - <name> - <folder>`, and the tree, tab bar and Flight Deck read it.

## Built from

- `layouts/flightdeck.json`: Herdr's main layout (as shipped in Herdr 0.1.14) with the `spaces` and `agents` blocks replaced by one `spaces` block showing `deck-spaces` (weight 1, min 90), the `tabs` block showing `deck-tabs`, and one block added in `work-body` after `main`: `{ "id": "flightdeck", "type": "block", "size": { "weight": 1 }, "min": 320, "radius": 10, "border": { "width": 1, "color": "border" }, "content": { "mod": "flightdeck" } }`; `main` has `"size": { "weight": 1 }, "min": 360`. Root `"preview": "layouts/flightdeck.svg"`.
- `layouts/flightdeck.svg`: the settings screen's picture of the layout.
- `mods/deck-spaces/`: the tree. Herdr functions `spaces`, `panes`, `agents`, `terminals`, `setAgentOrder`, `run`, `openOverlay`, `exec`, `theme`, `shared`, `setShared`, `layout`, `window`, `pickFolder`. Runs `git worktree list --porcelain` in each space and `gh pr view` in each shown branch worktree (`gh` from PATH, else `/opt/homebrew/bin/gh` or `/usr/local/bin/gh`, since the app may not have Homebrew on its PATH). Publishes `shared("deck.tree")` (each pane's worktree, each worktree's branch, color, space and PR `{ number, url, state }`) for the tab bar and Flight Deck, and keeps `space.colors`, `worktree.colors` and `deck.kept`.
- `mods/deck-tabs/`: a clone of Herdr's `tabs` (0.1.14) with worktree dots, session names and the Flight Deck toggle.
- `mods/deck-menu/`: the tree's right-click menu, `{ kind: "space" | "worktree", space, path, branch, main, git, empty, pr?: { number, url }, ticket?: { id, url } }`. Hide from sidebar removes the worktree from `shared("deck.kept")`. An item's icon is a `workspace-chrome` icon name or an svg path. `github.svg` is GitHub's Octicons mark, `linear.svg` is Linear's logo. `deck-spaces` sizes the worktree menu to its items: 36px plus 30px each.
- `mods/deck-worktree/`: a clone of Herdr's `worktree` (0.1.15) that makes, opens and removes worktrees as tabs in the repo's space. Runs `git`.
- `mods/deck-new-menu/`: a clone of Herdr's `new-menu` (0.1.15) whose worktree items open `deck-worktree`.
- `mods/flightdeck/`: the Flight Deck mod. Its own recipe is at github.com/lineville/herdr-flightdeck.
- Shipped Herdr mods it uses: `workspace-chrome` (and its icons), `pane`, `files`, `changes`, `workspace-status`.

## Watch out

- The layout copies Herdr's main layout at one release. If Herdr's main changes, rebuild from the new one: clone it (`layout.clone {name: "main", as: "flightdeck"}`), swap in `deck-spaces` and `deck-tabs`, and add the `flightdeck` block beside `main` again.
- A new mod docks itself into the layout that shows when Herdr first sees it. If `mods/flightdeck` was installed before this layout, check `work-body` for a second Flight Deck block and remove it.
- Herdr's own menus (`new-menu`, `menu`, used by other layouts) still make worktrees as separate spaces. In this layout those show as their own space rows.
- `setShared` re-renders every mod: `deck-spaces` writes only when the JSON changed.
- PR badges need `gh` installed and signed in to an account that can read the repo. `mergeable` is computed lazily by GitHub, so a conflict can take one refresh to show.
- Pane folders come from the shell's reports; a program that never reports its folder groups under where it started.
- Flight Deck reads each agent's status line with `hc read` every 5 seconds for its model and context; see the mod's recipe.

## Done when

- `herdr-app check` passes for `flightdeck`, `deck-spaces`, `deck-tabs`, `deck-menu`, `deck-worktree` and `deck-new-menu`, and `layouts/flightdeck.error` doesn't exist.
- `layout.switch {name: "flightdeck"}` shows the tree, the tab bar with worktree dots, the shown tab on the left and Flight Deck on the right.
- A space on a repo shows a `main` worktree row with its agents under it; New worktree from the space's `+` adds a colored worktree row with Pi running under it, as a tab in the same space.
- Closing every tab of a worktree leaves its row in the tree, branch in `muted`; clicking it opens a terminal there, and Hide from sidebar removes it.
- The worktree's dot, its tabs' dots and its agents' orbits in Flight Deck share one color.
- With two spaces open, Flight Deck shows two planets, and clicking one switches space.
- Remove worktree closes its tabs, keeps the space, and deletes the checkout.
- `ctrl-shift-l` cycles back to the person's own layout, unchanged.
