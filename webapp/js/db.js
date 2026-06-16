/**
 * IndexedDB data layer.
 *
 * Wraps the raw IndexedDB API in a small promise-based helper and exposes a
 * typed-ish CRUD surface for every store described in the spec:
 *   accounts, chats, messages, settings, templates, ignoreList,
 *   scheduledMessages, folders, promptTemplates, analytics.
 *
 * Everything is stored locally in the browser — there is no backend.
 */

import { APP } from "./config.js";

let _dbPromise = null;

/** Open (and upgrade) the database, returning a cached promise. */
export function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(APP.dbName, APP.dbVersion);

    req.onupgradeneeded = (e) => {
      const db = req.result;
      const tx = e.target.transaction;

      const ensure = (name, opts, indexes = []) => {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, opts);
        } else {
          store = tx.objectStore(name);
        }
        for (const idx of indexes) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.keyPath, idx.options || {});
          }
        }
        return store;
      };

      // accounts: one Telegram account (StringSession + AI config)
      ensure("accounts", { keyPath: "id" }, [
        { name: "phoneNumber", keyPath: "phoneNumber" },
      ]);

      // chats: dialogs per account
      ensure("chats", { keyPath: "id" }, [
        { name: "accountId", keyPath: "accountId" },
        { name: "telegramChatId", keyPath: "telegramChatId" },
        { name: "folderId", keyPath: "folderId" },
      ]);

      // messages: per account+chat
      ensure("messages", { keyPath: "id" }, [
        { name: "accountId", keyPath: "accountId" },
        { name: "chatId", keyPath: "chatId" },
        { name: "timestamp", keyPath: "timestamp" },
        { name: "chat_ts", keyPath: ["chatId", "timestamp"] },
      ]);

      // settings: generic key/value (app + per-account)
      ensure("settings", { keyPath: "id" }, [
        { name: "key", keyPath: "key" },
      ]);

      // templates: reusable canned responses
      ensure("templates", { keyPath: "id" }, [
        { name: "accountId", keyPath: "accountId" },
        { name: "category", keyPath: "category" },
      ]);

      // ignoreList: users/chats the AI must never answer
      ensure("ignoreList", { keyPath: "id" }, [
        { name: "accountId", keyPath: "accountId" },
        { name: "userId", keyPath: "userId" },
      ]);

      // scheduledMessages: queued outgoing messages
      ensure("scheduledMessages", { keyPath: "id" }, [
        { name: "accountId", keyPath: "accountId" },
        { name: "scheduledAt", keyPath: "scheduledAt" },
        { name: "status", keyPath: "status" },
      ]);

      // folders: chat organisation
      ensure("folders", { keyPath: "id" }, [
        { name: "accountId", keyPath: "accountId" },
      ]);

      // promptTemplates: saved system-prompt presets
      ensure("promptTemplates", { keyPath: "id" }, [
        { name: "accountId", keyPath: "accountId" },
      ]);

      // analytics: per-account AI activity log entries
      ensure("analytics", { keyPath: "id" }, [
        { name: "accountId", keyPath: "accountId" },
        { name: "timestamp", keyPath: "timestamp" },
      ]);
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return _dbPromise;
}

/** Run a transaction and resolve when it completes. */
async function tx(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    result = fn(t);
  });
}

const reqToPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Generic CRUD operations against any store. */
export const DB = {
  async put(store, value) {
    await tx(store, "readwrite", (t) => t.objectStore(store).put(value));
    return value;
  },

  async putMany(store, values) {
    await tx(store, "readwrite", (t) => {
      const os = t.objectStore(store);
      for (const v of values) os.put(v);
    });
    return values;
  },

  async get(store, key) {
    const db = await openDB();
    return reqToPromise(db.transaction(store).objectStore(store).get(key));
  },

  async getAll(store) {
    const db = await openDB();
    return reqToPromise(db.transaction(store).objectStore(store).getAll());
  },

  /** Query by an index value, e.g. all chats for an accountId. */
  async getByIndex(store, indexName, value) {
    const db = await openDB();
    const idx = db.transaction(store).objectStore(store).index(indexName);
    return reqToPromise(idx.getAll(value));
  },

  async delete(store, key) {
    await tx(store, "readwrite", (t) => t.objectStore(store).delete(key));
  },

  /** Delete all rows in a store matching an index value. */
  async deleteByIndex(store, indexName, value) {
    await tx(store, "readwrite", (t) => {
      const idx = t.objectStore(store).index(indexName);
      const cursorReq = idx.openCursor(IDBKeyRange.only(value));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
  },

  async clear(store) {
    await tx(store, "readwrite", (t) => t.objectStore(store).clear());
  },

  async count(store) {
    const db = await openDB();
    return reqToPromise(db.transaction(store).objectStore(store).count());
  },

  /** Approximate storage usage via the Storage API (feature #11). */
  async estimateUsage() {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    }
    return { usage: 0, quota: 0 };
  },
};

/** Small id helper. */
export const uid = (prefix = "id") =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
