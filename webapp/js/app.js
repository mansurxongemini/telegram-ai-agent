/**
 * Application entry point. Bootstraps the data layer, builds the Telegram-style
 * shell, wires the event bus to the UI, registers keyboard shortcuts (#16),
 * notifications (#13), the unread title counter, the scheduler (#17) and the
 * first-run wizard (#20).
 */

import { openDB, DB } from "./db.js";
import { Settings } from "./settings.js";
import { Bus, EV, State } from "./bus.js";
import {
  loadAccounts,
  connectAll,
  switchAccount,
  refreshChats,
  openChat,
  startScheduler,
  saveAccount,
} from "./service.js";
import { el, mount, $ } from "./ui/dom.js";
import { renderRail, renderSidebar, renderChatList } from "./ui/sidebar.js";
import { renderChat, renderMessages } from "./ui/chat.js";
import { openPanel, applyAppearance } from "./ui/panels.js";
import { openLoginFlow, openWelcomeWizard } from "./ui/login.js";
import { toast, closeTopModal } from "./ui/modals.js";

/* ----------------------------- Shell ----------------------------- */
function buildShell() {
  const root = document.getElementById("root");
  mount(
    root,
    el("div.app", { id: "app" }, [
      el("div", { id: "rail-slot" }),
      el("div", { id: "sidebar-slot" }),
      el("div", { id: "main-slot" }),
    ])
  );
}

function renderAll() {
  renderRail($("#rail-slot"));
  renderSidebar($("#sidebar-slot"));
  renderChat($("#main-slot"));
}

/* ----------------------------- Bus wiring ----------------------------- */
function wireBus() {
  Bus.on(EV.ACCOUNTS_CHANGED, () => {
    renderRail($("#rail-slot"));
  });

  Bus.on(EV.ACCOUNT_SWITCHED, () => {
    renderAll();
  });

  Bus.on(EV.CONNECTION, (info) => {
    State.connection.set(info.accountId, info);
    renderRail($("#rail-slot"));
    // refresh chats once a freshly connected account comes online
    if (info.status === "connected" && info.accountId === State.activeAccountId) {
      refreshChats();
    }
  });

  Bus.on(EV.CHATS_CHANGED, () => {
    const list = $("#sidebar-slot .chatlist");
    if (list) renderChatList(list);
    else renderSidebar($("#sidebar-slot"));
  });

  Bus.on(EV.FOLDERS_CHANGED, () => renderSidebar($("#sidebar-slot")));

  // opening a chat (clicked from list or jumped from search)
  Bus.on(EV.CHAT_OPENED, (chat) => {
    if (chat && chat.id && chat.id !== State.activeChatId) {
      openChat(chat.id);
    } else {
      renderChat($("#main-slot"));
      renderSidebar($("#sidebar-slot"));
    }
  });

  Bus.on(EV.MESSAGES_CHANGED, () => renderMessages());

  Bus.on(EV.MESSAGE_NEW, (msg) => {
    if (!msg.isOutgoing) notify(msg);
    updateTitle();
  });

  Bus.on(EV.TOAST, ({ message, type }) => toast(message, type));
  Bus.on(EV.OPEN_MODAL, (spec) => openPanel(spec));
  Bus.on(EV.CLOSE_MODAL, () => closeTopModal());
}

/* ----------------------------- Notifications (#13) ----------------------------- */
let audioCtx = null;
function beep() {
  if (!Settings.get("sound")) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.05, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
    o.start();
    o.stop(audioCtx.currentTime + 0.3);
  } catch {}
}

function dndActive() {
  const dnd = Settings.get("dnd") || {};
  if (dnd.manual) return true;
  if (!dnd.enabled) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = (dnd.from || "23:00").split(":").map(Number);
  const [th, tm] = (dnd.to || "07:00").split(":").map(Number);
  const s = fh * 60 + fm, e = th * 60 + tm;
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

function notify(msg) {
  if (dndActive()) return;
  beep();
  const chat = State.chats.find((c) => c.id === msg.chatId);
  if (chat?.notify === "none") return;
  if (chat?.notify === "mentions") {
    const mgr = State.clients.get(msg.accountId);
    const uname = mgr?.me?.username;
    if (!(uname && (msg.text || "").toLowerCase().includes(`@${uname.toLowerCase()}`))) return;
  }
  if (!Settings.get("notifications")) return;
  if (Notification.permission === "granted" && document.hidden) {
    try {
      new Notification(chat?.title || msg.senderName, {
        body: msg.text?.slice(0, 120) || "[media]",
        tag: msg.chatId,
      });
    } catch {}
  }
}

function updateTitle() {
  const total = State.chats.reduce((s, c) => s + (c.unreadCount || 0), 0);
  document.title = total > 0 ? `(${total}) Telegram AI Workspace` : "Telegram AI Userbot Workspace";
}
Bus.on(EV.CHATS_CHANGED, updateTitle);

/* ----------------------------- Keyboard shortcuts (#16) ----------------------------- */
function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

    if (e.key === "Escape") {
      if (closeTopModal()) return;
      if (State.searchQuery) {
        State.searchQuery = "";
        renderSidebar($("#sidebar-slot"));
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === "k") { e.preventDefault(); openQuickSwitch(); return; }
      if (e.key.toLowerCase() === "n") { e.preventDefault(); openLoginFlow(); return; }
      if (e.key.toLowerCase() === "f") { e.preventDefault(); openPanel("search"); return; }
      if (e.shiftKey && e.key.toLowerCase() === "a") { e.preventDefault(); toggleAccountAI(); return; }
      if (["1", "2", "3", "4", "5"].includes(e.key)) {
        const acc = State.accounts[parseInt(e.key, 10) - 1];
        if (acc) { e.preventDefault(); switchAccount(acc.id); }
        return;
      }
    }

    if (e.key === "?" && !typing) { e.preventDefault(); openPanel("shortcuts"); }
  });
}

async function toggleAccountAI() {
  const acc = State.activeAccount;
  if (!acc) return;
  acc.aiSettings.enabled = !acc.aiSettings.enabled;
  await saveAccount(acc);
  toast(`AI auto-reply ${acc.aiSettings.enabled ? "ON" : "OFF"} for ${acc.firstName || "account"}`, acc.aiSettings.enabled ? "success" : "info");
}

/* ----------------------------- Quick switcher (#16 Ctrl+K) ----------------------------- */
function openQuickSwitch() {
  if ($(".quick-switch")) return;
  const input = el("input", { type: "text", placeholder: "Jump to chat…" });
  const list = el("div.qs-list");
  const box = el("div.quick-switch", {}, [input, list]);
  const overlay = el("div.modal-overlay", { onclick: (e) => { if (e.target === overlay) close(); } }, [box]);
  document.getElementById("modal-root").append(overlay);
  setTimeout(() => input.focus(), 30);

  let active = 0;
  let filtered = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    filtered = State.chats.filter((c) => c.title.toLowerCase().includes(q)).slice(0, 20);
    mount(list, ...filtered.map((c, i) =>
      el(`div.qs-item${i === active ? ".active" : ""}`, { onclick: () => pick(c) }, [
        el("div.avatar.sm", { style: { background: "var(--accent)" } }, [c.title[0] || "?"]),
        el("div", { text: c.title }),
      ])
    ));
  };
  const pick = (c) => { close(); openChat(c.id); };
  const close = () => overlay.remove();
  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(active + 1, filtered.length - 1); render(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); }
    else if (e.key === "Enter" && filtered[active]) pick(filtered[active]);
    else if (e.key === "Escape") close();
  });
  render();
}

/* ----------------------------- Service Worker messaging ----------------------------- */
function wireServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "focus-chat" && e.data.chatId) openChat(e.data.chatId);
  });
}

/* ----------------------------- Bootstrap ----------------------------- */
async function boot() {
  applyAppearance();
  buildShell();
  wireBus();
  wireKeyboard();
  wireServiceWorker();

  try {
    await openDB();
  } catch (e) {
    toast("Failed to open local database", "error");
    console.error(e);
  }

  await loadAccounts();
  renderAll();
  updateTitle();

  // auto-reconnect saved sessions
  connectAll();
  startScheduler();

  // first-run wizard (#20)
  if (!Settings.get("setupComplete") && State.accounts.length === 0) {
    openWelcomeWizard(async ({ ai, style } = {}) => {
      // apply chosen defaults to the first account when it is created later
      if (State.activeAccount && ai) {
        Object.assign(State.activeAccount.aiSettings, {
          apiUrl: ai.apiUrl, apiKey: ai.apiKey, model: ai.model, style,
        });
        await saveAccount(State.activeAccount);
      }
      renderAll();
    });
  }

  // surface fatal errors as toasts
  window.addEventListener("unhandledrejection", (e) => {
    console.error("Unhandled:", e.reason);
  });
}

boot();
