// Local kind stack status for the Flight Deck status bar: one chip with a
// status dot (a spinner while a deploy runs), the worktree whose build is
// deployed, free agent pods and AWS creds. Hover for the details card: what
// each worktree built, a running deploy, cluster health, the agent pool and
// AWS, with Refresh, Heal and AWS login buttons. Click the chip to refresh.
// status.py does the probing (kubectl, the kind registry's build provenance,
// git worktrees, ps, postgres leases, sts, app.sift.test) and the healing.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { exec, props, theme, appHome, checking, window, run, notify, shared } from "herdr";

const IDLE_MS = 30 * 1000;
const BUSY_MS = 5 * 1000;
const SPINNER = "mods/kind-status/spinner.svg";
const ICON = (name) => `mods/kind-status/icons/${name}.svg`;

// A theme color at an opacity, as #rrggbbaa.
const alpha = (color, a) => (typeof color === "string" && /^#[0-9a-fA-F]{6}/.test(color)
  ? color.slice(0, 7) + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0")
  : color);

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
      const wait = this.deploying() || this.healing || this.data?.pods?.starting?.length || Date.now() < this.fastUntil ? BUSY_MS : IDLE_MS;
      if (Date.now() - this.last >= wait - 500) this.refresh(cx);
    });
  }

  // A refresh asked for while one runs (after a heal, say) runs again once that one ends,
  // so the card never keeps data read before the change.
  refresh(cx) {
    if (this.demo) return;
    if (this.busy) { this.again = true; return; }
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
      if (this.again) { this.again = false; this.refresh(cx); }
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
    for (const u of d.unhealable ?? []) reasons.push(`Heal can't fix: ${u}`);
    const a = d.agents ?? {};
    if (a.want != null && a.ready < a.want) reasons.push(`${a.ready}/${a.want} agent pods ready`);
    if (a.free != null && a.free < (d.min_free ?? 2)) reasons.push(`${a.free} free agent pod${a.free === 1 ? "" : "s"}`);
    if (d.postgres === false) reasons.push("postgres has no leader");
    const aws = this.awsState();
    if (aws.level !== "ok") reasons.push(aws.reason);
    if (this.healing) return { level: "deploying", label: "Healing", reasons };
    if (this.deploying()) return { level: "deploying", label: "Deploying", reasons };
    if (d.pods?.starting?.length && !reasons.length) return { level: "deploying", label: "Starting", reasons: [`${d.pods.starting.length} pod${d.pods.starting.length === 1 ? "" : "s"} starting`] };
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
    const name = this.healing ? "Healing"
      : dep
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

  button(id, label, t, onClick, { primary = false, busy = false, icon = null, tone = null } = {}) {
    const fg = primary ? t.solid_foreground : tone ?? t.foreground;
    return h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer().text_size(11.5).font_medium()
      .bg(primary ? t.solid : alpha(tone ?? t.foreground, 0.07)).text_color(fg)
      .border(1).border_color(primary ? t.solid : alpha(tone ?? t.foreground, 0.12))
      .hover((s) => s.bg(primary ? alpha(t.solid, 0.85) : alpha(tone ?? t.foreground, 0.12)))
      .on_click((_e, cx) => onClick(cx))
      .child(busy ? svg(SPINNER).size(11).spin(900) : icon ? svg(icon).size(12) : div())
      .child(label);
  }

  // A small square icon button with a tooltip.
  iconButton(id, icon, tip, t, onClick, { busy = false, tone = null } = {}) {
    return div().id(id).size(22).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(tone ?? t.muted).tooltip(tip)
      .when(Boolean(tone), (el) => el.bg(alpha(tone, 0.14)))
      .hover((s) => s.bg(alpha(tone ?? t.foreground, 0.16)).text_color(tone ?? t.foreground))
      .on_click((_e, cx) => onClick(cx))
      .child(busy ? svg(SPINNER).size(12).spin(900) : svg(icon).size(12));
  }

  // ------------------------------------------------------------------ card
  // A header, an optional banner of what's wrong, then one tile per topic
  // (Deploying, Deployed, Health, Agent pods, AWS, Heal), then the actions.

  // A rounded label tinted with its color: the card's state, each tile's summary.
  pill(text, color, { spin = false, dot = true } = {}) {
    return h_flex().h(20).px(8).gap(5).items_center().flex_none().rounded(10).text_size(11).font_medium()
      .bg(alpha(color, 0.16)).text_color(color)
      .when(spin, (el) => el.child(svg(SPINNER).size(10).spin(900)))
      .when(!spin && dot, (el) => el.child(div().size(6).rounded(3).bg(color)))
      .child(text);
  }

  tile(t, icon, title, summary, children) {
    return v_flex().p(10).gap(8).rounded(8)
      .bg(alpha(t.foreground, 0.035)).border(1).border_color(alpha(t.foreground, 0.07))
      .child(h_flex().gap(7).items_center()
        .child(svg(icon).size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child(title))
        .when(Boolean(summary), (el) => el.child(summary)))
      .children(children);
  }

  // One number with its label under it.
  stat(label, value, color, t) {
    return v_flex().flex_1().min_w(0).px(8).py(6).gap(1).rounded(6).bg(alpha(t.foreground, 0.04))
      .child(div().text_size(15).font_semibold().text_color(color ?? t.foreground).child(String(value)))
      .child(div().text_size(10.5).text_color(t.dim).child(label));
  }

  tag(text, t, color) {
    return div().h(18).px(6).flex().items_center().rounded(4).text_size(10.5)
      .bg(alpha(color ?? t.foreground, 0.08)).text_color(color ?? t.muted).child(text);
  }

  line(t, left, right, color) {
    return h_flex().gap(8).items_center().text_size(12)
      .child(div().min_w(0).flex_1().truncate().text_color(color ?? t.foreground).child(left))
      .when(right != null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(right))));
  }

  note(t, text, color) {
    return div().text_size(11).text_color(color ?? t.dim).child(text);
  }

  levelColor(level, t) {
    return { ok: t.done, warn: t.blocked, bad: t.ansi1, busy: t.working }[level] ?? t.dim;
  }

  card(st, t) {
    const d = this.data ?? {};
    const color = this.color(st.level, t);
    const header = h_flex().px(14).pt(12).pb(10).gap(10).items_center()
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("Local kind stack"))
        .child(div().text_size(11).text_color(t.dim).truncate()
          .child(d.error ? "kind-kind" : `kind-kind · base ${short(d.baseline) || "unknown"}`)))
      .child(this.pill(st.label, color, { spin: st.level === "deploying" || st.level === "loading" }));

    const body = [];
    if (st.reasons.length && st.level !== "healthy") {
      const tone = st.level === "down" ? t.ansi1 : st.level === "deploying" ? t.working : t.blocked;
      body.push(h_flex().p(10).gap(8).items_start().rounded(8)
        .bg(alpha(tone, 0.1)).border(1).border_color(alpha(tone, 0.3))
        .child(svg(ICON("triangle-alert")).size(14).flex_none().mt(1).text_color(tone))
        .child(v_flex().flex_1().min_w(0).gap(2).children(st.reasons.map((r) => div().text_size(12).text_color(tone).child(r)))));
    }

    if (d.error) {
      body.push(this.note(t, "Start Docker and the kind containers, or run scripts/setup_local_k8s.sh in the azimuth repo.", t.muted));
      if (d.aws) body.push(this.awsTile(d, t));
    } else {
      body.push(...this.deployTiles(d, t), this.deployedTile(d, t), this.healthTile(d, t), this.agentsTile(d, t), this.awsTile(d, t));
      const heal = this.healTile(d, t);
      if (heal) body.push(heal);
    }

    const footer = h_flex().px(12).py(6).gap(4).items_center().justify_end().border_t(1).border_color(alpha(t.foreground, 0.07))
      .child(div().text_size(10.5).text_color(t.dim).child(this.busy ? "Refreshing…" : `Updated ${ago(d.at)}`))
      .child(this.iconButton("kc-refresh", ICON("rotate-cw"), "Refresh", t, (cx) => this.refresh(cx), { busy: this.busy }));

    return v_flex().w(400).bg(t.popover).border(1).border_color(t.border).rounded(10).overflow_hidden().text_size(12)
      .child(header)
      .child(v_flex().px(12).pb(12).gap(8).children(body))
      .child(footer);
  }

  deployTiles(d, t) {
    const tiles = (d.deploys ?? []).map((dep, i) => {
      const src = dep.source;
      return this.tile(t, ICON("rocket"), "Deploying", this.pill(dur(dep.elapsed ?? 0), t.working, { spin: true }), [
        this.line(t, `${SCRIPT[dep.script] ?? dep.script}${dep.targets?.length ? ` ${dep.targets.join(", ")}` : ""}`, dep.phase),
        this.note(t, `from ${src?.worktree ?? dep.folder ?? "unknown folder"}${src?.branch && src.branch !== src.worktree ? ` · ${src.branch}` : ""}`),
      ]);
    });
    if (d.rolling?.length) {
      tiles.push(this.tile(t, ICON("rocket"), "Rolling out", this.pill(String(d.rolling.length), t.working, { spin: true }), [
        h_flex().flex_wrap().gap(4).children(d.rolling.map((w) => this.tag(w.split("/")[1], t, t.working))),
      ]));
    }
    return tiles;
  }

  deployedTile(d, t) {
    const groups = this.groups();
    const colors = shared("worktree.colors") ?? {};
    const upstream = (d.services ?? []).filter((s) => s.kind === "upstream").length;
    const rows = groups.map((g, i) => {
      const dot = colors[g.from?.path] ?? (i === 0 ? t.accent : t.dim);
      const meta = [
        g.from?.branch && g.from.branch !== g.key ? g.from.branch : null,
        short(g.revision),
        g.from?.behind ? `${g.from.behind} behind HEAD` : null,
      ].filter(Boolean).join(" · ");
      return v_flex().gap(4)
        .child(h_flex().gap(7).items_center()
          .child(div().size(8).flex_none().rounded(4).bg(dot))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium()
            .text_color(i === 0 ? t.foreground : t.muted).child(g.key))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(g.built))))
        .child(v_flex().pl(15).gap(4)
          .when(Boolean(meta), (el) => el.child(this.note(t, meta)))
          .child(h_flex().flex_wrap().gap(4)
            .children(g.images.map((img) => this.tag(img, t)))
            .children(g.stale.map((img) => this.tag(`${img} · not rolled out`, t, t.blocked)))));
    });
    if (!groups.length) rows.push(this.note(t, "No local builds. Every image is upstream.", t.muted));
    if (upstream) {
      rows.push(h_flex().gap(7).items_center().pt(2)
        .child(div().size(8).flex_none().rounded(4).border(1).border_color(t.dim))
        .child(div().flex_1().text_size(12).text_color(t.muted).child(`Upstream ${short(d.baseline)}`))
        .child(div().text_size(11).text_color(t.dim).child(`${upstream} images`)));
    }
    const summary = groups.length ? this.pill(`${groups.length} worktree${groups.length === 1 ? "" : "s"}`, t.accent, { dot: false }) : null;
    return this.tile(t, ICON("git-branch"), "Deployed", summary, rows);
  }

  healthTile(d, t) {
    const bad = d.pods?.bad ?? [];
    const starting = d.pods?.starting ?? [];
    const total = d.pods?.total ?? 0;
    const ready = total - bad.length - starting.length;
    const appOk = d.app === 200;
    const level = !appOk || bad.length || d.postgres === false ? "warn" : starting.length ? "busy" : "ok";
    const summary = this.pill({ ok: "Healthy", warn: "Issues", busy: "Starting" }[level], this.levelColor(level, t), { spin: level === "busy" });
    const rows = [h_flex().gap(6)
      .child(this.stat("app.sift.test", d.app ?? "—", appOk ? t.done : t.ansi1, t))
      .child(this.stat("pods ready", `${ready}/${total}`, bad.length ? t.blocked : starting.length ? t.working : t.done, t))
      .child(this.stat("postgres", d.postgres === false ? "no leader" : d.postgres ? "leader" : "—", d.postgres === false ? t.ansi1 : t.done, t))];
    if (bad.length || starting.length) {
      rows.push(v_flex().gap(3)
        .children(bad.slice(0, 5).map((p) => this.line(t, p.name, p.reason, t.blocked)))
        .children(starting.slice(0, 3).map((n) => this.line(t, n, "starting", t.working)))
        .when(bad.length > 5, (el) => el.child(this.note(t, `+${bad.length - 5} more`))));
    }
    if (d.jobs_failed?.length) {
      rows.push(h_flex().gap(4).flex_wrap().items_center()
        .child(div().text_size(10.5).text_color(t.dim).mr(2).child("Failed jobs"))
        .children(d.jobs_failed.map((j) => this.tag(j, t))));
    }
    return this.tile(t, ICON("activity"), "Health", summary, rows);
  }

  agentsTile(d, t) {
    const a = d.agents ?? {};
    const min = d.min_free ?? 2;
    const short_ = a.want != null && a.ready < a.want;
    const low = a.free != null && a.free < min;
    const summary = a.want == null ? this.pill("No pool", t.dim)
      : this.pill(low ? "Low" : short_ ? "Short" : "Ready", low || short_ ? t.blocked : t.done);
    // A bar of the pool: leased, free, and the pods still missing.
    const want = Math.max(a.want ?? 0, a.ready ?? 0, 1);
    const seg = (n, color) => div().h(6).rounded(3).bg(color).flex_basis(`${(n / want) * 100}%`);
    const bar = h_flex().h(6).gap(2).w_full()
      .when((a.leased ?? 0) > 0, (el) => el.child(seg(a.leased, t.accent)))
      .when((a.free ?? 0) > 0, (el) => el.child(seg(a.free, low ? t.blocked : t.done)))
      .when(short_, (el) => el.child(seg(a.want - a.ready, alpha(t.foreground, 0.12))));
    return this.tile(t, ICON("cpu"), "Agent pods", summary, a.want == null ? [this.note(t, "No uce-agents deployment.")] : [
      h_flex().gap(6)
        .child(this.stat("free", a.free ?? "—", low ? t.blocked : t.done, t))
        .child(this.stat("leased", a.leased ?? "—", t.accent, t))
        .child(this.stat("ready", `${a.ready}/${a.want}`, short_ ? t.blocked : t.foreground, t)),
      bar,
      this.note(t, `Wants at least ${min} free.`),
    ]);
  }

  awsTile(d, t) {
    const a = d.aws ?? {};
    const st = this.awsState();
    const level = st.level === "bad" ? "bad" : st.level === "stale" ? "warn" : "ok";
    const localLabel = { ok: "Valid", expired: "Expired", invalid: "Invalid", missing: "Missing", unknown: "Unchecked" }[a.local] ?? a.local;
    const clusterLabel = { synced: "In sync", stale: "Older creds", missing: "No secret", unknown: "Unknown" }[a.cluster] ?? a.cluster;
    const tone = (ok, warn) => (ok ? t.done : warn ? t.blocked : t.ansi1);
    return this.tile(t, ICON("key-round"), "AWS", this.pill(st.level === "ok" ? "Valid" : st.level === "stale" ? "Check" : localLabel, this.levelColor(level, t)), [
      h_flex().gap(6)
        .child(this.stat("local creds", localLabel, tone(a.local === "ok", a.local === "unknown"), t))
        .child(this.stat("cluster copy", clusterLabel, tone(a.cluster === "synced", a.cluster !== "missing"), t)),
      h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(`${a.profile ?? "default"} · ${a.age != null ? `logged in ${ago(Date.now() / 1000 - a.age)}` : "no ~/.aws/credentials"}`))
        // Only when the creds aren't fresh: run aws-login, then push the creds to the cluster.
        .when(st.level !== "ok", (el) => el.child(this.iconButton("kc-aws", ICON("rotate-cw"),
          "Run aws-login and push the creds to the cluster", t, () => this.awsLogin(),
          { tone: this.levelColor(level, t) }))),
    ]);
  }

  // What Heal would do, with its button, or what the last heal did.
  healTile(d, t) {
    if (this.healed) {
      const failed = this.healed.some((s) => !s.ok);
      return this.tile(t, ICON("wrench"), "Last heal", this.pill(failed ? "Failed" : "Done", failed ? t.ansi1 : t.done),
        this.healed.map((s) => h_flex().id(`kc-healed-${s.step}`).gap(7).items_start()
          .when(!s.ok && Boolean(s.detail), (el) => el.tooltip(s.detail))
          .child(svg(ICON(s.ok ? "check" : "x")).size(13).flex_none().mt(1).text_color(s.ok ? t.done : t.ansi1))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(12).text_color(t.foreground).child(s.step))
            .when(!s.ok && Boolean(s.detail), (el) => el.child(this.note(t, s.detail, t.ansi1))))));
    }
    if (!d.heal?.length && !this.healing) return null;
    const steps = (d.heal ?? []).slice(0, 6).map((s) => h_flex().gap(7).items_start()
      .child(div().size(5).flex_none().mt(6).rounded(3).bg(t.blocked))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(12).text_color(t.foreground).child(s.step))
        .child(this.note(t, s.why))));
    return this.tile(t, ICON("wrench"), "Heal", null, [
      ...steps,
      h_flex().child(this.button("kc-heal", this.healing ? "Healing…" : `Heal ${d.heal.length} issue${d.heal.length === 1 ? "" : "s"}`, t,
        (cx) => this.heal(cx), { primary: true, busy: this.healing, icon: ICON("wrench") })),
    ]);
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
