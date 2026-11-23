// Model and context for agents run as herdr-chat chats. A chat's terminal shows its
// transcript, not the agent's status line, so `hc read` finds neither. The chat's host
// knows both: this keeps one WebSocket link per chat and reads `model` and `usage` from
// the host's snapshot and patch records (the chat mod's protocol, client "flightdeck").

import { appHome, readTextFile } from "herdr";
import { WebSocket } from "websocket";
import { Buffer } from "buffer";
import { chatModel } from "./telemetry.js";

// A mod reload leaves the old build's links open until QuickJS collects them, so each
// build closes the links the builds before it opened.
const LINKS = Symbol.for("flightdeck.chat-links");
const BUILDS = Symbol.for("flightdeck.builds");
const BUILD = (globalThis[BUILDS] = (globalThis[BUILDS] ?? 0) + 1);
const ACK = JSON.stringify({ t: "ack" });
const HOST_BIN = /herdr-chat-(host|subagent)\b/;

// The chat a terminal hosts, or null. A kept terminal that herdr-core brought back as a
// login shell keeps its labels but runs no host.
export function chatOf(t) {
  const chat = t?.labels?.["herdr-chat.chat"];
  if (!chat) return null;
  if (Array.isArray(t.argv) && !t.argv.some((a) => HOST_BIN.test(a))) return null;
  return chat;
}

const toTelemetry = (s) => {
  const pct = s?.usage?.percent;
  return { ctx: typeof pct === "number" ? Math.min(100, pct) / 100 : null, model: chatModel(s?.model) };
};

export class ChatTelemetry {
  constructor(onChange) {
    this.onChange = onChange;
    this.links = new Map(); // chat -> { close, tel }
    const all = (globalThis[LINKS] ??= new Set());
    for (const l of all) if (l.build < BUILD) l.close();
  }

  // { ctx, model } for a chat once its host has answered, else null.
  get(chat) {
    return this.links.get(chat)?.tel ?? null;
  }

  // Keeps a link to each chat in `chats` and closes the others. A link that drops is
  // forgotten, so the next call opens it again.
  want(chats, cx) {
    for (const [chat, l] of this.links) if (!chats.has(chat)) l.close();
    for (const chat of chats) if (!this.links.has(chat)) this.open(chat, cx);
  }

  open(chat, cx) {
    const all = (globalThis[LINKS] ??= new Set());
    let ws = null;
    let closed = false;
    const link = {
      build: BUILD,
      tel: null,
      close: () => {
        if (closed) return;
        closed = true;
        all.delete(link);
        if (this.links.get(chat) === link) this.links.delete(chat);
        ws?.close().catch(() => {});
      },
    };
    all.add(link);
    this.links.set(chat, link);
    cx.spawn(async (cx) => {
      try {
        const entry = JSON.parse((await readTextFile(`${appHome()}/data/herdr-chat/chats/${chat}.json`)) ?? "null");
        if (!entry?.wsPort || !entry?.token || closed) return;
        ws = await WebSocket.connect(`ws://127.0.0.1:${entry.wsPort}/`);
        if (closed) return;
        await ws.write(JSON.stringify({ t: "hello", v: 1, token: entry.token, client: "flightdeck" }));
        let state = null;
        while (!closed) {
          const m = await ws.read();
          if (m == null) break;
          // The host sends at most 4 messages before an ACK.
          ws.write(ACK).catch(() => link.close());
          const text = typeof m === "string" ? m : Buffer.from(m).toString("utf8");
          let touched = false;
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            let rec;
            try { rec = JSON.parse(line); } catch { continue; }
            if (rec.t === "snapshot") { state = rec.state ?? {}; touched = true; }
            else if (rec.t === "patch" && rec.state && state) {
              if ("model" in rec.state || "usage" in rec.state) touched = true;
              state = { ...state, ...rec.state };
            } else if (rec.t === "bye") { link.close(); }
          }
          if (!touched) continue;
          const next = toTelemetry(state);
          if (link.tel?.ctx !== next.ctx || link.tel?.model !== next.model) {
            link.tel = next;
            this.onChange(cx);
          }
        }
      } catch {
        // Host gone or link dropped: forget it and let the next poll retry.
      } finally {
        link.close();
      }
    });
  }

  closeAll() {
    for (const l of [...this.links.values()]) l.close();
  }
}
