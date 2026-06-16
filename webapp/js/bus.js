/**
 * Tiny pub/sub event bus + shared in-memory app state.
 * UI modules subscribe to events; data/telegram/ai modules emit them.
 */

const listeners = new Map();

export const Bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => Bus.off(event, fn);
  },
  off(event, fn) {
    listeners.get(event)?.delete(fn);
  },
  emit(event, payload) {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] listener error for "${event}"`, err);
      }
    });
  },
};

/**
 * Shared runtime state (not persisted directly — persistence lives in db.js).
 */
export const State = {
  accounts: [], // [{...account}]
  activeAccountId: null,
  activeChatId: null,
  chats: [], // chats for active account
  messages: [], // messages for active chat
  folders: [],
  clients: new Map(), // accountId -> TelegramClientManager instance
  connection: new Map(), // accountId -> { status, reconnects, ping }
  searchQuery: "",
  activeFolderId: null,

  get activeAccount() {
    return this.accounts.find((a) => a.id === this.activeAccountId) || null;
  },
  get activeChat() {
    return this.chats.find((c) => c.id === this.activeChatId) || null;
  },
};

/** Common event names (avoids typos). */
export const EV = {
  ACCOUNTS_CHANGED: "accounts:changed",
  ACCOUNT_SWITCHED: "account:switched",
  CHATS_CHANGED: "chats:changed",
  CHAT_OPENED: "chat:opened",
  MESSAGES_CHANGED: "messages:changed",
  MESSAGE_NEW: "message:new",
  CONNECTION: "connection:changed",
  TYPING: "typing",
  AI_REPLIED: "ai:replied",
  TOAST: "toast",
  OPEN_MODAL: "modal:open",
  CLOSE_MODAL: "modal:close",
  SETTINGS_CHANGED: "settings:changed",
  FOLDERS_CHANGED: "folders:changed",
  SEARCH: "search",
};
