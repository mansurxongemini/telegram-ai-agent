/**
 * Telegram client manager — WebSocket RPC client of the local Node.js bridge.
 *
 * gramjs no longer runs in the browser (esm.sh's `unenv` crypto polyfill lacks
 * crypto.createHash, which breaks MTProto auth). Instead, gramjs runs in the
 * Node bridge (server/server.js) and this module talks to it over a WebSocket.
 *
 * The public TelegramClientManager interface is unchanged, so service.js / the
 * UI keep working exactly as before:
 *   startLogin, completeLogin, connect, disconnect, onMessage,
 *   getDialogs, getMessages, sendMessage, setTyping, markRead,
 *   plus .me / .status / .ping / .reconnects
 */

import { Bus, EV } from "./bus.js";

/* ------------------------- Shared WebSocket layer ------------------------- */

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

let ws = null;
let wsReady = null; // promise that resolves when the socket is open
const pending = new Map(); // rpc id -> { resolve, reject, timer }
const managersByAccount = new Map(); // accountId -> TelegramClientManager
let rpcSeq = 0;

function connectWS() {
  if (wsReady) return wsReady;
  wsReady = new Promise((resolve) => {
    const open = () => {
      ws = new WebSocket(WS_URL);
      ws.addEventListener("open", () => {
        console.info("[bridge] connected", WS_URL);
        resolve();
      });
      ws.addEventListener("message", onWsMessage);
      ws.addEventListener("close", () => {
        console.warn("[bridge] disconnected — retrying in 2s");
        // fail any in-flight RPCs
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error("Bridge connection lost"));
        }
        pending.clear();
        wsReady = null;
        ws = null;
        setTimeout(connectWS, 2000);
      });
      ws.addEventListener("error", () => {
        try { ws.close(); } catch (_) {}
      });
    };
    open();
  });
  return wsReady;
}

function onWsMessage(ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }

  if (msg.type === "rpc-result") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else {
      const err = new Error(msg.error || "RPC error");
      if (msg.code) err.code = msg.code;
      p.reject(err);
    }
    return;
  }

  if (msg.type === "event") {
    const mgr = managersByAccount.get(msg.accountId);
    if (msg.event === "message") {
      if (mgr) mgr._handleIncoming(msg.payload);
    } else if (msg.event === "connection") {
      if (mgr) mgr._applyConnection(msg.payload);
    }
  }
}

async function rpc(method, args, { timeout = 60000 } = {}) {
  await connectWS();
  const id = `rpc_${++rpcSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Bridge RPC "${method}" timed out`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "rpc", id, method, args }));
  });
}

/* ----------------------------- Manager class ----------------------------- */

export class TelegramClientManager {
  constructor(account) {
    this.account = account;
    this.me = null;
    this.status = "disconnected";
    this.reconnects = 0;
    this.ping = null;
    this._messageHandlers = new Set();
    managersByAccount.set(account.id, this);
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    Bus.emit(EV.CONNECTION, {
      accountId: this.account.id,
      status,
      reconnects: this.reconnects,
      ping: this.ping,
      ...extra,
    });
  }

  _applyConnection(payload) {
    if (payload.status === "disconnected" && this.status === "connected") this.reconnects++;
    this._setStatus(payload.status, payload);
  }

  /** Called by the WS layer for pushed incoming messages. */
  _handleIncoming(mapped) {
    for (const fn of this._messageHandlers) {
      try {
        fn(mapped);
      } catch (e) {
        console.error("[bridge] message handler error", e);
      }
    }
    Bus.emit(EV.MESSAGE_NEW, mapped);
  }

  onMessage(fn) {
    this._messageHandlers.add(fn);
    return () => this._messageHandlers.delete(fn);
  }

  /* --- Login --- */
  async startLogin(phoneNumber) {
    this._setStatus("connecting");
    const res = await rpc("startLogin", { accountId: this.account.id, phone: phoneNumber });
    return { phoneCodeHash: res.phoneCodeHash, phoneNumber };
  }

  async completeLogin({ phoneNumber, phoneCodeHash, code, password }) {
    const res = await rpc("completeLogin", {
      accountId: this.account.id,
      phone: phoneNumber,
      phoneCodeHash,
      code,
      password,
    });
    this.me = res.me;
    this._setStatus("connected");
    return { me: res.me, stringSession: res.stringSession };
  }

  /* --- Session reconnect --- */
  async connect() {
    if (!this.account.stringSession) return false;
    this._setStatus("connecting");
    try {
      const res = await rpc("connect", {
        accountId: this.account.id,
        stringSession: this.account.stringSession,
      });
      if (res && res.ok) {
        this.me = res.me;
        this._setStatus("connected");
        return true;
      }
      this._setStatus("disconnected", { reason: "unauthorized" });
      return false;
    } catch (err) {
      this.reconnects++;
      this._setStatus("disconnected", { error: String(err) });
      return false;
    }
  }

  async disconnect() {
    try {
      await rpc("disconnect", { accountId: this.account.id });
    } catch (_) {}
    this._setStatus("disconnected");
  }

  /* --- Data --- */
  async getDialogs(limit = 120) {
    return rpc("getDialogs", { accountId: this.account.id, limit });
  }

  async getMessages(telegramChatId, { limit = 50, offsetId = 0 } = {}) {
    return rpc("getMessages", {
      accountId: this.account.id,
      chatId: telegramChatId,
      limit,
      offsetId,
    });
  }

  async sendMessage(telegramChatId, text, { replyTo = null } = {}) {
    return rpc("sendMessage", {
      accountId: this.account.id,
      chatId: telegramChatId,
      text,
      replyTo,
    });
  }

  async setTyping(telegramChatId, typing = true) {
    try {
      await rpc("setTyping", { accountId: this.account.id, chatId: telegramChatId, typing }, { timeout: 8000 });
    } catch (_) {}
  }

  async markRead(telegramChatId) {
    try {
      await rpc("markRead", { accountId: this.account.id, chatId: telegramChatId }, { timeout: 8000 });
    } catch (_) {}
  }
}

// Kick off the bridge connection eagerly so the first login feels instant.
connectWS();
