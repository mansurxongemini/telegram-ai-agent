/**
 * Left side of the app: account rail (#1 switcher) + chat list sidebar
 * (#2 chat list, search, folders, pin/mute/AI indicators, #14 menu entry).
 */

import { el, mount, clear, avatarStyle, initials, fmtChatTime, esc } from "./dom.js";
import { Bus, EV, State } from "../bus.js";
import { Settings } from "../settings.js";
import {
  switchAccount,
  removeAccount,
  updateChat,
} from "../service.js";
import { openLoginFlow } from "./login.js";
import { confirmDialog, toast } from "./modals.js";

export function renderRail(container) {
  const rail = el("div.rail");

  for (const acc of State.accounts) {
    const conn = State.connection.get(acc.id) || {};
    const dotColor =
      conn.status === "connected" ? "#4dcd5e" : conn.status === "connecting" ? "#e0a93d" : "#d24c4c";
    const avatar = el(
      `div.rail-account${acc.id === State.activeAccountId ? ".active" : ""}`,
      {
        style: { background: avatarStyle(acc.id) },
        title: `${acc.firstName || acc.username || acc.phoneNumber}`,
        onclick: () => switchAccount(acc.id),
        oncontextmenu: (e) => {
          e.preventDefault();
          accountMenu(acc);
        },
      },
      [
        initials(`${acc.firstName} ${acc.lastName}`.trim() || acc.username || "?"),
        el("span.status-dot", { style: { background: dotColor } }),
      ]
    );
    rail.append(avatar);
  }

  rail.append(
    el("div.rail-add", { text: "+", title: "Add account (Ctrl+N)", onclick: () => openLoginFlow() })
  );
  rail.append(el("div.rail-spacer"));
  rail.append(
    el("div.rail-btn", { html: "📊", title: "AI Analytics", onclick: () => Bus.emit(EV.OPEN_MODAL, "analytics") }),
    el("div.rail-btn", { html: "⚙️", title: "Settings", onclick: () => Bus.emit(EV.OPEN_MODAL, "settings") })
  );

  mount(container, rail);
}

async function accountMenu(acc) {
  const ok = await confirmDialog({
    title: "Remove account",
    message: `Remove ${acc.firstName || acc.phoneNumber}? This deletes its local session, chats and messages from this browser.`,
    confirmText: "Remove",
    danger: true,
  });
  if (ok) {
    await removeAccount(acc.id);
    toast("Account removed", "success");
  }
}

export function renderSidebar(container) {
  const account = State.activeAccount;

  const searchInput = el("input", {
    type: "text",
    placeholder: "Search",
    value: State.searchQuery,
    oninput: (e) => {
      State.searchQuery = e.target.value;
      renderChatList(listEl);
    },
  });

  const header = el("div.sidebar-header", {}, [
    el("button.icon-btn", { html: "☰", title: "Menu", onclick: () => Bus.emit(EV.OPEN_MODAL, "menu") }),
    el("div.search-box", {}, [
      el("span.search-icon", { html: "🔍" }),
      searchInput,
    ]),
    el("button.icon-btn", { html: "🌐", title: "Global search (Ctrl+F)", onclick: () => Bus.emit(EV.OPEN_MODAL, "search") }),
  ]);

  const folderTabs = renderFolderTabs();
  const listEl = el("div.chatlist");

  const sidebar = el("div.sidebar", {}, [header, folderTabs, listEl]);
  mount(container, sidebar);
  renderChatList(listEl);

  // expose searchInput for keyboard focus
  container._searchInput = searchInput;
}

function renderFolderTabs() {
  const tabs = el("div.folder-tabs");
  const all = el(`div.folder-tab${!State.activeFolderId ? ".active" : ""}`, {
    text: "All",
    onclick: () => { State.activeFolderId = null; Bus.emit(EV.CHATS_CHANGED, State.chats); },
  });
  tabs.append(all);
  for (const f of State.folders) {
    tabs.append(
      el(`div.folder-tab${State.activeFolderId === f.id ? ".active" : ""}`, {
        onclick: () => { State.activeFolderId = f.id; Bus.emit(EV.CHATS_CHANGED, State.chats); },
      }, [`${f.icon || "📁"} ${f.name}`])
    );
  }
  tabs.append(
    el("div.folder-tab", { text: "+ Folder", style: { color: "var(--text-muted)" }, onclick: () => Bus.emit(EV.OPEN_MODAL, "folders") })
  );
  return tabs;
}

export function renderChatList(listEl) {
  clear(listEl);
  const q = State.searchQuery.trim().toLowerCase();

  let chats = State.chats.filter((c) => !c.isArchived);
  if (State.activeFolderId) chats = chats.filter((c) => c.folderId === State.activeFolderId);
  if (q) chats = chats.filter((c) => c.title.toLowerCase().includes(q) || (c.lastMessage || "").toLowerCase().includes(q));

  if (!State.activeAccount) {
    listEl.append(emptyHint("No account yet", "Click + on the left to log in."));
    return;
  }
  if (!chats.length) {
    listEl.append(emptyHint(q ? "No matches" : "No chats", q ? "Try another search." : "Chats appear once connected."));
    return;
  }

  const pinned = chats.filter((c) => c.isPinned);
  const rest = chats.filter((c) => !c.isPinned);

  if (pinned.length) {
    listEl.append(el("div.chatlist-section", { text: "Pinned" }));
    pinned.forEach((c) => listEl.append(chatItem(c)));
    if (rest.length) listEl.append(el("div.chatlist-section", { text: "Chats" }));
  }
  rest.forEach((c) => listEl.append(chatItem(c)));
}

function chatItem(c) {
  const icons = el("div.ci-icons");
  if (c.aiEnabled !== false) icons.append(el("span.ai-icon", { html: "🤖", title: "AI auto-reply on" }));
  if (c.isMuted) icons.append(el("span.mute-icon", { html: "🔇" }));
  if (c.isPinned) icons.append(el("span.pin-icon", { html: "📌" }));

  const badge = c.unreadCount > 0
    ? el(`span.badge${c.isMuted ? ".muted" : ""}`, { text: String(c.unreadCount) })
    : null;

  const item = el(
    `div.chatlist-item${c.id === State.activeChatId ? ".active" : ""}`,
    {
      onclick: () => Bus.emit(EV.CHAT_OPENED, c) || openChatFromList(c.id),
      oncontextmenu: (e) => { e.preventDefault(); chatContextMenu(c, e); },
    },
    [
      el("div.avatar", { style: { background: avatarStyle(c.id) } }, [
        c.type === "saved" ? "📌" : initials(c.title),
        c.online ? el("span.online-dot") : null,
      ]),
      el("div.ci-body", {}, [
        el("div.ci-top", {}, [
          el("div.ci-name", {}, [c.title]),
          el("div.ci-time", { text: fmtChatTime(c.lastMessageDate) }),
        ]),
        el("div.ci-bottom", {}, [
          el("div.ci-last", { text: c.lastMessage || "" }),
          badge || icons,
        ]),
      ]),
    ]
  );
  return item;
}

function openChatFromList(chatId) {
  Bus.emit(EV.SEARCH, null); // no-op to keep lints happy
  import("../service.js").then((s) => s.openChat(chatId));
}

async function chatContextMenu(c, e) {
  // lightweight popup via confirm-ish menu using a modal list
  const { openModal } = await import("./modals.js");
  const m = openModal({
    title: c.title,
    body: el("div", {}, [
      menuBtn(c.isPinned ? "Unpin" : "Pin to top", () => { updateChat(c.id, { isPinned: !c.isPinned }); m.close(); }),
      menuBtn(c.isMuted ? "Unmute" : "Mute", () => { updateChat(c.id, { isMuted: !c.isMuted }); m.close(); }),
      menuBtn(c.aiEnabled === false ? "Enable AI auto-reply" : "Disable AI auto-reply", () => { updateChat(c.id, { aiEnabled: c.aiEnabled === false }); m.close(); }),
      menuBtn(c.isArchived ? "Unarchive" : "Archive", () => { updateChat(c.id, { isArchived: !c.isArchived }); m.close(); }),
      menuBtn("Per-chat system prompt…", () => { m.close(); Bus.emit(EV.OPEN_MODAL, { name: "chatPrompt", chatId: c.id }); }),
      menuBtn("Move to folder…", () => { m.close(); Bus.emit(EV.OPEN_MODAL, { name: "folders", chatId: c.id }); }),
    ]),
  });
}

function menuBtn(label, onclick) {
  return el("button.btn", { text: label, style: { display: "block", width: "100%", textAlign: "left", marginBottom: "6px", background: "var(--field-bg)" }, onclick });
}

function emptyHint(title, sub) {
  return el("div", { style: { padding: "40px 20px", textAlign: "center", color: "var(--text-secondary)" } }, [
    el("div", { text: title, style: { fontWeight: "600", marginBottom: "4px" } }),
    el("div", { text: sub, style: { fontSize: "13px", color: "var(--text-muted)" } }),
  ]);
}
