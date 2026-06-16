/**
 * Local Node.js bridge server for the Telegram AI Userbot Workspace.
 *
 * WHY THIS EXISTS
 * ----------------
 * gramjs (MTProto) relies on Node's `crypto` (createHash/createHmac/AES) and
 * `Buffer`. Running it directly in the browser via esm.sh pulls in the `unenv`
 * polyfill, whose `crypto.createHash` is unimplemented — so MTProto auth fails
 * with "[unenv] crypto.createHash is not implemented yet!".
 *
 * Instead we run gramjs here in Node (where crypto/Buffer are native and
 * everything just works) and expose it to the browser over a tiny WebSocket
 * RPC. The browser UI is unchanged; only webapp/js/telegram.js was swapped to
 * be a thin RPC client of this bridge.
 *
 * The same server also serves the static webapp, so there is a single origin
 * (no CORS) and you just open http://localhost:8080.
 *
 * RUN:
 *   cd server
 *   npm install
 *   npm start
 *   # then open http://localhost:8080
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { computeCheck } = require("telegram/Password");

// ---- Telegram app credentials (from the original userbot) -----------------
const API_ID = Number(process.env.TG_API_ID || 36319482);
const API_HASH = process.env.TG_API_HASH || "ed3143bea8b6df50b5ae7191dfaae1cf";
const PORT = Number(process.env.PORT || 8123);
const WEBAPP_DIR = path.join(__dirname, "..", "webapp");

// ---- Per-account gramjs client registry ------------------------------------
// accountId -> { client, me, entities: Map<tgId, entity> }
const managers = new Map();
const sockets = new Set();

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

/* ============================ Static file server ============================ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const httpServer = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let filePath = path.join(WEBAPP_DIR, urlPath === "/" ? "/index.html" : urlPath);
    // prevent path traversal
    if (!filePath.startsWith(WEBAPP_DIR)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        // SPA fallback
        filePath = path.join(WEBAPP_DIR, "index.html");
      }
      fs.readFile(filePath, (e, data) => {
        if (e) {
          res.writeHead(404);
          return res.end("Not found");
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        res.end(data);
      });
    });
  } catch (e) {
    res.writeHead(500);
    res.end("Server error");
  }
});

/* ================================ Mapping ================================== */
function idToStr(v) {
  if (v == null) return "";
  if (typeof v === "object" && "value" in v) return String(v.value);
  return String(v);
}

function peerToId(peer) {
  if (!peer) return "";
  return idToStr(
    peer.userId ?? peer.channelId ?? peer.chatId ?? peer.value ?? peer
  );
}

function dialogToChat(accountId, dialog) {
  const entity = dialog.entity || {};
  let type = "dm";
  if (entity.className === "Channel") type = entity.megagroup ? "group" : "channel";
  else if (entity.className === "Chat") type = "group";
  else if (entity.className === "User") type = entity.self ? "saved" : "dm";

  const title =
    dialog.title ||
    [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
    entity.username ||
    "Unknown";

  const tgId = idToStr(entity.id ?? dialog.id);

  return {
    id: `${accountId}:${tgId}`,
    accountId,
    telegramChatId: tgId,
    title,
    type,
    username: entity.username || null,
    lastMessage: (dialog.message && dialog.message.message) || "",
    lastMessageDate: dialog.message && dialog.message.date ? dialog.message.date * 1000 : 0,
    unreadCount: dialog.unreadCount || 0,
    isPinned: !!dialog.pinned,
    isArchived: !!dialog.archived,
    isMuted: !!(dialog.dialog && dialog.dialog.notifySettings && dialog.dialog.notifySettings.muteUntil),
    folderId: null,
    aiEnabled: true,
    customPrompt: null,
    ignoreUntil: 0,
    online: entity.status && entity.status.className === "UserStatusOnline",
  };
}

async function mapMessage(accountId, msg) {
  const tgChatId = peerToId(msg.peerId);
  let senderName = "Unknown";
  let senderId = null;
  try {
    const sender = await msg.getSender();
    if (sender) {
      senderId = idToStr(sender.id);
      senderName =
        [sender.firstName, sender.lastName].filter(Boolean).join(" ") ||
        sender.username ||
        "Unknown";
    }
  } catch (_) {}

  return {
    id: `${accountId}:${tgChatId}:${msg.id}`,
    accountId,
    chatId: `${accountId}:${tgChatId}`,
    telegramMsgId: msg.id,
    senderId,
    senderName,
    text: msg.message || "",
    timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
    isOutgoing: !!msg.out,
    isAiGenerated: false,
    replyToMsgId: (msg.replyTo && msg.replyTo.replyToMsgId) || null,
    mediaType: msg.media ? msg.media.className : null,
    mediaData: null,
    status: msg.out ? "sent" : "received",
  };
}

/* ============================ gramjs operations ============================ */
function getManager(accountId) {
  return managers.get(accountId);
}

function createClient(sessionStr) {
  const client = new TelegramClient(new StringSession(sessionStr || ""), API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS: true,
  });
  client.setLogLevel("error");
  return client;
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function attachHandlers(accountId, mgr) {
  if (mgr._handlersAttached) return;
  mgr._handlersAttached = true;
  mgr.client.addEventHandler(async (event) => {
    try {
      const mapped = await mapMessage(accountId, event.message);
      broadcast({ type: "event", event: "message", accountId, payload: mapped });
    } catch (e) {
      log("message handler error", e.message);
    }
  }, new NewMessage({}));
}

function emitConnection(accountId, status, extra) {
  broadcast({ type: "event", event: "connection", accountId, payload: { accountId, status, ...(extra || {}) } });
}

async function resolveEntity(mgr, telegramChatId) {
  if (mgr.entities && mgr.entities.has(telegramChatId)) {
    return mgr.entities.get(telegramChatId);
  }
  const ref = /^-?\d+$/.test(String(telegramChatId)) ? BigInt(telegramChatId) : telegramChatId;
  const entity = await mgr.client.getEntity(ref);
  if (mgr.entities) mgr.entities.set(telegramChatId, entity);
  return entity;
}

const RPC = {
  async startLogin({ accountId, phone }) {
    let mgr = managers.get(accountId);
    if (!mgr) {
      mgr = { client: createClient(""), me: null, entities: new Map() };
      managers.set(accountId, mgr);
    }
    emitConnection(accountId, "connecting");
    await mgr.client.connect();
    const result = await mgr.client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    return { phoneCodeHash: result.phoneCodeHash, phone };
  },

  async completeLogin({ accountId, phone, phoneCodeHash, code, password }) {
    const mgr = managers.get(accountId);
    if (!mgr) throw new Error("No login in progress for this account");
    try {
      await mgr.client.invoke(
        new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code })
      );
    } catch (err) {
      const m = String(err && (err.errorMessage || err.message || err));
      if (m.includes("SESSION_PASSWORD_NEEDED")) {
        if (!password) {
          const e = new Error("2FA_REQUIRED");
          e.code = "2FA_REQUIRED";
          throw e;
        }
        const pwdInfo = await mgr.client.invoke(new Api.account.GetPassword());
        const check = await computeCheck(pwdInfo, password);
        await mgr.client.invoke(new Api.auth.CheckPassword({ password: check }));
      } else {
        throw err;
      }
    }
    const me = await mgr.client.getMe();
    mgr.me = serializeMe(me);
    const stringSession = mgr.client.session.save();
    attachHandlers(accountId, mgr);
    emitConnection(accountId, "connected");
    return { me: mgr.me, stringSession };
  },

  async connect({ accountId, stringSession }) {
    let mgr = managers.get(accountId);
    if (!mgr) {
      mgr = { client: createClient(stringSession), me: null, entities: new Map() };
      managers.set(accountId, mgr);
    }
    emitConnection(accountId, "connecting");
    await mgr.client.connect();
    const authed = await mgr.client.isUserAuthorized();
    if (!authed) {
      emitConnection(accountId, "disconnected", { reason: "unauthorized" });
      return { ok: false };
    }
    const me = await mgr.client.getMe();
    mgr.me = serializeMe(me);
    attachHandlers(accountId, mgr);
    emitConnection(accountId, "connected");
    return { ok: true, me: mgr.me };
  },

  async disconnect({ accountId }) {
    const mgr = managers.get(accountId);
    if (mgr) {
      try { await mgr.client.disconnect(); } catch (_) {}
      managers.delete(accountId);
    }
    emitConnection(accountId, "disconnected");
    return { ok: true };
  },

  async getDialogs({ accountId, limit = 120 }) {
    const mgr = managers.get(accountId);
    if (!mgr) throw new Error("Not connected");
    const dialogs = await mgr.client.getDialogs({ limit });
    const out = [];
    for (const d of dialogs) {
      const chat = dialogToChat(accountId, d);
      if (d.entity) mgr.entities.set(chat.telegramChatId, d.entity);
      out.push(chat);
    }
    return out;
  },

  async getMessages({ accountId, chatId, limit = 50, offsetId = 0 }) {
    const mgr = managers.get(accountId);
    if (!mgr) throw new Error("Not connected");
    const entity = await resolveEntity(mgr, chatId);
    const messages = await mgr.client.getMessages(entity, { limit, offsetId });
    const out = [];
    for (const m of messages) out.push(await mapMessage(accountId, m));
    return out.reverse();
  },

  async sendMessage({ accountId, chatId, text, replyTo }) {
    const mgr = managers.get(accountId);
    if (!mgr) throw new Error("Not connected");
    const entity = await resolveEntity(mgr, chatId);
    const sent = await mgr.client.sendMessage(entity, {
      message: text,
      replyTo: replyTo || undefined,
    });
    return mapMessage(accountId, sent);
  },

  async setTyping({ accountId, chatId, typing }) {
    const mgr = managers.get(accountId);
    if (!mgr) return { ok: false };
    try {
      const entity = await resolveEntity(mgr, chatId);
      await mgr.client.invoke(
        new Api.messages.SetTyping({
          peer: entity,
          action: typing ? new Api.SendMessageTypingAction() : new Api.SendMessageCancelAction(),
        })
      );
    } catch (_) {}
    return { ok: true };
  },

  async markRead({ accountId, chatId }) {
    const mgr = managers.get(accountId);
    if (!mgr) return { ok: false };
    try {
      const entity = await resolveEntity(mgr, chatId);
      await mgr.client.markAsRead(entity);
    } catch (_) {}
    return { ok: true };
  },
};

function serializeMe(me) {
  if (!me) return null;
  return {
    id: idToStr(me.id),
    firstName: me.firstName || "",
    lastName: me.lastName || "",
    username: me.username || "",
    phone: me.phone || "",
  };
}

/* ================================ WS server ================================ */
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  sockets.add(ws);
  log("client connected, total:", sockets.size);

  // tell the client which accounts are already live on the server
  for (const [accountId, mgr] of managers) {
    if (mgr.me) emitConnection(accountId, "connected");
  }

  ws.on("message", async (raw) => {
    let req;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (req.type !== "rpc") return;
    const { id, method, args } = req;
    const fn = RPC[method];
    if (!fn) {
      ws.send(JSON.stringify({ type: "rpc-result", id, ok: false, error: `Unknown method ${method}` }));
      return;
    }
    try {
      const result = await fn(args || {});
      ws.send(JSON.stringify({ type: "rpc-result", id, ok: true, result }));
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "rpc-result",
          id,
          ok: false,
          error: String(err && (err.errorMessage || err.message || err)),
          code: err && err.code,
        })
      );
    }
  });

  ws.on("close", () => {
    sockets.delete(ws);
    log("client disconnected, total:", sockets.size);
  });
});

httpServer.listen(PORT, () => {
  log(`Telegram AI Userbot bridge running:`);
  log(`  → open http://localhost:${PORT} in your browser`);
  log(`  → serving webapp from ${WEBAPP_DIR}`);
});
