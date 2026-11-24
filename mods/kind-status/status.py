#!/usr/bin/env python3
"""Prints the local kind stack's status as one JSON line.

  status.py [--repo <azimuth checkout>] [--min-free <n>]

What it reads, all local:
  - kubectl --context kind-kind: pods, deployments, statefulsets in sift and
    uce-runner, and the local-dev-baseline ConfigMap (the base image SHA).
  - The kind registry (localhost:5001): each running azimuth image's manifest
    digest, and its buildx provenance (vcs:revision, build time). A running pod
    whose image digest matches the registry runs a local build; one whose tag is
    missing there runs the upstream image from nexus.
  - git worktree list on the azimuth repo, to name the worktree a revision came from.
  - ps + lsof, to find a running deploy script and the worktree it runs in.
  - postgres-0 (azimuth db): active agent pod leases, to count free agent pods.
  - https://app.sift.test, expecting a 200.

Provenance is cached by manifest digest under ~/Library/Caches/herdr-kind-status.
"""
import argparse
import json
import os
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

CTX = "kind-kind"
REGISTRY = "localhost:5001"
IMAGE_PREFIX = f"{REGISTRY}/sift-stack/azimuth/"
NAMESPACES = ("sift", "uce-runner")
AGENTS = ("uce-runner", "uce-agents")
CACHE = os.path.expanduser("~/Library/Caches/herdr-kind-status/provenance.json")
APP_URL = "https://app.sift.test"
SCRIPTS = ("setup_local_k8s.sh", "local_build_and_deploy.sh", "local_apply.sh",
           "local_restart.sh", "local_use_upstream.sh")
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def sh(args, timeout=8, cwd=None):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return r.returncode, r.stdout, r.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 1, "", str(e)


def kubectl(*args, timeout=8):
    return sh(["kubectl", "--context", CTX, "--request-timeout=6s", *args], timeout=timeout)


def iso(s):
    if not s:
        return None
    try:
        return int(datetime.fromisoformat(re.sub(r"\.\d+", "", s).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


# ---------------------------------------------------------------- deploy scripts

def deploys():
    """Running deploy scripts: [{script, targets, folder, started, phase}]."""
    code, out, _ = sh(["ps", "-axo", "pid=,ppid=,etime=,command="])
    if code:
        return []
    procs = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            procs.append({"pid": parts[0], "ppid": parts[1], "etime": parts[2], "cmd": parts[3]})
    kids = {}
    for p in procs:
        kids.setdefault(p["ppid"], []).append(p)

    def descendants(pid):
        out, stack = [], [pid]
        while stack:
            for k in kids.get(stack.pop(), []):
                out.append(k)
                stack.append(k["pid"])
        return out

    found, seen = [], set()
    for p in procs:
        words = p["cmd"].split()
        idx = next((i for i, w in enumerate(words[:3]) if os.path.basename(w) in SCRIPTS), None)
        if idx is None:
            continue
        script = os.path.basename(words[idx])
        # A script's subshells repeat its command line; keep the outermost one.
        parent = next((q for q in procs if q["pid"] == p["ppid"]), None)
        if parent and script in parent["cmd"]:
            continue
        if p["pid"] in seen:
            continue
        seen.add(p["pid"])
        _, lo, _ = sh(["lsof", "-a", "-p", p["pid"], "-d", "cwd", "-Fn"], timeout=4)
        folder = next((l[1:] for l in lo.splitlines() if l.startswith("n")), None)
        sub = " ".join(d["cmd"] for d in descendants(p["pid"]))
        phase = ("building" if "buildx" in sub or "buildctl" in sub
                 else "deploying" if "kluctl" in sub
                 else "restarting" if "rollout" in sub
                 else "installing tools" if "bootstrap/tools" in sub
                 else "starting")
        found.append({"script": script, "targets": [w for w in words[idx + 1:] if not w.startswith("-")],
                      "folder": folder, "elapsed": etime_seconds(p["etime"]), "phase": phase})
    return found


def etime_seconds(s):
    days, _, rest = s.rpartition("-")
    nums = [int(x) for x in rest.split(":")]
    while len(nums) < 3:
        nums.insert(0, 0)
    return (int(days) if days else 0) * 86400 + nums[0] * 3600 + nums[1] * 60 + nums[2]


# ---------------------------------------------------------------- registry

def reg(path, accept=ACCEPT, method="GET"):
    req = urllib.request.Request(f"http://{REGISTRY}/v2/{path}", method=method, headers={"Accept": accept})
    return urllib.request.urlopen(req, timeout=4)


def load_cache():
    try:
        with open(CACHE) as f:
            return json.load(f)
    except Exception:
        return {}


def provenance(repo, index_digest, cache):
    """{revision, built} for a local image, from its buildx attestation."""
    if index_digest in cache:
        return cache[index_digest]
    info = {"revision": None, "built": None}
    try:
        index = json.load(reg(f"{repo}/manifests/{index_digest}"))
        att = next((m for m in index.get("manifests", [])
                    if (m.get("annotations") or {}).get("vnd.docker.reference.type") == "attestation-manifest"), None)
        if att:
            man = json.load(reg(f"{repo}/manifests/{att['digest']}", "application/vnd.oci.image.manifest.v1+json"))
            layer = next((l for l in man.get("layers", [])
                          if "provenance" in (l.get("annotations") or {}).get("in-toto.io/predicate-type", "")), None)
            if layer:
                pred = json.load(reg(f"{repo}/blobs/{layer['digest']}"))["predicate"]
                meta = (pred.get("runDetails") or {}).get("metadata") or pred.get("metadata") or {}
                vcs = (meta.get("buildkit_metadata") or {}).get("vcs") or {}
                info = {"revision": vcs.get("revision"), "built": iso(meta.get("finishedOn"))}
    except Exception:
        return info  # not cached: try again next poll
    cache[index_digest] = info
    return info


def image_source(image, running_digest, cache):
    """Where one running image came from: local build, upstream, or a stale local push."""
    ref = image[len(IMAGE_PREFIX):]
    name, _, tag = ref.partition(":")
    repo = f"sift-stack/azimuth/{name}"
    try:
        digest = reg(f"{repo}/manifests/{tag}", method="HEAD").headers.get("Docker-Content-Digest")
    except urllib.error.HTTPError as e:
        return {"kind": "upstream"} if e.code == 404 else {"kind": "unknown"}
    except Exception:
        return {"kind": "unknown"}
    if running_digest and digest and running_digest != digest:
        # A newer local push that the pods haven't picked up (or an old pull still cached).
        return {"kind": "stale", **provenance(repo, digest, cache)}
    return {"kind": "local", **provenance(repo, digest, cache)}


# ---------------------------------------------------------------- git

def worktrees(repo):
    code, out, _ = sh(["git", "-C", repo, "worktree", "list", "--porcelain"], timeout=5)
    if code:
        return []
    trees, cur = [], {}
    for line in out.splitlines() + [""]:
        if not line:
            if cur:
                trees.append(cur)
            cur = {}
        elif line.startswith("worktree "):
            cur["path"] = line[9:]
        elif line.startswith("HEAD "):
            cur["head"] = line[5:]
        elif line.startswith("branch "):
            cur["branch"] = line[7:].removeprefix("refs/heads/")
    return trees


def worktree_name(tree, repo):
    return "main checkout" if os.path.realpath(tree["path"]) == os.path.realpath(repo) else os.path.basename(tree["path"])


def name_revision(rev, repo, trees):
    """{worktree, branch, path, behind} for a revision: the worktree whose HEAD it is,
    else the nearest worktree it's an ancestor of, else a branch pointing at it."""
    if not rev:
        return None
    for t in trees:
        if t.get("head") == rev:
            return {"worktree": worktree_name(t, repo), "branch": t.get("branch"), "path": t["path"], "behind": 0}
    best = None
    for t in trees:
        if not t.get("head"):
            continue
        code, out, _ = sh(["git", "-C", repo, "rev-list", "--count", f"{rev}..{t['head']}"], timeout=4)
        if code:
            continue
        ok, _, _ = sh(["git", "-C", repo, "merge-base", "--is-ancestor", rev, t["head"]], timeout=4)
        if ok == 0 and (best is None or int(out) < best["behind"]):
            best = {"worktree": worktree_name(t, repo), "branch": t.get("branch"), "path": t["path"], "behind": int(out)}
    if best and best["behind"] <= 50:
        return best
    code, out, _ = sh(["git", "-C", repo, "for-each-ref", "--points-at", rev, "--format=%(refname:short)", "refs/heads"], timeout=4)
    branch = out.split()[0] if code == 0 and out.split() else None
    return {"worktree": None, "branch": branch, "path": None, "behind": None}


def folder_worktree(folder, repo, trees):
    if not folder:
        return None
    real = os.path.realpath(folder)
    for t in trees:
        if os.path.realpath(t["path"]) == real:
            return {"worktree": worktree_name(t, repo), "branch": t.get("branch"), "path": t["path"]}
    code, out, _ = sh(["git", "-C", folder, "branch", "--show-current"], timeout=3)
    return {"worktree": os.path.basename(folder), "branch": out.strip() if code == 0 else None, "path": folder}


# ---------------------------------------------------------------- cluster

def job_pod(p):
    return any(o.get("kind") == "Job" for o in p["metadata"].get("ownerReferences") or [])


def pod_problem(p):
    phase = p["status"].get("phase")
    # Finished pods, and a Job's failed attempts (the Job itself is reported instead).
    if phase == "Succeeded" or (phase == "Failed" and job_pod(p)):
        return None
    for c in (p["status"].get("initContainerStatuses") or []) + (p["status"].get("containerStatuses") or []):
        w = (c.get("state") or {}).get("waiting")
        if w and w.get("reason") not in (None, "PodInitializing", "ContainerCreating"):
            return w["reason"]
    if phase != "Running":
        return phase or "Unknown"
    if not all(c.get("ready") for c in p["status"].get("containerStatuses") or []):
        return "NotReady"
    return None


def workload_lag(w):
    spec = w["spec"].get("replicas", 1)
    st = w.get("status") or {}
    return {
        "name": f'{w["kind"].lower()}/{w["metadata"]["name"]}',
        "want": spec,
        "ready": st.get("readyReplicas", 0),
        "rolling": (st.get("observedGeneration", 0) < w["metadata"].get("generation", 0)
                    or st.get("updatedReplicas", spec) < spec
                    or st.get("replicas", spec) > spec),
    }


def leased_ips():
    q = "select split_part(pod_endpoint, ':', 1) from agent_pod_leases where status = 'active'"
    code, out, _ = kubectl("-n", "sift", "exec", "postgres-0", "-c", "postgres", "--",
                           "psql", "-U", "postgres", "-d", "azimuth", "-At", "-c", q, timeout=8)
    return set(out.split()) if code == 0 else None


def app_check():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(urllib.request.Request(APP_URL, method="HEAD"), timeout=4, context=ctx) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.path.expanduser("~/Documents/code/azimuth"))
    ap.add_argument("--min-free", type=int, default=2)
    a = ap.parse_args()
    repo = os.path.expanduser(a.repo)

    with ThreadPoolExecutor(8) as pool:
        f_dep = pool.submit(deploys)
        f_trees = pool.submit(worktrees, repo)
        f_app = pool.submit(app_check)
        f_ns = {ns: pool.submit(kubectl, "-n", ns, "get", "pods,deployments,statefulsets,jobs", "-o", "json") for ns in NAMESPACES}
        f_base = pool.submit(kubectl, "-n", "sift", "get", "configmap", "local-dev-baseline", "-o", "jsonpath={.data.image_sha}")
        f_leases = pool.submit(leased_ips)
        trees = f_trees.result()
        out = {"at": int(time.time()), "repo": repo, "min_free": a.min_free,
               "deploys": [{**d, "source": folder_worktree(d["folder"], repo, trees)} for d in f_dep.result()]}

        items = []
        for ns, f in f_ns.items():
            code, stdout, err = f.result()
            if code:
                out["error"] = "down" if ("refused" in err or "Unable to connect" in err or "timeout" in err.lower()) else (err.strip().splitlines() or ["kubectl failed"])[-1][:160]
                print(json.dumps(out))
                return
            items += [{**i, "ns": ns} for i in json.loads(stdout)["items"]]

        pods = [i for i in items if i["kind"] == "Pod"]
        workloads = [workload_lag(i) | {"ns": i["ns"]} for i in items if i["kind"] in ("Deployment", "StatefulSet")]
        code, base, _ = f_base.result()
        out["baseline"] = base.strip() if code == 0 and base.strip() else None
        out["jobs_failed"] = [i["metadata"]["name"] for i in items if i["kind"] == "Job" and any(
            c.get("type") == "Failed" and c.get("status") == "True" for c in (i.get("status") or {}).get("conditions") or [])]
        out["app"] = f_app.result()

        # Health: pods that aren't running and ready, workloads short of replicas, rollouts in flight.
        out["pods"] = {"total": sum(1 for p in pods if p["status"].get("phase") != "Succeeded"),
                       "bad": [{"name": p["metadata"]["name"], "ns": p["ns"], "reason": r}
                               for p in pods if (r := pod_problem(p))]}
        out["rolling"] = [w["name"] for w in workloads if w["rolling"]]
        out["short"] = [w for w in workloads if w["ready"] < w["want"] and not w["rolling"]]

        # Agent pool.
        ns, comp = AGENTS
        agent_pods = [p for p in pods if p["ns"] == ns and p["metadata"].get("labels", {}).get("component") == comp]
        ready = [p for p in agent_pods if not pod_problem(p) and not p["metadata"].get("deletionTimestamp")]
        want = next((w["want"] for w in workloads if w["ns"] == ns and w["name"] == f"deployment/{comp}"), None)
        leases = f_leases.result()
        leased = None if leases is None else sum(1 for p in ready if p["status"].get("podIP") in leases)
        out["agents"] = {"want": want, "ready": len(ready), "leased": leased,
                         "free": None if leased is None else len(ready) - leased}

        # Where each running azimuth image came from.
        images = {}
        for p in pods:
            if p["status"].get("phase") == "Succeeded":
                continue
            for c in p["status"].get("containerStatuses") or []:
                img = c.get("image", "")
                if img.startswith(IMAGE_PREFIX):
                    digest = (c.get("imageID") or "").rpartition("@")[2] or None
                    images.setdefault(img, {"digest": digest})
        cache = load_cache()
        before = len(cache)
        sources = list(pool.map(lambda kv: (kv[0], image_source(kv[0], kv[1]["digest"], cache)), images.items()))
        if len(cache) != before:
            os.makedirs(os.path.dirname(CACHE), exist_ok=True)
            with open(CACHE, "w") as f:
                json.dump(cache, f)

    services = []
    for img, src in sources:
        name, _, tag = img[len(IMAGE_PREFIX):].partition(":")
        services.append({"image": name, "tag": tag, **src,
                         "from": name_revision(src.get("revision"), repo, trees) if src.get("revision") else None})
    services.sort(key=lambda s: (s["kind"] != "local", -(s.get("built") or 0), s["image"]))
    out["services"] = services
    if not out["baseline"]:
        # Clusters set up before setup_local_k8s.sh recorded local-dev-baseline: the most common tag.
        tags = [re.sub(r"^source-", "", s["tag"]) for s in services if re.fullmatch(r"(source-)?[0-9a-f]{40}", s["tag"])]
        out["baseline"] = max(set(tags), key=tags.count) if tags else None
    print(json.dumps(out))


if __name__ == "__main__":
    main()
