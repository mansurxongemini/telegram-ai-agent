/**
 * Service Worker (feature #13: background notifications + offline shell cache,
 * plus a Periodic Background Sync hook for polling).
 *
 * Note: the MTProto WebSocket connection lives in the page (gramjs), so the
 * worker focuses on caching the app shell, showing notifications forwarded from
 * the page, and routing notification clicks back to the right chat.
 */

const CACHE = "tg-ai-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./css/telegram.css",
  "./js/app.js",
  "./js/config.js",
  "./js/db.js",
  "./js/bus.js",
  "./js/settings.js",
  "./js/service.js",
  "./js/telegram.js",
  "./js/ai.js",
  "./js/ui/dom.js",
  "./js/ui/modals.js",
  "./js/ui/sidebar.js",
  "./js/ui/chat.js",
  "./js/ui/panels.js",
  "./js/ui/login.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GETs; let CDN / Telegram traffic pass through.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// Page → SW: show a notification on its behalf.
self.addEventListener("message", (e) => {
  if (e.data?.type === "notify") {
    const { title, body, chatId } = e.data;
    self.registration.showNotification(title, {
      body,
      tag: chatId,
      data: { chatId },
      badge:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='50' fill='%232ea6ff'/%3E%3C/svg%3E",
    });
  }
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const chatId = e.notification.data?.chatId;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
      for (const c of cls) {
        c.focus();
        c.postMessage({ type: "focus-chat", chatId });
        return;
      }
      return self.clients.openWindow("./");
    })
  );
});

// Periodic Background Sync (best-effort; supported only in some browsers).
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "poll-messages") {
    e.waitUntil(
      self.clients.matchAll().then((cls) => cls.forEach((c) => c.postMessage({ type: "poll" })))
    );
  }
});
