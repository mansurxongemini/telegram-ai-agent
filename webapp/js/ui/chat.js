/**
 * Main chat area (features #3 messaging, #4 typing, #17 drafts/scheduled).
 * Renders header, message bubbles (status checks, replies, AI tag),
 * typing indicator and the input bar (emoji / attach / voice / send).
 */

import { el, mount, clear, avatarStyle, initials, fmtTime, fmtDay } from "./dom.js";
import { Bus, EV, State } from "../bus.js";
import { Settings } from "../settings.js";
import { sendMessage, loadOlderMessages, openChat } from "../service.js";
import { toast } from "./modals.js";
import { DB, uid } from "../db.js";

const EMOJIS = "😀 😁 😂 🤣 😊 😍 😘 😎 🤔 🙄 😴 😭 😱 👍 👎 👏 🙏 💪 🔥 ✨ 🎉 ❤️ 💙 💔 ✅ ❌ ⚡ 🚀 💯 🤝 👀 🥳 😅 😇 🤩 😏 🫡 🤙 👋 🙌".split(" ");

let replyTo = null; // {msgId, name, text}
let typingState = false;
let draftSaveTimer = null;

export function renderChat(container) {
  const chat = State.activeChat;
  if (!chat) {
    mount(container, el("div.main", {}, [
      el("div.empty-main", {}, [
        el("div", { html: "💬", style: { fontSize: "56px" } }),
        el("div.pill", { text: "Select a chat to start messaging" }),
      ]),
    ]));
    return;
  }

  const conn = State.connection.get(chat.accountId) || {};
  const statusText = chat.online ? "online" : conn.status === "connected" ? (chat.type === "dm" ? "last seen recently" : `${chat.type}`) : conn.status;

  const header = el("div.chat-header", {}, [
    el("button.icon-btn.mobile-back", { html: "←", onclick: () => { State.activeChatId = null; Bus.emit(EV.CHAT_OPENED, null); }, style: { display: "none" } }),
    el("div.avatar.sm", { style: { background: avatarStyle(chat.id) } }, [chat.type === "saved" ? "📌" : initials(chat.title)]),
    el("div.ch-info", {}, [
      el("div.ch-title", { text: chat.title }),
      el(`div.ch-status${chat.online ? ".online" : ""}`, { id: "ch-status", text: statusText }),
    ]),
    el("div.ch-actions", {}, [
      el("button.icon-btn", { html: "🔍", title: "Search in chat", onclick: () => Bus.emit(EV.OPEN_MODAL, { name: "search", chatId: chat.id }) }),
      el("button.icon-btn", { html: "🤖", title: "Toggle AI for this chat", onclick: () => toggleChatAI(chat) }),
      el("button.icon-btn", { html: "⋮", title: "Chat info", onclick: () => Bus.emit(EV.OPEN_MODAL, { name: "chatPrompt", chatId: chat.id }) }),
    ]),
  ]);

  const messagesEl = el("div.messages", { id: "messages" });
  const inputBar = renderInputBar(chat);
  const main = el("div.main", {}, [header, messagesEl, inputBar]);
  mount(container, main);

  // restore draft
  const draftKey = `draft:${chat.id}`;
  const draft = localStorage.getItem(draftKey);
  const input = main.querySelector(".msg-input");
  if (draft && input) input.value = draft;

  // lazy-load older on scroll up
  messagesEl.addEventListener("scroll", async () => {
    if (messagesEl.scrollTop < 60 && State.messages.length) {
      const oldest = State.messages[0];
      if (oldest?.telegramMsgId) {
        const prevH = messagesEl.scrollHeight;
        await loadOlderMessages(chat.id, oldest.telegramMsgId);
        messagesEl.scrollTop = messagesEl.scrollHeight - prevH;
      }
    }
  });

  renderMessages(messagesEl);
  // smooth switch transition (#design 300ms)
  messagesEl.classList.add("switching");
  requestAnimationFrame(() => requestAnimationFrame(() => messagesEl.classList.remove("switching")));
}

export function renderMessages(messagesEl) {
  if (!messagesEl) messagesEl = document.getElementById("messages");
  if (!messagesEl) return;
  clear(messagesEl);

  let lastDay = "";
  for (const m of State.messages) {
    const day = fmtDay(m.timestamp);
    if (day !== lastDay) {
      messagesEl.append(el("div.day-sep", { text: day }));
      lastDay = day;
    }
    messagesEl.append(bubble(m));
  }
  if (typingState) messagesEl.append(typingBubble());

  // autoscroll to bottom
  requestAnimationFrame(() => (messagesEl.scrollTop = messagesEl.scrollHeight));
}

function bubble(m) {
  const out = m.isOutgoing;
  const chat = State.activeChat;
  const showSender = !out && chat && chat.type !== "dm" && chat.type !== "saved";

  const meta = el("span.meta", {}, [fmtTime(m.timestamp)]);
  if (out) {
    let check = "✓";
    let cls = "check";
    if (m.status === "read") { check = "✓✓"; cls = "check read"; }
    else if (m.status === "sent" || m.status === "delivered") check = "✓✓";
    else if (m.status === "sending") check = "🕓";
    else if (m.status === "failed") check = "⚠️";
    meta.append(el(`span.${cls}`, { text: " " + check }));
  }

  const inner = [];
  if (showSender) inner.push(el("div.sender", { text: m.senderName }));

  if (m.replyToMsgId) {
    const ref = State.messages.find((x) => x.telegramMsgId === m.replyToMsgId);
    inner.push(el("div.reply-quote", {}, [
      el("div.rq-name", { text: ref?.senderName || "Reply" }),
      el("div", { text: (ref?.text || "").slice(0, 80) }),
    ]));
  }

  inner.push(document.createTextNode(m.text || ""));
  if (m.isAiGenerated) meta.append(el("span.ai-tag", { text: "AI" }));
  inner.push(meta);

  const bubbleEl = el("div.bubble", {}, inner);
  bubbleEl.addEventListener("dblclick", () => {
    replyTo = { msgId: m.telegramMsgId, name: m.senderName, text: m.text };
    showReplyBanner();
  });

  return el(`div.bubble-row.${out ? "out" : "in"}`, {}, [bubbleEl]);
}

function typingBubble() {
  return el("div.bubble-row.in", {}, [
    el("div.bubble", { style: { padding: "4px 8px" } }, [
      el("div.typing-indicator", {}, [el("span"), el("span"), el("span")]),
    ]),
  ]);
}

function renderInputBar(chat) {
  const input = el("textarea.msg-input", { rows: 1, placeholder: "Message" });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
    // autosave draft (#17)
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      const key = `draft:${chat.id}`;
      if (input.value.trim()) localStorage.setItem(key, input.value);
      else localStorage.removeItem(key);
    }, 400);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && Settings.get("sendOnEnter")) {
      e.preventDefault();
      doSend();
    }
  });

  const emojiBtn = el("button.icon-btn", { html: "😀", title: "Emoji" });
  let picker = null;
  emojiBtn.onclick = () => {
    if (picker) { picker.remove(); picker = null; return; }
    picker = el("div.emoji-picker", {}, EMOJIS.map((e) =>
      el("span", { text: e, onclick: () => { insertAtCursor(input, e); } })
    ));
    document.querySelector(".main").append(picker);
  };

  const attachBtn = el("button.icon-btn", { html: "📎", title: "Attach (demo)", onclick: () => toast("Attachments are visual-only in this demo build", "info") });
  const scheduleBtn = el("button.icon-btn", { html: "🕐", title: "Schedule message", onclick: () => scheduleCurrent(chat, input) });
  const voiceBtn = el("button.send-btn", { html: "🎤", title: "Voice (demo)", onclick: () => toast("Voice messages are visual-only in this demo build", "info") });
  const sendBtn = el("button.send-btn", { html: "➤", title: "Send", onclick: doSend });

  function updateSendButton() {
    const hasText = input.value.trim().length > 0;
    voiceBtn.style.display = hasText ? "none" : "flex";
    sendBtn.style.display = hasText ? "flex" : "none";
  }
  input.addEventListener("input", updateSendButton);

  async function doSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    input.style.height = "auto";
    localStorage.removeItem(`draft:${chat.id}`);
    updateSendButton();
    if (picker) { picker.remove(); picker = null; }
    const r = replyTo?.msgId || null;
    clearReply();
    await sendMessage(chat.id, text, { replyTo: r });
  }

  const bar = el("div.input-bar", {}, [
    el("div.input-wrap", {}, [emojiBtn, input, attachBtn, scheduleBtn]),
    voiceBtn,
    sendBtn,
  ]);
  setTimeout(updateSendButton, 0);
  return bar;
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.focus();
  input.selectionStart = input.selectionEnd = start + text.length;
  input.dispatchEvent(new Event("input"));
}

async function scheduleCurrent(chat, input) {
  const text = input.value.trim();
  if (!text) return toast("Type a message first", "error");
  const { promptDialog } = await import("./modals.js");
  const dt = await promptDialog({
    title: "Schedule message",
    label: "Send at",
    type: "datetime-local",
    value: new Date(Date.now() + 3600000).toISOString().slice(0, 16),
  });
  if (!dt) return;
  await DB.put("scheduledMessages", {
    id: uid("sch"),
    accountId: chat.accountId,
    chatId: chat.id,
    text,
    scheduledAt: new Date(dt).getTime(),
    status: "pending",
  });
  input.value = "";
  input.dispatchEvent(new Event("input"));
  toast("Message scheduled", "success");
}

/* reply banner */
function showReplyBanner() {
  clearReply(true);
  const main = document.querySelector(".main");
  const bar = main?.querySelector(".input-bar");
  if (!bar || !replyTo) return;
  const banner = el("div.reply-banner", { id: "reply-banner" }, [
    el("div", {}, [
      el("div", { text: `Reply to ${replyTo.name}`, style: { color: "var(--accent)", fontWeight: "600" } }),
      el("div", { text: (replyTo.text || "").slice(0, 60), style: { color: "var(--text-secondary)" } }),
    ]),
    el("button.icon-btn", { html: "✕", onclick: () => clearReply() }),
  ]);
  bar.before(banner);
}
function clearReply(keep = false) {
  document.getElementById("reply-banner")?.remove();
  if (!keep) replyTo = null;
}

async function toggleChatAI(chat) {
  const { updateChat } = await import("../service.js");
  await updateChat(chat.id, { aiEnabled: chat.aiEnabled === false });
  toast(`AI auto-reply ${chat.aiEnabled === false ? "enabled" : "disabled"} for this chat`, "success");
}

/* typing indicator handling */
Bus.on(EV.TYPING, ({ chatId, typing }) => {
  if (chatId !== State.activeChatId) return;
  typingState = typing;
  const status = document.getElementById("ch-status");
  if (status) status.textContent = typing ? "typing…" : (State.activeChat?.online ? "online" : "last seen recently");
  renderMessages();
});
