#!/usr/bin/env python3
"""Prints Claude Code and Codex subscription usage as one JSON line.

Reads the tokens the two CLIs already keep (Claude Code: the macOS keychain item
"Claude Code-credentials"; Codex: ~/.codex/auth.json). It never refreshes or
writes them: an expired token reports {"error": "expired"} until the CLI next runs.
"""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request

TIMEOUT = 10


def get(url, headers):
    req = urllib.request.Request(url, headers={"User-Agent": "herdr-usage-meter", **headers})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def iso_to_epoch(s):
    if not s:
        return None
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def http_error(e):
    return "expired" if isinstance(e, urllib.error.HTTPError) and e.code in (401, 403) else (
        f"http {e.code}" if isinstance(e, urllib.error.HTTPError) else "offline")


def claude():
    try:
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True, text=True, timeout=5, check=True).stdout
        oauth = json.loads(raw)["claudeAiOauth"]
    except Exception:
        return {"error": "signed out"}
    if oauth.get("expiresAt") and oauth["expiresAt"] / 1000 < time.time():
        return {"error": "expired"}
    try:
        d = get("https://api.anthropic.com/api/oauth/usage", {
            "Authorization": f"Bearer {oauth['accessToken']}",
            "anthropic-beta": "oauth-2025-04-20",
        })
    except Exception as e:
        return {"error": http_error(e)}
    windows = []
    for key, label, length in (("five_hour", "5h", 5 * 3600), ("seven_day", "week", 7 * 86400)):
        w = d.get(key)
        if w and w.get("utilization") is not None:
            windows.append({"label": label, "percent": w["utilization"],
                            "resets": iso_to_epoch(w.get("resets_at")), "length": length})
    # Per-model weekly limits (Fable today), shown in the tooltip only.
    extras = []
    for lim in d.get("limits") or []:
        model = ((lim.get("scope") or {}).get("model") or {}).get("display_name")
        if lim.get("kind") == "weekly_scoped" and model and lim.get("percent") is not None:
            extras.append({"label": f"{model} week", "percent": lim["percent"],
                           "resets": iso_to_epoch(lim.get("resets_at"))})
    return {"windows": windows, "extras": extras}


def codex():
    try:
        with open(os.path.expanduser("~/.codex/auth.json")) as f:
            tokens = json.load(f)["tokens"]
    except Exception:
        return {"error": "signed out"}
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    if tokens.get("account_id"):
        headers["ChatGPT-Account-Id"] = tokens["account_id"]
    try:
        d = get("https://chatgpt.com/backend-api/wham/usage", headers)
    except Exception as e:
        return {"error": http_error(e)}
    rl = d.get("rate_limit") or {}
    windows = []
    for key in ("primary_window", "secondary_window"):
        w = rl.get(key)
        if not w or w.get("used_percent") is None:
            continue
        secs = w.get("limit_window_seconds") or 0
        label = "week" if secs >= 6 * 86400 else f"{round(secs / 3600)}h" if secs else key.split("_")[0]
        windows.append({"label": label, "percent": w["used_percent"], "resets": w.get("reset_at"), "length": secs or None})
    return {"windows": windows, "plan": d.get("plan_type")}


print(json.dumps({"at": int(time.time()), "claude": claude(), "codex": codex()}))
