/**
 * Orchestration layer: bridges the data layer (db.js), the Telegram client
 * (telegram.js) and the AI engine (ai.js), and keeps the in-memory State /
 * event Bus in sync. The UI talks mostly to this module.
 */

import { DB, uid } from "./db.js";
import { Settings } from "./settings.js";
import { Bus, EV, State } from "./bus.js";
import { TelegramClientManager } from "./telegram.js";
import {
  shouldReply,
  generateReply,
  humanDelay,
  applyVariables,
} from "./ai.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_STYLE,
  DEFAULT_RULES,
  AI_DEFAULTS,
} from "./config.js";

/* ----------------------------- Accounts ----------------------------- */

export async function loadAccounts() {
  const accounts = await DB.getAll("accounts");
  State.accounts = accounts.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  State.activeAccountId =
    Settings.get("activeAccountId") || State.accounts[0]?.id || null;
  Bus.emit(EV.ACCOUNTS_CHANGED, State.accounts);
  return State.accounts;
}

export function newAccountTemplate(partial = {}) {
  return {
    id: uid("acc"),
    phoneNumber: "",
    firstName: "",
    lastName: "",
    username: "",
    stringSession: "",
    lastActive: Date.now(),
    isActive: true,
    aiSettings: {
      enabled: true,
      apiUrl: AI_DEFAULTS.apiUrl,
      apiKey: AI_DEFAULTS.apiKey,
      authStyle: AI_DEFAULTS.authStyle,
      model: AI_DEFAULTS.model,
      temperature: AI_DEFAULTS.temperature,
      maxTokens: AI_DEFAULTS.maxTokens,
      stream: true,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      style: { ...DEFAULT_STYLE },
      rules: { ...DEFAULT_RULES },
    },
    ...partial,
  };
}

export async function saveAccount(account) {
  await DB.put("accounts", account);
  const idx = State.accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) State.accounts[idx] = account;
  else State.accounts.push(account);
  Bus.emit(EV.ACCOUNTS_CHANGED, State.accounts);
  return account;
}

export async function removeAccount(accountId) {
  const mgr = State.clients.get(accountId);
  if (mgr) await mgr.disconnect();
  State.clients.delete(accountId);
  await DB.delete("accounts", accountId);
  await DB.deleteByIndex("chats", "accountId", accountId);
  await DB.deleteByIndex("messages", "accountId", accountId);
  await DB.deleteByIndex("templates", "accountId", accountId);
  await DB.deleteByIndex("ignoreList", "accountId", accountId);
  await DB.deleteByIndex("folders", "accountId", accountId);
  State.accounts = State.accounts.filter((a) => a.id !== accountId);
  if (State.activeAccountId === accountId) {
    State.activeAccountId = State.accounts[0]?.id || null;
    Settings.set("activeAccountId", State.activeAccountId);
  }
  Bus.emit(EV.ACCOUNTS_CHANGED, State.accounts);
}

/* ----------------------------- Clients ----------------------------- */

export function getClient(accountId) {
  return State.clients.get(accountId);
}

export async function ensureClient(account) {
  let mgr = State.clients.get(account.id);
  if (!mgr) {
    mgr = new TelegramClientManager(account);
    State.clients.set(account.id, mgr);
    mgr.onMessage((msg) => handleIncoming(account.id, msg));
  }
  return mgr;
}

export async function connectAccount(account) {
  const mgr = await ensureClient(account);
  if (mgr.status === "connected") return mgr;
  const ok = await mgr.connect();
  if (ok && mgr.me) {
    // refresh profile fields from the live session
    account.firstName = mgr.me.firstName || account.firstName;
    account.lastName = mgr.me.lastName || account.lastName;
    account.username = mgr.me.username || account.username;
    await saveAccount(account);
  }
  return mgr;
}

export async function connectAll() {
  for (const acc of State.accounts) {
    if (acc.stringSession) {
      connectAccount(acc).catch((e) => console.warn("connect failed", acc.id, e));
    }
  }
}

/* ------------------------- Account switching ------------------------ */

export async function switchAccount(accountId) {
  State.activeAccountId = accountId;
  State.activeChatId = null;
  Settings.set("activeAccountId", accountId);
  const account = State.activeAccount;
  if (!account) return;
  account.lastActive = Date.now();
  await DB.put("accounts", account);
  Bus.emit(EV.ACCOUNT_SWITCHED, account);
  await refreshChats();
}

/* ------------------------------ Chats ------------------------------ */

/** Merge live dialogs with stored per-chat settings (aiEnabled, folder, etc). */
export async function refreshChats() {
  const account = State.activeAccount;
  if (!account) return [];
  const stored = await DB.getByIndex("chats", "accountId", account.id);
  const storedMap = new Map(stored.map((c) => [c.id, c]));
  State.folders = await DB.getByIndex("folders", "accountId", account.id);

  let chats = stored;
  const mgr = State.clients.get(account.id);
  if (mgr && mgr.status === "connected") {
    try {
      const dialogs = await mgr.getDialogs(120);
      // preserve local-only fields from storedMap
      chats = dialogs.map((d) => {
        const prev = storedMap.get(d.id);
        const merged = {
          ...d,
          folderId: prev?.folderId ?? null,
          aiEnabled: prev?.aiEnabled ?? true,
          customPrompt: prev?.customPrompt ?? null,
          ignoreUntil: prev?.ignoreUntil ?? 0,
          isPinned: prev?.isPinned ?? d.isPinned,
          notify: prev?.notify ?? "all",
        };
        return merged;
      });
      await DB.putMany("chats", chats);
    } catch (e) {
      console.warn("getDialogs failed, using cached chats", e);
    }
  }

  chats.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return (b.lastMessageDate || 0) - (a.lastMessageDate || 0);
  });
  State.chats = chats;
  Bus.emit(EV.CHATS_CHANGED, chats);
  return chats;
}

export async function updateChat(chatId, patch) {
  const chat = State.chats.find((c) => c.id === chatId);
  if (!chat) return;
  Object.assign(chat, patch);
  await DB.put("chats", chat);
  Bus.emit(EV.CHATS_CHANGED, State.chats);
  return chat;
}

/* ----------------------------- Messages ----------------------------- */

export async function openChat(chatId) {
  State.activeChatId = chatId;
  const chat = State.activeChat;
  if (!chat) return;

  // local cache first
  let messages = await DB.getByIndex("messages", "chatId", chatId);
  messages.sort((a, b) => a.timestamp - b.timestamp);
  State.messages = messages;
  Bus.emit(EV.CHAT_OPENED, chat);
  Bus.emit(EV.MESSAGES_CHANGED, messages);

  // then live history
  const mgr = State.clients.get(chat.accountId);
  if (mgr && mgr.status === "connected") {
    try {
      const live = await mgr.getMessages(chat.telegramChatId, { limit: 50 });
      await DB.putMany("messages", live);
      const map = new Map(messages.map((m) => [m.id, m]));
      for (const m of live) map.set(m.id, m);
      State.messages = [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
      Bus.emit(EV.MESSAGES_CHANGED, State.messages);

      // mark read unless invisible mode (bonus #23)
      if (!Settings.get("invisibleMode")) {
        await mgr.markRead(chat.telegramChatId);
        await updateChat(chatId, { unreadCount: 0 });
      }
    } catch (e) {
      console.warn("getMessages failed", e);
    }
  }
  return State.messages;
}

export async function loadOlderMessages(chatId, oldestId) {
  const chat = State.chats.find((c) => c.id === chatId);
  const mgr = State.clients.get(chat?.accountId);
  if (!mgr || mgr.status !== "connected") return [];
  const older = await mgr.getMessages(chat.telegramChatId, {
    limit: 40,
    offsetId: oldestId,
  });
  await DB.putMany("messages", older);
  const map = new Map(older.map((m) => [m.id, m]));
  for (const m of State.messages) map.set(m.id, m);
  State.messages = [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
  Bus.emit(EV.MESSAGES_CHANGED, State.messages);
  return older;
}

export async function sendMessage(chatId, text, { replyTo = null, isAiGenerated = false } = {}) {
  const chat = State.chats.find((c) => c.id === chatId);
  if (!chat || !text.trim()) return;
  const mgr = State.clients.get(chat.accountId);

  // Template quick-insert (#9): a message of the form "/name" expands to the
  // stored template content for the active account.
  const tplMatch = text.trim().match(/^\/(\w+)$/);
  if (tplMatch) {
    const tpls = await DB.getByIndex("templates", "accountId", chat.accountId);
    const tpl = tpls.find((t) => t.name === tplMatch[1]);
    if (tpl) {
      text = applyVariables(tpl.content, { senderName: chat.title, chatName: chat.title });
      tpl.usageCount = (tpl.usageCount || 0) + 1;
      await DB.put("templates", tpl);
    }
  }

  const optimistic = {
    id: `${chat.accountId}:${chat.telegramChatId}:local_${Date.now()}`,
    accountId: chat.accountId,
    chatId,
    telegramMsgId: null,
    senderId: "me",
    senderName: "You",
    text,
    timestamp: Date.now(),
    isOutgoing: true,
    isAiGenerated,
    replyToMsgId: replyTo,
    status: "sending",
  };
  State.messages.push(optimistic);
  await DB.put("messages", optimistic);
  Bus.emit(EV.MESSAGES_CHANGED, State.messages);

  if (mgr && mgr.status === "connected") {
    try {
      const sent = await mgr.sendMessage(chat.telegramChatId, text, { replyTo });
      sent.isAiGenerated = isAiGenerated;
      sent.status = "sent";
      // replace optimistic
      State.messages = State.messages.filter((m) => m.id !== optimistic.id);
      State.messages.push(sent);
      await DB.delete("messages", optimistic.id);
      await DB.put("messages", sent);
    } catch (e) {
      optimistic.status = "failed";
      await DB.put("messages", optimistic);
    }
  }
  State.messages.sort((a, b) => a.timestamp - b.timestamp);
  await updateChat(chatId, { lastMessage: text, lastMessageDate: Date.now() });
  Bus.emit(EV.MESSAGES_CHANGED, State.messages);
  return optimistic;
}

/* --------------------- Incoming + AI auto-reply --------------------- */

async function handleIncoming(accountId, msg) {
  // persist
  await DB.put("messages", msg);

  // update chat list (last message + unread)
  let chat = State.chats.find((c) => c.id === msg.chatId);
  if (chat) {
    chat.lastMessage = msg.text || "[media]";
    chat.lastMessageDate = msg.timestamp;
    if (!msg.isOutgoing && State.activeChatId !== msg.chatId)
      chat.unreadCount = (chat.unreadCount || 0) + 1;
    await DB.put("chats", chat);
    Bus.emit(EV.CHATS_CHANGED, State.chats);
  } else {
    // unknown chat — refresh dialogs lazily
    refreshChats();
  }

  // live append if this chat is open
  if (State.activeChatId === msg.chatId) {
    State.messages.push(msg);
    State.messages.sort((a, b) => a.timestamp - b.timestamp);
    Bus.emit(EV.MESSAGES_CHANGED, State.messages);
  }

  // notification (#13) — handled by app layer listener
  if (!msg.isOutgoing) Bus.emit(EV.MESSAGE_NEW, { ...msg, _chat: chat });

  // ---- AI auto-reply pipeline ----
  await maybeAutoReply(accountId, msg, chat);
}

async function maybeAutoReply(accountId, msg, chat) {
  const account = State.accounts.find((a) => a.id === accountId);
  if (!account) return;
  const mgr = State.clients.get(accountId);
  const ignoreList = await DB.getByIndex("ignoreList", "accountId", accountId);
  const rules = account.aiSettings?.rules || DEFAULT_RULES;

  const decision = shouldReply({
    message: msg,
    chat,
    account,
    rules,
    ignoreList,
    myUsername: mgr?.me?.username,
    myId: mgr?.me?.id?.value ?? mgr?.me?.id,
  });

  if (!decision.triggered) {
    if (decision.reason && decision.reason !== "own-message")
      console.debug(`[ai] skip ${msg.chatId}: ${decision.reason}`);
    return;
  }

  // keyword template short-circuit (#8/#9)
  if (decision.reason === "keyword" && decision.templateText) {
    const text = applyVariables(decision.templateText, {
      userName: account.firstName,
      chatName: chat?.title,
      senderName: msg.senderName,
    });
    await delayThenSend(accountId, chat, text, msg, rules, true);
    return;
  }

  // build recent history context
  const history = (await DB.getByIndex("messages", "chatId", msg.chatId))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-12);

  const ctx = {
    userName: [account.firstName, account.lastName].filter(Boolean).join(" ") || "you",
    chatName: chat?.title || msg.senderName,
    senderName: msg.senderName,
    unreadCount: chat?.unreadCount || 0,
  };

  // human delay then typing indicator
  const delay = humanDelay(rules);
  await new Promise((r) => setTimeout(r, delay));
  Bus.emit(EV.TYPING, { chatId: msg.chatId, typing: true });
  if (mgr) mgr.setTyping(chat?.telegramChatId, true);

  try {
    const { text } = await generateReply({
      account,
      chat,
      history,
      ctx,
      onToken: () => {},
    });
    Bus.emit(EV.TYPING, { chatId: msg.chatId, typing: false });
    if (mgr) mgr.setTyping(chat?.telegramChatId, false);
    if (text) {
      await sendMessage(msg.chatId, text, {
        replyTo: chat?.type !== "dm" ? msg.telegramMsgId : null,
        isAiGenerated: true,
      });
      Bus.emit(EV.AI_REPLIED, { chatId: msg.chatId, text });
    }
  } catch (e) {
    Bus.emit(EV.TYPING, { chatId: msg.chatId, typing: false });
    if (mgr) mgr.setTyping(chat?.telegramChatId, false);
    Bus.emit(EV.TOAST, { message: `AI error: ${e.message}`, type: "error" });
  }
}

async function delayThenSend(accountId, chat, text, srcMsg, rules, isAi) {
  const mgr = State.clients.get(accountId);
  await new Promise((r) => setTimeout(r, humanDelay(rules)));
  Bus.emit(EV.TYPING, { chatId: chat.id, typing: true });
  if (mgr) mgr.setTyping(chat.telegramChatId, true);
  await new Promise((r) => setTimeout(r, 600));
  Bus.emit(EV.TYPING, { chatId: chat.id, typing: false });
  if (mgr) mgr.setTyping(chat.telegramChatId, false);
  await sendMessage(chat.id, text, {
    replyTo: chat.type !== "dm" ? srcMsg.telegramMsgId : null,
    isAiGenerated: isAi,
  });
}

/* --------------------- Scheduled messages (#17) --------------------- */

let schedulerTimer = null;
export function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(processScheduled, 30000);
  processScheduled();
}

async function processScheduled() {
  const all = await DB.getAll("scheduledMessages");
  const due = all.filter((s) => s.status === "pending" && s.scheduledAt <= Date.now());
  for (const s of due) {
    try {
      await sendMessage(s.chatId, s.text);
      s.status = "sent";
    } catch {
      s.status = "failed";
    }
    await DB.put("scheduledMessages", s);
  }
  if (due.length) Bus.emit(EV.TOAST, { message: `Sent ${due.length} scheduled message(s)`, type: "success" });
}
