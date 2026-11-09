// A scripted fleet for demos and recordings: no real agents, no conversations, no tokens.
// It stands in for Herdr's spaces(), agents(), terminals() and focused(), and for the
// status-line readings, on a 72-second loop. Everything else in the mod runs as usual.

export const LOOP_S = 72;
const SPACE = "demo-kestrel";

// Each segment is [start second, status]. Before the first segment the agent is docked (idle).
// `ctx` is where its context starts, `rate` how fast working fills it (per second).
const CREW = [
  { id: "d-opus", tab: "Plan telemetry ingest", title: "Planning the ingest path for Kestrel IV telemetry", model: "Opus 5.5", app: "claude-code", program: "Claude Code",
    ctx: 0.04, rate: 0.014, segs: [[2, "working"], [52, "done"], [60, "idle"]] },
  { id: "d-gpt", tab: "Review parser PR", title: "Reviewing the telemetry parser refactor", model: "gpt-6.1-sol", app: "pi", program: "Pi",
    ctx: 0.28, rate: 0.011, segs: [[3, "working"], [38, "done"], [44, "idle"]] },
  { id: "d-sonnet-a", tab: "Write schema migration", title: "Adding an archive column to runs", model: "Sonnet 5.5", app: "claude-code", program: "Claude Code",
    ctx: 0.06, rate: 0.016, segs: [[4, "working"], [17.5, "blocked"], [30, "working"], [46, "done"], [53, "idle"]] },
  { id: "d-haiku", tab: "Fix lint warnings", title: "Fixing lint warnings in the web app", model: "Haiku 5.5", app: "claude-code", program: "Claude Code",
    ctx: 0.02, rate: 0.03, segs: [[6, "working"], [16, "done"], [22, "idle"], [34, "working"], [42, "done"], [48, "idle"]] },
  { id: "d-sonnet-b", tab: "Backfill test data", title: "Backfilling the thermal vacuum test runs", model: "Sonnet 5.5", app: "claude-code", program: "Claude Code",
    ctx: 0.07, rate: 0.015, segs: [[8, "working"], [50, "done"], [57, "idle"]] },
  { id: "d-fable", tab: "Architecture review", title: "Reviewing the storage compaction design", model: "Fable 5.1", app: "claude-code", program: "Claude Code",
    ctx: 0.03, rate: 0.012, segs: [[10, "working"], [62, "done"], [67, "idle"]] },
  { id: "d-codex", tab: "Port flight rules", title: "Porting the flight rule evaluator", model: "codex-max", app: "codex", program: "Codex",
    ctx: 0.1, rate: 0.013, segs: [[12, "working"], [40, "blocked"], [48, "working"], [58, "done"], [64, "idle"]] },
  { id: "d-gpt-mini", tab: "Summarize anomalies", title: "Summarizing last night's anomalies", model: "gpt-6.1-mini", app: "pi", program: "Pi",
    ctx: 0.05, rate: 0.025, segs: [[18, "working"], [30, "done"], [36, "idle"], [44, "working"], [56, "done"], [62, "idle"]] },
  // Sub-agents exist only between `from` and `to`.
  { id: "d-sub-read", parent: "d-opus", tab: "Explore read path", title: "Explore read path", model: "Sonnet 5.5", app: "claude-code", program: "Claude Code",
    ctx: 0.05, rate: 0.02, from: 10, to: 19, segs: [[10, "working"], [15, "done"]] },
  { id: "d-sub-write", parent: "d-opus", tab: "Explore write path", title: "Explore write path", model: "Sonnet 5.5", app: "claude-code", program: "Claude Code",
    ctx: 0.05, rate: 0.02, from: 16, to: 40, segs: [[16, "working"], [36, "done"]] },
  { id: "d-sub-survey", parent: "d-fable", tab: "Survey services", title: "Survey services", model: "Haiku 5.5", app: "claude-code", program: "Claude Code",
    ctx: 0.05, rate: 0.03, from: 20, to: 50, segs: [[20, "working"], [46, "done"]] },
];

const URGENCY = { blocked: 4, done: 3, working: 2, idle: 1 };

// `now` is the mod's clock (it can run slow for recordings); `startAt` skips into the script, in seconds.
export function createDemo(now = Date.now, startAt = 0) {
  const startedAt = now() - startAt * 1000;
  const sec = () => ((now() - startedAt) / 1000) % LOOP_S;
  const loopStart = () => now() - sec() * 1000;

  const statusAt = (c, s) => {
    let status = "idle";
    for (const [at, st] of c.segs) if (s >= at) status = st;
    return status;
  };
  // Seconds spent working up to s, which is what fills the context.
  const workedBy = (c, s) => {
    let total = 0;
    c.segs.forEach(([at, st], i) => {
      if (st !== "working" || s <= at) return;
      const end = c.segs[i + 1]?.[0] ?? Infinity;
      total += Math.min(s, end) - at;
    });
    return total;
  };
  const workingSince = (c, s) => {
    if (statusAt(c, s) !== "working") return null;
    const seg = [...c.segs].reverse().find(([at]) => s >= at);
    return loopStart() + seg[0] * 1000;
  };
  const live = (s) => CREW.filter((c) => (c.from == null || s >= c.from) && (c.to == null || s < c.to));

  const agentsNow = () => {
    const s = sec();
    return live(s).map((c) => ({
      address: c.id, pane: `pane-${c.id}`, space: SPACE, space_name: "Kestrel IV",
      tab: `tab-${c.parent ?? c.id}`, tab_index: 1, tab_name: c.tab,
      status: statusAt(c, s), app: c.app, program: { key: c.app, name: c.program, agent: true },
      title: c.title, seq: 0, pinned: false, focused: false,
    }));
  };

  return {
    demo: true,
    agents: agentsNow,
    terminals: () => live(sec()).map((c) => ({ address: c.id, parent: c.parent ?? null })),
    focused: () => ({ space: SPACE, tab: "tab-d-opus", pane: null, terminal: null, shown: null, agent: null, cwd: null }),
    spaces: () => {
      const s = sec();
      const tops = live(s).filter((c) => !c.parent);
      const status = tops.map((c) => statusAt(c, s)).sort((a, b) => URGENCY[b] - URGENCY[a])[0] ?? null;
      return [
        { id: SPACE, index: 1, name: "Kestrel IV", named: true, folder: "", machine: null, branch: "flight-sw/v2.4", active: true, status,
          tabs: tops.map((c, i) => ({ id: `tab-${c.id}`, index: i + 1, name: c.tab, named: true, active: i === 0, status: statusAt(c, s),
            panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: workingSince(c, s) })) },
        { id: "demo-ground", index: 2, name: "Ground Station", named: true, folder: "", machine: null, branch: "main", active: false, status: "working", tabs: [] },
        { id: "demo-range", index: 3, name: "Range Ops", named: true, folder: "", machine: null, branch: "main", active: false, status: "idle", tabs: [] },
      ];
    },
    // What the status lines would say: the model, and context filled by time spent working.
    telemetry: () => {
      const s = sec();
      return new Map(live(s).map((c) => [c.id, { model: c.model, ctx: Math.min(0.96, c.ctx + c.rate * workedBy(c, s)) }]));
    },
  };
}
