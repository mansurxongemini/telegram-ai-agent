/**
 * Telegram MTProto client manager (feature #1 multi-account, #3 real-time
 * messaging, #18 connection health).
 *
 * Uses gramjs (the npm package "telegram") loaded in the browser via the import
 * map in index.html. Each account gets its own TelegramClientManager instance
 * which owns a TelegramClient + StringSession.
 *
 * gramjs automatically uses WebSocket transport in the browser build.
 */

import { TelegramClient, Api, sessions } from "telegram";
import { TELEGRAM } from "./config.js";
import { Bus, EV } from "./bus.js";

// Pull StringSession from the SAME bundle as TelegramClient. Importing it from
// a separate "telegram/sessions" esm.sh bundle yields a different class
// identity, which makes gramjs reject it with
// "Only StringSession and StoreSessions are supported currently".
const { StringSession } = sessions;

/** Map a gramjs dialog/entity to our chat data model. */
function dialogToChat(accountId, dialog) {
  const entity = dialog.entity || {};
  let type = "dm";
  if (entity.className === "Channel") {
    type = entity.megagroup ? "group" : "channel";
  } else if (entity.className === "Chat") {
    type = "group";
  } else if (entity.className === "User") {
    type = entity.self ? "saved" : "dm";
  }

  const title =
    dialog.title ||
    [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
    entity.username ||
    "Unknown";

  const tgId = String(
    entity.id?.value ?? entity.id ?? dialog.id?.value ?? dialog.id ?? ""
  );

  return {
    id: `${accountId}:${tgId}`,
    accountId,
    telegramChatId: tgId,
    title,
    type,
    username: entity.username || null,
    lastMessage: dialog.message?.message || "",
    lastMessageDate: dialog.message?.date ? dialog.message.date * 1000 : 0,
    unreadCount: dialog.unreadCount || 0,
    isPinned: !!dialog.pinned,
    isArchived: dialog.archived || false,
    isMuted: !!dialog.dialog?.notifySettings?.muteUntil,
    folderId: null,
    aiEnabled: true,
    customPrompt: null,
    ignoreUntil: 0,
    online: entity.status?.className === "UserStatusOnline",
  };
}

export class TelegramClientManager {
  constructor(account) {
    this.account = account; // {id, stringSession, ...}
    this.client = null;
    this.me = null;
    this.status = "disconnected";
    this.reconnects = 0;
    this.ping = null;
    this._messageHandlers = new Set();
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

  /** Create the gramjs client (does not connect yet). */
  _createClient(sessionStr = "") {
    const session = new StringSession(sessionStr || "");
    this.client = new TelegramClient(
      session,
      TELEGRAM.apiId,
      TELEGRAM.apiHash,
      {
        connectionRetries: TELEGRAM.connection.connectionRetries,
        retryDelay: TELEGRAM.connection.retryDelay,
        autoReconnect: TELEGRAM.connection.autoReconnect,
        useWSS: TELEGRAM.connection.useWSS,
      }
    );
    return this.client;
  }

  /**
   * Step 1 of login: send the confirmation code to the phone number.
   * Returns { phoneCodeHash } needed for signIn.
   */
  async startLogin(phoneNumber) {
    this._setStatus("connecting");
    this._createClient("");
    await this.client.connect();
    const result = await this.client.sendCode(
      { apiId: TELEGRAM.apiId, apiHash: TELEGRAM.apiHash },
      phoneNumber
    );
    return { phoneCodeHash: result.phoneCodeHash, phoneNumber };
  }

  /**
   * Step 2: complete sign-in with the SMS/app code, and optional 2FA password.
   * `needPassword` callback returns the 2FA password when Telegram requests it.
   */
  async completeLogin({ phoneNumber, phoneCodeHash, code, password }) {
    try {
      await this.client.invoke(
        new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: code })
      );
    } catch (err) {
      // SESSION_PASSWORD_NEEDED → 2FA required
      if (String(err?.errorMessage || err).includes("SESSION_PASSWORD_NEEDED")) {
        if (!password) {
          const e = new Error("2FA_REQUIRED");
          e.code = "2FA_REQUIRED";
          throw e;
        }
        // gramjs helper handles SRP password math
        await this.client.signInWithPassword(
          { apiId: TELEGRAM.apiId, apiHash: TELEGRAM.apiHash },
          {
            password: async () => password,
            onError: (e) => {
              throw e;
            },
          }
        );
      } else {
        throw err;
      }
    }

    this.me = await this.client.getMe();
    const stringSession = this.client.session.save();
    this._setStatus("connected");
    this._attachHandlers();
    return { me: this.me, stringSession };
  }

  /** Reconnect using a stored StringSession (auto-reconnect on page load). */
  async connect() {
    if (!this.account.stringSession) return false;
    this._setStatus("connecting");
    this._createClient(this.account.stringSession);
    try {
      await this.client.connect();
      const authed = await this.client.isUserAuthorized();
      if (!authed) {
        this._setStatus("disconnected", { reason: "unauthorized" });
        return false;
      }
      this.me = await this.client.getMe();
      this._setStatus("connected");
      this._attachHandlers();
      this._startPing();
      return true;
    } catch (err) {
      this.reconnects++;
      this._setStatus("disconnected", { error: String(err) });
      return false;
    }
  }

  async disconnect() {
    try {
      await this.client?.disconnect();
    } catch {}
    this._setStatus("disconnected");
  }

  /** Latency probe (feature #18 ping display). */
  _startPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    const probe = async () => {
      if (!this.client || this.status !== "connected") return;
      const t0 = performance.now();
      try {
        await this.client.invoke(new Api.Ping({ pingId: BigInt(Date.now()) }));
        this.ping = Math.round(performance.now() - t0);
        this._setStatus("connected");
      } catch {
        this.reconnects++;
        this._setStatus("connecting");
      }
    };
    this._pingTimer = setInterval(probe, 15000);
    probe();
  }

  /** Subscribe to incoming new messages. Returns an unsubscribe fn. */
  onMessage(fn) {
    this._messageHandlers.add(fn);
    return () => this._messageHandlers.delete(fn);
  }

  _attachHandlers() {
    if (this._handlersAttached) return;
    this._handlersAttached = true;
    // Import events from the SAME "telegram" bundle (see StringSession note above)
    // so the NewMessage builder is compatible with this client instance.
    import("telegram").then(({ events }) => {
      const { NewMessage } = events;
      this.client.addEventHandler(async (event) => {
        const msg = event.message;
        const mapped = await this._mapMessage(msg);
        for (const fn of this._messageHandlers) {
          try {
            await fn(mapped, event);
          } catch (e) {
            console.error("[telegram] message handler error", e);
          }
        }
        Bus.emit(EV.MESSAGE_NEW, mapped);
      }, new NewMessage({}));
    });
  }

  async _mapMessage(msg) {
    const accountId = this.account.id;
    const chatIdRaw = msg.chatId ?? msg.peerId;
    const tgChatId = String(
      chatIdRaw?.value ??
        chatIdRaw?.userId?.value ??
        chatIdRaw?.channelId?.value ??
        chatIdRaw?.chatId?.value ??
        chatIdRaw ??
        ""
    );
    let senderName = "Unknown";
    let senderId = null;
    try {
      const sender = await msg.getSender?.();
      if (sender) {
        senderId = String(sender.id?.value ?? sender.id ?? "");
        senderName =
          [sender.firstName, sender.lastName].filter(Boolean).join(" ") ||
          sender.username ||
          "Unknown";
      }
    } catch {}

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
      replyToMsgId: msg.replyTo?.replyToMsgId || null,
      mediaType: msg.media ? msg.media.className : null,
      mediaData: null,
      status: msg.out ? "sent" : "received",
    };
  }

  /** Fetch dialogs (chat list). */
  async getDialogs(limit = 100) {
    const dialogs = await this.client.getDialogs({ limit });
    return dialogs.map((d) => dialogToChat(this.account.id, d));
  }

  /** Fetch message history for a chat (pagination via offsetId). */
  async getMessages(telegramChatId, { limit = 40, offsetId = 0 } = {}) {
    const entity = await this.client.getEntity(
      isNaN(Number(telegramChatId)) ? telegramChatId : BigInt(telegramChatId)
    );
    const messages = await this.client.getMessages(entity, { limit, offsetId });
    const out = [];
    for (const m of messages) out.push(await this._mapMessage(m));
    return out.reverse(); // oldest first
  }

  /** Send a text message (feature #3). Supports reply. */
  async sendMessage(telegramChatId, text, { replyTo = null } = {}) {
    const entity = await this.client.getEntity(
      isNaN(Number(telegramChatId)) ? telegramChatId : BigInt(telegramChatId)
    );
    const sent = await this.client.sendMessage(entity, {
      message: text,
      replyTo: replyTo || undefined,
    });
    return this._mapMessage(sent);
  }

  /** Show "typing..." in a chat (feature #4). */
  async setTyping(telegramChatId, typing = true) {
    try {
      const entity = await this.client.getEntity(
        isNaN(Number(telegramChatId)) ? telegramChatId : BigInt(telegramChatId)
      );
      await this.client.invoke(
        new Api.messages.SetTyping({
          peer: entity,
          action: typing
            ? new Api.SendMessageTypingAction()
            : new Api.SendMessageCancelAction(),
        })
      );
    } catch {}
  }

  /** Mark a chat as read (skipped in invisible mode — bonus #23). */
  async markRead(telegramChatId) {
    try {
      const entity = await this.client.getEntity(
        isNaN(Number(telegramChatId)) ? telegramChatId : BigInt(telegramChatId)
      );
      await this.client.markAsRead(entity);
    } catch {}
  }
}
