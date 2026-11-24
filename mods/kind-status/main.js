// Local kind stack status for the Flight Deck status bar: one chip with a
// status dot (a spinner while a deploy runs), the worktree whose build is
// deployed, free agent pods and AWS creds. Hover for the details card: what
// each worktree built, a running deploy, cluster health, the agent pool and
// AWS, with Refresh, Heal and AWS login buttons. Click the chip to refresh.
// status.py does the probing (kubectl, the kind registry's build provenance,
// git worktrees, ps, postgres leases, sts, app.sift.test) and the healing.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { exec, props, theme, appHome, checking, window, run, notify } from "herdr";

const IDLE_MS = 30 * 1000;
const BUSY_MS = 5 * 1000;
const SPINNER = "mods/kind-status/spinner.svg";

const now = () => Date.now() / 1000;
const ago = (t) => {
  if (!t) return "";
  const s = Math.max(0, now() - t);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const dur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const short = (sha) => (sha ? sha.slice(0, 8) : "");
const SCRIPT = {
  "setup_local_k8s.sh": "Setting up cluster",
  "local_build_and_deploy.sh": "Building",
  "local_apply.sh": "Applying",
  "local_restart.sh": "Restarting",
  "local_use_upstream.sh": "Reverting to upstream",
};

const DEMO = {
  at: 0, baseline: "bab80290d88991b80b06ff903423df0c7278f7a2", app: 200, min_free: 2,
  deploys: [], jobs_failed: [], rolling: [], short: [],
  pods: { total: 54, bad: [] },
  agents: { want: 10, ready: 10, leased: 3, free: 7 },
  aws: { profile: "sift-Development", local: "ok", cluster: "synced", age: 5400, login: ["aws-login", "-profile", "sift-Development", "-n"] },
  heal: [],
  services: [
    { image: "backend", kind: "local", revision: "22f02f1157fc9020ce6a95ce844a0154ecc8619e", built: 0,
      from: { worktree: "feature-branch", branch: "eng-1234-feature-branch", behind: 0 } },
    { image: "frontend", kind: "local", revision: "22f02f1157fc9020ce6a95ce844a0154ecc8619e", built: 0,
      from: { worktree: "feature-branch", branch: "eng-1234-feature-branch", behind: 0 } },
    ...["worker", "pyworker", "webhooks", "ingest"].map((image) => ({ image, kind: "upstream" })),
  ],
};

export default class KindStatus extends View {
  init(_props, cx) {
    this.demo = Boolean(props()?.demo);
    this.repo = props()?.repo ?? null;
    this.minFree = props()?.minFree ?? 2;
    this.data = this.demo ? { ...DEMO, at: now(), services: DEMO.services.map((s) => ({ ...s, built: s.built === 0 ? now() - 1800 : s.built })) } : null;
    this.busy = false;
    this.healing = false;
    this.healed = null;
    this.fastUntil = 0;
    this.last = 0;
    if (this.demo || checking()) return;
    this.refresh(cx);
    // Tick often; fetch on the slow cadence, or the fast one while a deploy or rollout runs.
    cx.timer.every(BUSY_MS, (cx) => {
      if (window()?.visible === false) return;
      const wait = this.deploying() || this.healing || Date.now() < this.fastUntil ? BUSY_MS : IDLE_MS;
      if (Date.now() - this.last >= wait - 500) this.refresh(cx);
    });
  }

  refresh(cx) {
    if (this.busy || this.demo) return;
    this.busy = true;
    this.last = Date.now();
    cx.spawn(async (cx) => {
      const args = [`${appHome()}/mods/kind-status/status.py`, "--min-free", String(this.minFree)];
      if (this.repo) args.push("--repo", this.repo);
      try {
        const r = await exec("python3", args, { timeout: 40000 });
        this.data = JSON.parse(r.stdout.trim());
      } catch (e) {
        this.data = { error: `status.py failed: ${String(e?.message ?? e).slice(0, 120)}` };
      }
      this.busy = false;
      this.last = Date.now();
      // The last heal's results show for 3 minutes.
      if (this.healed && Date.now() - this.healedAt > 3 * 60 * 1000) this.healed = null;
      cx.notify();
    });
  }

  // Runs the heal plan status.py suggests, then refetches and reports what ran.
  heal(cx) {
    if (this.healing || this.demo) return;
    this.healing = true;
    this.healed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const args = [`${appHome()}/mods/kind-status/status.py`, "--heal"];
      if (this.repo) args.push("--repo", this.repo);
      try {
        const r = await exec("python3", args, { timeout: 600000 });
        this.healed = JSON.parse(r.stdout.trim()).healed;
      } catch (e) {
        this.healed = [{ step: "Heal", ok: false, detail: String(e?.message ?? e).slice(0, 160) }];
      }
      this.healing = false;
      this.healedAt = Date.now();
      const failed = this.healed.filter((s) => !s.ok);
      notify({
        title: failed.length ? "Kind heal: some steps failed" : "Kind heal done",
        body: this.healed.map((s) => `${s.ok ? "✓" : "✗"} ${s.step}`).join("\n"),
        level: failed.length ? "warning" : "info",
      });
      this.fastUntil = Date.now() + 2 * 60 * 1000;
      cx.notify();
      this.refresh(cx);
    });
  }

  // Opens a tab running aws-login (then update_local_secrets.sh, so the cluster gets the new creds).
  awsLogin() {
    const a = this.data?.aws;
    const login = props()?.awsLogin ?? `${(a?.login ?? ["aws-login", "-n"]).map(quote).join(" ")} && ./scripts/update_local_secrets.sh`;
    run("tab.new", { name: "aws-login", folder: this.data?.repo ?? undefined, argv: ["/bin/zsh", "-c", login] });
    this.fastUntil = Date.now() + 5 * 60 * 1000;
  }

  deploying() {
    const d = this.data;
    return Boolean(d && !d.error && (d.deploys?.length || d.rolling?.length));
  }

  // Worktree groups of local builds, newest build first; upstream images last.
  groups() {
    const map = new Map();
    for (const s of this.data?.services ?? []) {
      if (s.kind !== "local" && s.kind !== "stale") continue;
      const key = s.from?.worktree ?? s.from?.branch ?? short(s.revision) ?? "unknown";
      const g = map.get(key) ?? { key, from: s.from, revision: s.revision, built: 0, images: [], stale: [] };
      (s.kind === "stale" ? g.stale : g.images).push(s.image);
      g.built = Math.max(g.built, s.built ?? 0);
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => b.built - a.built);
  }

  // One overall state: down, deploying, degraded or healthy, with its reasons.
  state() {
    const d = this.data;
    if (!d) return { level: "loading", label: "Checking", reasons: [] };
    if (d.error) return { level: "down", label: d.error === "down" ? "Cluster down" : "Unreachable", reasons: [d.error === "down" ? "kubectl can't reach kind-kind" : d.error] };
    const reasons = [];
    if (d.app !== 200) reasons.push(d.app ? `app.sift.test returned ${d.app}` : "app.sift.test not answering");
    if (d.pods?.bad?.length) reasons.push(`${d.pods.bad.length} pod${d.pods.bad.length === 1 ? "" : "s"} not ready`);
    const a = d.agents ?? {};
    if (a.want != null && a.ready < a.want) reasons.push(`${a.ready}/${a.want} agent pods ready`);
    if (a.free != null && a.free < (d.min_free ?? 2)) reasons.push(`${a.free} free agent pod${a.free === 1 ? "" : "s"}`);
    if (d.postgres === false) reasons.push("postgres has no leader");
    const aws = this.awsState();
    if (aws.level !== "ok") reasons.push(aws.reason);
    if (this.deploying()) return { level: "deploying", label: "Deploying", reasons };
    return reasons.length ? { level: "degraded", label: "Degraded", reasons } : { level: "healthy", label: "Healthy", reasons };
  }

  // ok, stale (cluster copy older) or bad (local creds expired, invalid or missing).
  awsState() {
    const a = this.data?.aws;
    if (!a) return { level: "ok", label: "", reason: "" };
    if (a.local === "ok") return a.cluster === "stale"
      ? { level: "stale", label: "Valid, cluster has older creds", reason: "cluster AWS creds are older than ~/.aws" }
      : { level: "ok", label: a.cluster === "synced" ? "Valid, cluster in sync" : "Valid", reason: "" };
    if (a.local === "unknown") return { level: "stale", label: "Couldn't check (offline?)", reason: "AWS creds unchecked" };
    const label = { expired: "Expired", invalid: "Invalid", missing: "Missing" }[a.local] ?? a.local;
    return { level: "bad", label, reason: `AWS creds ${label.toLowerCase()}` };
  }

  color(level, t) {
    return { healthy: t.done, deploying: t.working, degraded: t.blocked, down: t.ansi1, loading: t.dim }[level] ?? t.dim;
  }

  // ------------------------------------------------------------------ bar

  bar(st, t) {
    const d = this.data;
    const groups = this.groups();
    const g = groups[0];
    const dep = d?.deploys?.[0];
    const name = dep
      ? `${(SCRIPT[dep.script] ?? dep.script).replace("Setting up cluster", "Setup")}${dep.targets?.length ? ` ${dep.targets.join(", ")}` : ""}`
      : st.level === "down" ? st.label
      : g ? g.key
      : d?.baseline ? `upstream ${short(d.baseline)}` : "…";
    const icon = st.level === "deploying"
      ? svg(SPINNER).size(11).flex_none().text_color(t.working).spin(900)
      : div().size(7).flex_none().rounded(4).bg(this.color(st.level, t));
    const a = d?.agents;
    const low = a && ((a.free != null && a.free < (d.min_free ?? 2)) || (a.want != null && a.ready < a.want));
    const more = !dep && st.level !== "down" && groups.length > 1 ? `+${groups.length - 1}` : null;
    const aws = this.awsState();
    return h_flex().id("kind-bar").w(296).h(22).px(6).gap(6).items_center().rounded(4).overflow_hidden().cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.refresh(cx))
      .child(icon)
      .child(div().text_size(10).text_color(t.dim).flex_none().child("kind"))
      .child(div().flex_1().min_w(0).truncate().text_color(st.level === "down" ? t.dim : t.muted).child(name))
      .when(Boolean(more), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(more)))
      .when(Boolean(a && a.want != null && st.level !== "down"), (el) => el.child(
        div().flex_none().text_color(low ? t.blocked : t.dim)
          .child(a.free != null ? `${a.free}/${a.ready} free` : `${a.ready}/${a.want}`)))
      .when(Boolean(d?.aws), (el) => el.child(div().flex_none().text_size(10.5)
        .text_color(aws.level === "bad" ? t.ansi1 : aws.level === "stale" ? t.blocked : t.dim).child("aws")));
  }

  button(id, label, t, onClick, { primary = false, busy = false } = {}) {
    return h_flex().id(id).h(24).px(10).gap(6).items_center().rounded(6).cursor_pointer().text_size(11.5)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .border(1).border_color(primary ? t.solid : t.border)
      .hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => onClick(cx))
      .when(busy, (el) => el.child(svg(SPINNER).size(10).spin(900)))
      .child(label);
  }

  // ------------------------------------------------------------------ card

  section(title, t, rows) {
    return v_flex().gap(3).child(div().text_size(10.5).text_color(t.dim).child(title)).children(rows);
  }

  row(t, left, right, color) {
    return h_flex().gap(8).items_start().justify_between().text_size(12)
      .child(div().min_w(0).flex_1().truncate().text_color(color ?? t.foreground).child(left))
      .when(right != null, (el) => el.child(div().flex_none().text_color(t.muted).child(right)));
  }

  note(t, text, color) {
    return div().text_size(11.5).text_color(color ?? t.muted).child(text);
  }

  card(st, t) {
    const d = this.data ?? {};
    const rows = [];
    rows.push(h_flex().gap(8).items_center().justify_between()
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Local kind stack"))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(this.color(st.level, t))
        .child(st.level === "deploying" ? svg(SPINNER).size(10).spin(900) : div().size(7).rounded(4).bg(this.color(st.level, t)))
        .child(st.label)));
    if (st.reasons.length && st.level !== "healthy") rows.push(v_flex().gap(1).children(st.reasons.map((r) => this.note(t, r, st.level === "down" ? t.ansi1 : t.blocked))));

    if (d.error) {
      rows.push(this.note(t, "Start Docker and the kind containers, or run scripts/setup_local_k8s.sh from the azimuth repo."));
      if (d.aws) rows.push(this.awsSection(d, t));
      rows.push(h_flex().gap(6)
        .child(this.button("kc-refresh", "Refresh", t, (cx) => this.refresh(cx), { busy: this.busy }))
        .child(this.button("kc-aws", "AWS login", t, () => this.awsLogin())));
      return this.surface(t, rows);
    }

    for (const dep of d.deploys ?? []) {
      const src = dep.source;
      rows.push(this.section("Deploy running", t, [
        this.row(t, `${SCRIPT[dep.script] ?? dep.script}${dep.targets?.length ? ` ${dep.targets.join(", ")}` : ""}`, dur(dep.elapsed ?? 0)),
        this.note(t, `${dep.phase} · from ${src?.worktree ?? dep.folder ?? "unknown folder"}${src?.branch && src.branch !== src.worktree ? ` (${src.branch})` : ""}`),
      ]));
    }
    if (d.rolling?.length) rows.push(this.section("Rolling out", t, [this.note(t, d.rolling.map((w) => w.split("/")[1]).join(", "))]));

    const groups = this.groups();
    const upstream = (d.services ?? []).filter((s) => s.kind === "upstream").length;
    const deployed = groups.map((g, i) => v_flex().gap(1)
      .child(this.row(t, g.key, ago(g.built), i === 0 ? t.foreground : t.muted))
      .child(this.note(t, [
        g.from?.branch && g.from.branch !== g.key ? g.from.branch : null,
        short(g.revision),
        g.from?.behind ? `${g.from.behind} commit${g.from.behind === 1 ? "" : "s"} behind HEAD` : null,
      ].filter(Boolean).join(" · ")))
      .child(this.note(t, g.images.join(", "), t.dim))
      .when(g.stale.length > 0, (el) => el.child(this.note(t, `Pushed, not rolled out: ${g.stale.join(", ")}`, t.blocked))));
    if (upstream) deployed.push(this.row(t, `Upstream ${short(d.baseline)}`, `${upstream} image${upstream === 1 ? "" : "s"}`, t.muted));
    if (!groups.length) deployed.unshift(this.note(t, "No local builds: every image is upstream."));
    rows.push(this.section("Deployed", t, deployed));

    const bad = d.pods?.bad ?? [];
    const health = [
      this.row(t, "app.sift.test", d.app ?? "no answer", d.app === 200 ? t.foreground : t.blocked),
      this.row(t, "Pods ready", `${(d.pods?.total ?? 0) - bad.length}/${d.pods?.total ?? 0}`, bad.length ? t.blocked : t.foreground),
      ...bad.slice(0, 5).map((p) => this.row(t, `  ${p.name}`, p.reason, t.blocked)),
    ];
    if (bad.length > 5) health.push(this.note(t, `  +${bad.length - 5} more`, t.dim));
    if (d.jobs_failed?.length) health.push(this.note(t, `Failed jobs: ${d.jobs_failed.join(", ")}`, t.dim));
    rows.push(this.section("Health", t, health));

    const a = d.agents ?? {};
    const min = d.min_free ?? 2;
    rows.push(this.section("Agent pods", t, [
      this.row(t, "Ready", a.want != null ? `${a.ready}/${a.want}` : "no uce-agents deployment", a.want != null && a.ready < a.want ? t.blocked : t.foreground),
      this.row(t, "Leased", a.leased ?? "unknown"),
      this.row(t, "Free", a.free != null ? `${a.free} (want ${min}+)` : "unknown", a.free != null && a.free < min ? t.blocked : t.foreground),
    ]));

    rows.push(this.awsSection(d, t));
    rows.push(...this.healSection(d, t));
    rows.push(h_flex().gap(6).items_center()
      .child(this.button("kc-refresh", "Refresh", t, (cx) => this.refresh(cx), { busy: this.busy }))
      .when(Boolean(d.heal?.length) || this.healing, (el) => el.child(
        this.button("kc-heal", this.healing ? "Healing" : `Heal (${d.heal.length})`, t, (cx) => this.heal(cx), { primary: true, busy: this.healing })))
      .child(this.button("kc-aws", "AWS login", t, () => this.awsLogin(), { primary: this.awsState().level === "bad" }))
      .child(div().flex_1())
      .child(div().flex_none().text_size(11).text_color(t.dim).child(this.busy ? "Refreshing" : `Updated ${ago(d.at)}`)));
    return this.surface(t, rows);
  }

  awsSection(d, t) {
    const a = d.aws ?? {};
    const st = this.awsState();
    const col = st.level === "bad" ? t.ansi1 : st.level === "stale" ? t.blocked : t.foreground;
    return this.section("AWS", t, [
      this.row(t, a.profile ?? "default", st.label, col),
      this.note(t, a.age != null ? `~/.aws/credentials written ${ago(Date.now() / 1000 - a.age)}` : "~/.aws/credentials not found", t.dim),
    ]);
  }

  // What Heal would do, or what the last heal did.
  healSection(d, t) {
    if (this.healed) {
      return [this.section("Last heal", t, this.healed.map((s) =>
        this.row(t, `${s.ok ? "✓" : "✗"} ${s.step}`, null, s.ok ? t.foreground : t.ansi1)
          .when(!s.ok && Boolean(s.detail), (el) => el.tooltip(s.detail))))];
    }
    if (!d.heal?.length) return [];
    return [this.section("Heal will", t, d.heal.slice(0, 6).map((s) => this.row(t, s.step, null)
      .child(div().flex_none().text_size(11).text_color(t.dim).child(s.why))))];
  }

  surface(t, rows) {
    return v_flex().w(380).p(12).gap(10).bg(t.popover).border(1).border_color(t.border).rounded(8).text_size(12).children(rows);
  }

  render() {
    const t = theme();
    const st = this.state();
    return h_flex().size_full().px(6).items_center().bg(t.chrome).border_t(1).border_l(1).border_color(t.border).text_size(11.8)
      .child(HoverCard.new("kind-card").anchor("bottom_left").open_delay(350).close_delay(250)
        .trigger(this.bar(st, t))
        .content(this.card(st, t)));
  }
}
