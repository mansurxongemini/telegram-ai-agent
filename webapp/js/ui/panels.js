/**
 * Feature panels / modals. A single router (openPanel) dispatches to each
 * feature implementation. Covers features #5,6,7,8,9,10,11,12,13,14,15,16,19
 * plus per-chat prompt and the hamburger menu.
 */

import { el, mount, clear, fmtBytes, avatarStyle, initials, esc } from "./dom.js";
import { openModal, toast, field, select, toggle, confirmDialog, promptDialog, tabbedBody } from "./modals.js";
import { Bus, EV, State } from "../bus.js";
import { Settings } from "../settings.js";
import { DB, uid } from "../db.js";
import { saveAccount, updateChat, refreshChats, openChat } from "../service.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_STYLE,
  DEFAULT_RULES,
  ACCENT_COLORS,
  FOLDER_ICONS,
  AI_DEFAULTS,
} from "../config.js";
import { applyVariables } from "../ai.js";

const PROMPT_VARS = ["user_name", "chat_name", "sender_name", "time", "date", "unread_count"];

export function openPanel(spec) {
  const name = typeof spec === "string" ? spec : spec.name;
  const ctx = typeof spec === "string" ? {} : spec;
  const map = {
    menu: panelMenu,
    settings: panelSettings,
    prompt: panelPrompt,
    style: panelStyle,
    ignore: panelIgnore,
    triggers: panelTriggers,
    templates: panelTemplates,
    folders: (c) => panelFolders(c),
    analytics: panelAnalytics,
    search: (c) => panelSearch(c),
    notifications: panelNotifications,
    theme: panelTheme,
    shortcuts: panelShortcuts,
    scheduled: panelScheduled,
    data: panelData,
    backup: panelBackup,
    chatPrompt: (c) => panelChatPrompt(c),
    health: panelHealth,
  };
  (map[name] || (() => toast(`Unknown panel: ${name}`, "error")))(ctx);
}

/* ----------------------------- Menu ----------------------------- */
function panelMenu() {
  const items = [
    ["🤖", "AI Settings", "settings"],
    ["📝", "System Prompt", "prompt"],
    ["✍️", "Writing Style", "style"],
    ["🚫", "Ignore List", "ignore"],
    ["⚡", "Triggers & Filters", "triggers"],
    ["💬", "Templates", "templates"],
    ["📁", "Folders", "folders"],
    ["📊", "AI Analytics", "analytics"],
    ["🔔", "Notifications", "notifications"],
    ["🎨", "Appearance", "theme"],
    ["🕐", "Scheduled Messages", "scheduled"],
    ["💾", "Data & Storage", "data"],
    ["📦", "Import / Export", "backup"],
    ["📶", "Account Health", "health"],
    ["⌨️", "Keyboard Shortcuts", "shortcuts"],
  ];
  const m = openModal({
    title: "Menu",
    body: el("div", {}, items.map(([icon, label, panel]) =>
      el("button.btn", {
        style: { display: "flex", gap: "12px", width: "100%", textAlign: "left", marginBottom: "6px", background: "var(--field-bg)" },
        onclick: () => { m.close(); openPanel(panel); },
      }, [el("span", { text: icon }), el("span", { text: label })])
    )),
  });
}

/* -------------------------- AI Settings -------------------------- */
function panelSettings() {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const ai = acc.aiSettings;

  const enabled = toggle(ai.enabled, (v) => (ai.enabled = v));
  const url = el("input", { type: "text", value: ai.apiUrl });
  const key = el("input", { type: "password", value: ai.apiKey });
  const authStyle = select([
    { value: "x-authorization", label: "X-Authorization (AutoGLM)" },
    { value: "authorization", label: "Authorization (OpenAI)" },
  ], ai.authStyle || "x-authorization", (v) => (ai.authStyle = v));
  const model = el("input", { type: "text", value: ai.model });
  const temp = el("input", { type: "number", step: "0.1", min: "0", max: "2", value: ai.temperature });
  const maxTok = el("input", { type: "number", value: ai.maxTokens });
  const stream = toggle(ai.stream !== false, (v) => (ai.stream = v));

  const m = openModal({
    title: "AI Settings",
    body: el("div", {}, [
      el("div.toggle-row", {}, [el("div", {}, [el("div.tr-label", { text: "AI auto-reply (this account)" }), el("div.tr-sub", { text: "Master switch — Ctrl+Shift+A" })]), enabled]),
      field("API endpoint", url),
      field("API key / token", key),
      field("Auth header style", authStyle),
      el("div.row", {}, [field("Model", model), field("Temperature", temp)]),
      el("div.row", {}, [field("Max tokens", maxTok), el("div.field", {}, [el("label", { text: "Streaming (SSE)" }), stream])]),
      el("button.btn.ghost", { text: "Test connection", onclick: () => testAI(ai) }),
    ]),
    footer: [
      el("button.btn", { text: "Cancel", onclick: () => m.close() }),
      el("button.btn.primary", { text: "Save", onclick: async () => {
        ai.apiUrl = url.value; ai.apiKey = key.value; ai.model = model.value;
        ai.temperature = parseFloat(temp.value); ai.maxTokens = parseInt(maxTok.value, 10);
        await saveAccount(acc);
        toast("AI settings saved", "success");
        m.close();
      } }),
    ],
  });
}

async function testAI(ai) {
  toast("Testing AI endpoint…");
  try {
    const { streamCompletion } = await import("../ai.js");
    let out = "";
    await streamCompletion({
      aiCfg: ai,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      onToken: (t) => (out += t),
    });
    toast(`AI responded: ${out.slice(0, 40) || "(empty)"}`, "success");
  } catch (e) {
    toast(`AI test failed: ${e.message}`, "error");
  }
}

/* ------------------- System Prompt Editor (#5) ------------------- */
async function panelPrompt() {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const ai = acc.aiSettings;
  const presets = await DB.getByIndex("promptTemplates", "accountId", acc.id);

  const textarea = el("textarea", { spellcheck: false }, [ai.systemPrompt || DEFAULT_SYSTEM_PROMPT]);
  const editor = el("div.code-editor", {}, [textarea]);

  const varChips = el("div", { style: { margin: "8px 0" } },
    PROMPT_VARS.map((v) => el("span.var-chip", {
      text: `{{${v}}}`,
      onclick: () => {
        const s = textarea.selectionStart;
        const val = textarea.value;
        textarea.value = val.slice(0, s) + `{{${v}}}` + val.slice(textarea.selectionEnd);
        textarea.focus();
      },
    }))
  );

  const presetSelect = select(
    [{ value: "", label: "— Saved templates —" }, ...presets.map((p) => ({ value: p.id, label: p.name }))],
    "",
    (id) => { const p = presets.find((x) => x.id === id); if (p) textarea.value = p.content; }
  );

  const preview = el("div", { style: { background: "var(--field-bg)", borderRadius: "8px", padding: "10px", fontSize: "13px", color: "var(--text-secondary)", whiteSpace: "pre-wrap", maxHeight: "120px", overflow: "auto" } });
  const refreshPreview = () => {
    preview.textContent = applyVariables(textarea.value, {
      userName: acc.firstName, chatName: "Example Chat", senderName: "Alex", unreadCount: 3,
    });
  };
  textarea.addEventListener("input", refreshPreview);
  refreshPreview();

  const m = openModal({
    title: "System Prompt Editor",
    wide: true,
    body: el("div", {}, [
      el("div.row", {}, [el("div.field", { style: { flex: "2" } }, [el("label", { text: "Template" }), presetSelect]),
        el("div.field", {}, [el("label", { text: " " }), el("button.btn", { text: "Save as template", onclick: () => saveAsTemplate() })])]),
      el("label", { text: "Prompt (supports variables)", style: { fontSize: "13px", color: "var(--text-secondary)" } }),
      editor,
      varChips,
      el("label", { text: "Live preview", style: { fontSize: "13px", color: "var(--text-secondary)" } }),
      preview,
    ]),
    footer: [
      el("button.btn", { text: "Reset default", onclick: () => { textarea.value = DEFAULT_SYSTEM_PROMPT; refreshPreview(); } }),
      el("button.btn.primary", { text: "Save", onclick: async () => {
        ai.systemPrompt = textarea.value;
        await saveAccount(acc);
        toast("System prompt saved", "success");
        m.close();
      } }),
    ],
  });

  async function saveAsTemplate() {
    const name = await promptDialog({ title: "Template name", label: "Name", placeholder: "e.g. Business persona" });
    if (!name) return;
    await DB.put("promptTemplates", { id: uid("pt"), accountId: acc.id, name, content: textarea.value });
    toast("Template saved", "success");
  }
}

/* --------------------- Writing Style (#6) --------------------- */
function panelStyle() {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const style = acc.aiSettings.style || { ...DEFAULT_STYLE };

  const tone = select(opts("formal,casual,friendly,professional,witty"), style.tone, (v) => (style.tone = v));
  const lang = select([
    { value: "auto", label: "Auto-detect" }, { value: "en", label: "English" },
    { value: "ru", label: "Russian" }, { value: "uz", label: "Uzbek" },
  ], style.language, (v) => (style.language = v));
  const length = select([
    { value: "short", label: "Short (1-2 sentences)" }, { value: "medium", label: "Medium" },
    { value: "long", label: "Long" }, { value: "auto", label: "Auto" },
  ], style.length, (v) => (style.length = v));
  const emoji = select(opts("none,minimal,normal,lots"), style.emoji, (v) => (style.emoji = v));
  const format = select([
    { value: "plain", label: "Plain text" }, { value: "markdown", label: "Markdown" }, { value: "html", label: "HTML" },
  ], style.format, (v) => (style.format = v));
  const signature = el("input", { type: "text", value: style.signature || "", placeholder: "e.g. — sent from my AI" });

  const m = openModal({
    title: "Writing Style",
    body: el("div", {}, [
      el("div.row", {}, [field("Tone", tone), field("Language", lang)]),
      el("div.row", {}, [field("Message length", length), field("Emoji usage", emoji)]),
      field("Response format", format),
      field("Custom signature (optional)", signature),
    ]),
    footer: [el("button.btn.primary", { text: "Save", onclick: async () => {
      style.signature = signature.value;
      acc.aiSettings.style = style;
      await saveAccount(acc);
      toast("Writing style saved", "success");
      m.close();
    } })],
  });
}

/* --------------------- Ignore List (#7) --------------------- */
async function panelIgnore() {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const listEl = el("div");
  const render = async () => {
    const items = await DB.getByIndex("ignoreList", "accountId", acc.id);
    clear(listEl);
    if (!items.length) listEl.append(el("div.hint", { text: "No ignored users. Add someone by Telegram user ID." }));
    for (const it of items) {
      const expired = it.expiresAt && it.expiresAt < Date.now();
      listEl.append(el("div.list-row", {}, [
        el("div.avatar.sm", { style: { background: avatarStyle(it.userId) } }, [initials(it.userFirstName || it.userId)]),
        el("div.lr-body", {}, [
          el("div.lr-title", { text: it.userFirstName || it.userId }),
          el("div.lr-sub", { text: it.expiresAt ? (expired ? "expired" : `until ${new Date(it.expiresAt).toLocaleString()}`) : (it.reason || "permanent") }),
        ]),
        el("button.icon-btn", { html: "🗑", onclick: async () => { await DB.delete("ignoreList", it.id); render(); } }),
      ]));
    }
  };
  const idInput = el("input", { type: "text", placeholder: "Telegram user/chat ID" });
  const nameInput = el("input", { type: "text", placeholder: "Display name (optional)" });
  const hoursInput = el("input", { type: "number", placeholder: "Hours (blank = permanent)" });

  const m = openModal({
    title: "Ignore & Block List",
    body: el("div", {}, [
      el("div.row", {}, [field("User/Chat ID", idInput), field("Name", nameInput)]),
      el("div.row", {}, [field("Temporary mute (hours)", hoursInput),
        el("div.field", {}, [el("label", { text: " " }), el("button.btn.primary", { text: "Add", onclick: async () => {
          if (!idInput.value.trim()) return;
          const hours = parseFloat(hoursInput.value);
          await DB.put("ignoreList", {
            id: uid("ig"), accountId: acc.id, userId: idInput.value.trim(),
            userFirstName: nameInput.value.trim(), reason: "manual",
            addedAt: Date.now(), expiresAt: hours ? Date.now() + hours * 3600000 : null,
          });
          idInput.value = nameInput.value = hoursInput.value = "";
          render();
        } })]),
      ]),
      el("hr", { style: { border: "none", borderTop: "1px solid var(--divider)", margin: "8px 0" } }),
      listEl,
    ]),
    footer: [
      el("button.btn", { text: "Export", onclick: async () => exportJSON(await DB.getByIndex("ignoreList", "accountId", acc.id), "ignore-list.json") }),
      el("button.btn", { text: "Import", onclick: () => importJSON(async (data) => { for (const it of data) { it.accountId = acc.id; it.id = it.id || uid("ig"); await DB.put("ignoreList", it); } render(); toast("Imported", "success"); }) }),
    ],
  });
  render();
}

/* --------------------- Triggers & Filters (#8) --------------------- */
function panelTriggers() {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const rules = acc.aiSettings.rules || { ...DEFAULT_RULES };

  const quietOn = toggle(rules.quietHours?.enabled, (v) => (rules.quietHours.enabled = v));
  const from = el("input", { type: "time", value: rules.quietHours?.from || "23:00" });
  const to = el("input", { type: "time", value: rules.quietHours?.to || "07:00" });
  const skipMedia = toggle(rules.skipMediaOnly, (v) => (rules.skipMediaOnly = v));
  const groupMention = toggle(rules.groupRequireMention, (v) => (rules.groupRequireMention = v));
  const delayMin = el("input", { type: "number", value: rules.responseDelay?.min ?? 1000 });
  const delayMax = el("input", { type: "number", value: rules.responseDelay?.max ?? 3000 });

  const kwWrap = el("div");
  const renderKw = () => {
    clear(kwWrap);
    (rules.keywordTriggers || []).forEach((kt, i) => {
      kwWrap.append(el("div.list-row", {}, [
        el("div.lr-body", {}, [el("div.lr-title", { text: `"${kt.keyword}"` }), el("div.lr-sub", { text: (kt.text || "").slice(0, 60) })]),
        el("button.icon-btn", { html: "🗑", onclick: () => { rules.keywordTriggers.splice(i, 1); renderKw(); } }),
      ]));
    });
  };
  const kwKey = el("input", { type: "text", placeholder: "keyword" });
  const kwText = el("input", { type: "text", placeholder: "auto-response template" });

  const m = openModal({
    title: "Triggers & Filters",
    wide: true,
    body: el("div", {}, [
      el("div.toggle-row", {}, [el("div", {}, [el("div.tr-label", { text: "Quiet hours" }), el("div.tr-sub", { text: "Do not auto-reply during this window" })]), quietOn]),
      el("div.row", {}, [field("From", from), field("To", to)]),
      el("div.toggle-row", {}, [el("div.tr-label", { text: "Skip media-only messages" }), skipMedia]),
      el("div.toggle-row", {}, [el("div.tr-label", { text: "Groups: only reply when mentioned / replied to" }), groupMention]),
      el("div.row", {}, [field("Response delay min (ms)", delayMin), field("Response delay max (ms)", delayMax)]),
      el("label", { text: "Keyword triggers", style: { fontSize: "13px", color: "var(--text-secondary)" } }),
      kwWrap,
      el("div.row", {}, [field("Keyword", kwKey), field("Response", kwText),
        el("div.field", {}, [el("label", { text: " " }), el("button.btn.primary", { text: "Add", onclick: () => {
          if (!kwKey.value.trim()) return;
          rules.keywordTriggers = rules.keywordTriggers || [];
          rules.keywordTriggers.push({ keyword: kwKey.value.trim(), text: kwText.value.trim() });
          kwKey.value = kwText.value = ""; renderKw();
        } })])]),
    ]),
    footer: [el("button.btn.primary", { text: "Save", onclick: async () => {
      rules.quietHours = { enabled: rules.quietHours?.enabled, from: from.value, to: to.value };
      rules.responseDelay = { min: parseInt(delayMin.value, 10), max: parseInt(delayMax.value, 10) };
      acc.aiSettings.rules = rules;
      await saveAccount(acc);
      toast("Rules saved", "success");
      m.close();
    } })],
  });
  renderKw();
}

/* --------------------- Templates (#9) --------------------- */
async function panelTemplates() {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const listEl = el("div");
  const render = async () => {
    const items = await DB.getByIndex("templates", "accountId", acc.id);
    clear(listEl);
    if (!items.length) listEl.append(el("div.hint", { text: "No templates yet. Insert them in chat with /name." }));
    for (const t of items) {
      listEl.append(el("div.list-row", {}, [
        el("div.lr-body", {}, [el("div.lr-title", { text: `/${t.name} · ${t.category}` }), el("div.lr-sub", { text: (t.content || "").slice(0, 70) })]),
        el("button.icon-btn", { html: "🗑", onclick: async () => { await DB.delete("templates", t.id); render(); } }),
      ]));
    }
  };
  const name = el("input", { type: "text", placeholder: "shortcut name (no spaces)" });
  const category = select(opts("greetings,farewells,business,casual,custom"), "custom", () => {});
  const content = el("textarea", { placeholder: "Template content. Variables: {{sender_name}}, {{time}}, {{date}}" });

  const m = openModal({
    title: "Message Templates",
    body: el("div", {}, [
      el("div.row", {}, [field("Name", name), field("Category", category)]),
      field("Content", content),
      el("button.btn.primary", { text: "Add template", onclick: async () => {
        if (!name.value.trim()) return;
        await DB.put("templates", { id: uid("tpl"), accountId: acc.id, name: name.value.trim().replace(/\s+/g, "_"), category: category.value, content: content.value, usageCount: 0 });
        name.value = content.value = ""; render();
      } }),
      el("hr", { style: { border: "none", borderTop: "1px solid var(--divider)", margin: "12px 0" } }),
      listEl,
    ]),
  });
  render();
}

/* --------------------- Folders (#10) --------------------- */
async function panelFolders(ctx = {}) {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const listEl = el("div");

  const render = async () => {
    State.folders = await DB.getByIndex("folders", "accountId", acc.id);
    clear(listEl);
    for (const f of State.folders) {
      const chatCount = State.chats.filter((c) => c.folderId === f.id).length;
      listEl.append(el("div.list-row", {}, [
        el("div", { text: f.icon || "📁", style: { fontSize: "22px" } }),
        el("div.lr-body", {}, [el("div.lr-title", { text: f.name }), el("div.lr-sub", { text: `${chatCount} chats` })]),
        el("button.icon-btn", { html: "🗑", onclick: async () => { await DB.delete("folders", f.id); for (const c of State.chats) if (c.folderId === f.id) await updateChat(c.id, { folderId: null }); render(); Bus.emit(EV.FOLDERS_CHANGED); } }),
      ]));
    }
  };

  const fname = el("input", { type: "text", placeholder: "Folder name" });
  let chosenIcon = FOLDER_ICONS[0];
  const iconRow = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
    FOLDER_ICONS.map((ic) => {
      const b = el("button.btn", { text: ic, style: { padding: "6px 10px" }, onclick: () => { chosenIcon = ic; [...iconRow.children].forEach((c) => (c.style.outline = "")); b.style.outline = "2px solid var(--accent)"; } });
      return b;
    })
  );

  // If invoked with a chatId, show "move to folder" buttons.
  const moveSection = ctx.chatId ? el("div", {}, [
    el("label", { text: "Move chat to folder", style: { fontSize: "13px", color: "var(--text-secondary)" } }),
    el("div", { id: "move-row" }),
  ]) : null;

  const m = openModal({
    title: "Chat Folders",
    body: el("div", {}, [
      field("New folder", fname),
      el("label", { text: "Icon", style: { fontSize: "13px", color: "var(--text-secondary)" } }),
      iconRow,
      el("button.btn.primary", { text: "Create folder", style: { marginTop: "10px" }, onclick: async () => {
        if (!fname.value.trim()) return;
        await DB.put("folders", { id: uid("fld"), accountId: acc.id, name: fname.value.trim(), icon: chosenIcon, color: "#2ea6ff" });
        fname.value = ""; render(); renderMove(); Bus.emit(EV.FOLDERS_CHANGED);
      } }),
      el("hr", { style: { border: "none", borderTop: "1px solid var(--divider)", margin: "12px 0" } }),
      listEl,
      moveSection,
    ]),
  });

  async function renderMove() {
    if (!ctx.chatId) return;
    const row = m.el.querySelector("#move-row");
    if (!row) return;
    clear(row);
    row.style.display = "flex";
    row.style.flexWrap = "wrap";
    row.style.gap = "6px";
    row.append(el("button.btn", { text: "None", onclick: async () => { await updateChat(ctx.chatId, { folderId: null }); toast("Removed from folder", "success"); } }));
    for (const f of State.folders) {
      row.append(el("button.btn", { text: `${f.icon} ${f.name}`, onclick: async () => { await updateChat(ctx.chatId, { folderId: f.id }); toast(`Moved to ${f.name}`, "success"); } }));
    }
  }
  await render();
  renderMove();
}

/* --------------------- Analytics (#14) --------------------- */
async function panelAnalytics() {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const all = await DB.getByIndex("analytics", "accountId", acc.id);
  const now = Date.now();
  const dayAgo = now - 86400000;
  const weekAgo = now - 7 * 86400000;
  const today = all.filter((a) => a.timestamp >= dayAgo);
  const week = all.filter((a) => a.timestamp >= weekAgo);
  const avg = all.length ? Math.round(all.reduce((s, a) => s + (a.responseTimeMs || 0), 0) / all.length) : 0;
  const tokens = all.reduce((s, a) => s + (a.tokensEstimate || 0), 0);

  // top chats
  const byChat = {};
  for (const a of all) byChat[a.chatId] = (byChat[a.chatId] || 0) + 1;
  const topChats = Object.entries(byChat).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([cid, n]) => [State.chats.find((c) => c.id === cid)?.title || "Unknown", n]);

  // last 7 days bar chart
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - (6 - i) * 86400000);
    const start = new Date(d).setHours(0, 0, 0, 0);
    const end = start + 86400000;
    const count = all.filter((a) => a.timestamp >= start && a.timestamp < end).length;
    return { label: d.toLocaleDateString([], { weekday: "short" }), count };
  });
  const maxDay = Math.max(1, ...days.map((d) => d.count));

  openModal({
    title: "AI Analytics",
    wide: true,
    body: el("div", {}, [
      el("div.stat-grid", {}, [
        statCard(today.length, "Replies today"),
        statCard(week.length, "Replies this week"),
        statCard(all.length, "Total AI replies"),
        statCard(`${avg} ms`, "Avg response time"),
        statCard(tokens.toLocaleString(), "Est. tokens used"),
        statCard(State.chats.filter((c) => c.aiEnabled !== false).length, "AI-enabled chats"),
      ]),
      el("label", { text: "Replies — last 7 days", style: { fontSize: "13px", color: "var(--text-secondary)" } }),
      el("div.bar-chart", {}, days.map((d) =>
        el("div.bar", { style: { height: `${(d.count / maxDay) * 100}%` }, title: `${d.count}` }, [el("div.bar-label", { text: d.label })])
      )),
      el("label", { text: "Most active chats", style: { fontSize: "13px", color: "var(--text-secondary)", display: "block", marginTop: "24px" } }),
      el("div", {}, topChats.length ? topChats.map(([name, n]) =>
        el("div.list-row", {}, [el("div.lr-body", {}, [el("div.lr-title", { text: name })]), el("span.badge", { text: String(n) })])
      ) : [el("div.hint", { text: "No AI activity yet." })]),
    ]),
  });
}
function statCard(value, label) {
  return el("div.stat-card", {}, [el("div.sc-value", { text: String(value) }), el("div.sc-label", { text: label })]);
}

/* --------------------- Global Search (#12) --------------------- */
async function panelSearch(ctx = {}) {
  const input = el("input", { type: "text", placeholder: "Search messages across all chats…" });
  const scope = select([
    { value: "all", label: "All accounts" },
    { value: "account", label: "This account" },
    ...(ctx.chatId ? [{ value: "chat", label: "This chat" }] : []),
  ], ctx.chatId ? "chat" : "all", () => run());
  const results = el("div");

  const run = async () => {
    const q = input.value.trim().toLowerCase();
    clear(results);
    if (q.length < 2) return;
    let msgs = await DB.getAll("messages");
    if (scope.value === "account") msgs = msgs.filter((m) => m.accountId === State.activeAccountId);
    if (scope.value === "chat") msgs = msgs.filter((m) => m.chatId === ctx.chatId);
    const hits = msgs.filter((m) => (m.text || "").toLowerCase().includes(q)).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
    if (!hits.length) { results.append(el("div.hint", { text: "No results" })); return; }
    for (const h of hits) {
      const chat = State.chats.find((c) => c.id === h.chatId);
      results.append(el("div.list-row", { style: { cursor: "pointer" }, onclick: () => { m.close(); jumpTo(h.chatId); } }, [
        el("div.avatar.sm", { style: { background: avatarStyle(h.chatId) } }, [initials(chat?.title || "?")]),
        el("div.lr-body", {}, [
          el("div.lr-title", { text: chat?.title || h.senderName }),
          el("div.lr-sub", { html: highlight(h.text, q) }),
        ]),
        el("div.ci-time", { text: new Date(h.timestamp).toLocaleDateString() }),
      ]));
    }
  };

  input.addEventListener("input", run);
  const m = openModal({
    title: "Search",
    wide: true,
    body: el("div", {}, [el("div.row", {}, [field("Query", input), field("Scope", scope)]), results]),
  });
  setTimeout(() => input.focus(), 50);
  run();
}
function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text.slice(0, 80));
  const start = Math.max(0, i - 20);
  return esc(text.slice(start, i)) + "<mark style='background:var(--accent);color:#fff;border-radius:3px'>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length, i + q.length + 40));
}
async function jumpTo(chatId) {
  await openChat(chatId);
}

/* --------------------- Notifications (#13) --------------------- */
function panelNotifications() {
  const s = Settings.all();
  const notif = toggle(s.notifications, (v) => Settings.set("notifications", v));
  const sound = toggle(s.sound, (v) => Settings.set("sound", v));
  const dnd = toggle(s.dnd?.manual, (v) => Settings.patch({ dnd: { ...s.dnd, manual: v } }));
  const dndSched = toggle(s.dnd?.enabled, (v) => Settings.patch({ dnd: { ...Settings.get("dnd"), enabled: v } }));
  const from = el("input", { type: "time", value: s.dnd?.from || "23:00" });
  const to = el("input", { type: "time", value: s.dnd?.to || "07:00" });

  openModal({
    title: "Notifications",
    body: el("div", {}, [
      el("div.toggle-row", {}, [el("div.tr-label", { text: "Browser notifications" }), notif]),
      el("div.toggle-row", {}, [el("div.tr-label", { text: "Sound on new message" }), sound]),
      el("div.toggle-row", {}, [el("div", {}, [el("div.tr-label", { text: "Do Not Disturb (manual)" }), el("div.tr-sub", { text: "Mute all notifications now" })]), dnd]),
      el("div.toggle-row", {}, [el("div.tr-label", { text: "Scheduled Do Not Disturb" }), dndSched]),
      el("div.row", {}, [field("DND from", from), field("DND to", to)]),
      el("button.btn.ghost", { text: "Request notification permission", onclick: async () => {
        const p = await Notification.requestPermission();
        toast(`Permission: ${p}`, p === "granted" ? "success" : "info");
      } }),
    ]),
    footer: [el("button.btn.primary", { text: "Save", onclick: () => { Settings.patch({ dnd: { ...Settings.get("dnd"), from: from.value, to: to.value } }); toast("Saved", "success"); Bus.emit(EV.CLOSE_MODAL); } })],
  });
}

/* --------------------- Appearance (#15) --------------------- */
function panelTheme() {
  const s = Settings.all();
  const themeSel = select([{ value: "dark", label: "Dark (Telegram)" }, { value: "light", label: "Light" }], s.theme, (v) => { Settings.set("theme", v); applyAppearance(); });
  const fontSel = select(opts("small,medium,large"), s.fontSize, (v) => { Settings.set("fontSize", v); applyAppearance(); });
  const bubbleSel = select([{ value: "rounded", label: "Rounded" }, { value: "square", label: "Square" }, { value: "custom", label: "Custom radius" }], s.bubbleStyle, (v) => { Settings.set("bubbleStyle", v); applyAppearance(); });
  const radius = el("input", { type: "number", value: s.bubbleRadius, oninput: (e) => { Settings.set("bubbleRadius", parseInt(e.target.value, 10) || 12); applyAppearance(); } });
  const compact = toggle(s.compact, (v) => { Settings.set("compact", v); applyAppearance(); });

  const accentRow = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
    ACCENT_COLORS.map((c) => el("button", {
      style: { width: "32px", height: "32px", borderRadius: "50%", background: c, outline: s.accent === c ? "3px solid var(--text)" : "none" },
      onclick: () => { Settings.set("accent", c); applyAppearance(); panelClose(); panelTheme(); },
    }))
  );

  let modalRef;
  function panelClose() { modalRef?.close(); }
  modalRef = openModal({
    title: "Appearance",
    body: el("div", {}, [
      field("Theme", themeSel),
      el("label", { text: "Accent color", style: { fontSize: "13px", color: "var(--text-secondary)" } }),
      accentRow,
      el("div.row", { style: { marginTop: "12px" } }, [field("Font size", fontSel), field("Bubble style", bubbleSel)]),
      field("Bubble radius (px)", radius),
      el("div.toggle-row", {}, [el("div.tr-label", { text: "Compact chat list" }), compact]),
    ]),
  });
}

/* --------------------- Scheduled (#17) --------------------- */
async function panelScheduled() {
  const acc = State.activeAccount;
  if (!acc) return toast("Add an account first", "error");
  const all = (await DB.getByIndex("scheduledMessages", "accountId", acc.id)).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const listEl = el("div");
  if (!all.length) listEl.append(el("div.hint", { text: "No scheduled messages." }));
  for (const s of all) {
    const chat = State.chats.find((c) => c.id === s.chatId);
    listEl.append(el("div.list-row", {}, [
      el("div.lr-body", {}, [
        el("div.lr-title", { text: chat?.title || s.chatId }),
        el("div.lr-sub", { text: `${s.text.slice(0, 50)} · ${new Date(s.scheduledAt).toLocaleString()} · ${s.status}` }),
      ]),
      el("button.icon-btn", { html: "🗑", onclick: async () => { await DB.delete("scheduledMessages", s.id); panelScheduled(); Bus.emit(EV.CLOSE_MODAL); } }),
    ]));
  }
  openModal({ title: "Scheduled Messages", body: listEl });
}

/* --------------------- Data & Storage (#11) --------------------- */
async function panelData() {
  const { usage, quota } = await DB.estimateUsage();
  const counts = {};
  for (const store of ["messages", "chats", "accounts", "templates", "ignoreList", "scheduledMessages", "analytics"]) {
    counts[store] = await DB.count(store);
  }
  const days = el("input", { type: "number", value: 30 });

  openModal({
    title: "Data & Storage",
    body: el("div", {}, [
      el("div.stat-grid", {}, [
        statCard(fmtBytes(usage), "Storage used"),
        statCard(quota ? `${((usage / quota) * 100).toFixed(1)}%` : "—", "Of quota"),
        statCard(counts.messages, "Messages"),
        statCard(counts.chats, "Chats"),
      ]),
      el("div.row", {}, [field("Clear messages older than (days)", days),
        el("div.field", {}, [el("label", { text: " " }), el("button.btn", { text: "Clear old", onclick: async () => {
          const cutoff = Date.now() - parseInt(days.value, 10) * 86400000;
          const msgs = await DB.getAll("messages");
          let n = 0;
          for (const mm of msgs) if (mm.timestamp < cutoff) { await DB.delete("messages", mm.id); n++; }
          toast(`Cleared ${n} old messages`, "success");
        } })])]),
      el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" } }, [
        el("button.btn", { text: "Export messages (JSON)", onclick: async () => exportJSON(await DB.getAll("messages"), "messages.json") }),
        el("button.btn", { text: "Export messages (CSV)", onclick: async () => exportCSV(await DB.getAll("messages"), "messages.csv") }),
        el("button.btn.danger", { text: "Wipe all data", onclick: async () => {
          if (await confirmDialog({ title: "Wipe everything", message: "This permanently deletes ALL local data (accounts, chats, messages, settings). Continue?", confirmText: "Wipe", danger: true })) {
            for (const s of ["messages", "chats", "accounts", "templates", "ignoreList", "scheduledMessages", "analytics", "folders", "promptTemplates", "settings"]) await DB.clear(s);
            Settings.reset();
            location.reload();
          }
        } }),
      ]),
    ]),
  });
}

/* --------------------- Import / Export workspace (#19) --------------------- */
function panelBackup() {
  const pw = el("input", { type: "password", placeholder: "Optional password" });
  openModal({
    title: "Import / Export Workspace",
    body: el("div", {}, [
      el("p", { text: "Export your entire workspace (accounts, sessions, settings, templates, ignore lists, folders) to a JSON file, optionally encrypted with a password.", style: { color: "var(--text-secondary)", lineHeight: "1.5", marginBottom: "12px" } }),
      field("Password (optional)", pw),
      el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, [
        el("button.btn.primary", { text: "Export workspace", onclick: () => exportWorkspace(pw.value) }),
        el("button.btn", { text: "Import workspace", onclick: () => importWorkspace(pw.value) }),
        el("button.btn", { text: "Export this account", onclick: () => exportAccount() }),
      ]),
    ]),
  });
}

async function exportWorkspace(password) {
  const data = {
    _meta: { app: "tg-ai-userbot", exportedAt: Date.now(), version: 1 },
    settings: Settings.export(),
    accounts: await DB.getAll("accounts"),
    chats: await DB.getAll("chats"),
    templates: await DB.getAll("templates"),
    ignoreList: await DB.getAll("ignoreList"),
    folders: await DB.getAll("folders"),
    promptTemplates: await DB.getAll("promptTemplates"),
    scheduledMessages: await DB.getAll("scheduledMessages"),
  };
  let payload = JSON.stringify(data, null, 2);
  if (password) payload = JSON.stringify({ _encrypted: true, data: await encrypt(payload, password) });
  downloadFile(payload, "workspace-backup.json", "application/json");
  toast("Workspace exported", "success");
}

function importWorkspace(password) {
  importRaw(async (raw) => {
    let obj = JSON.parse(raw);
    if (obj._encrypted) {
      if (!password) return toast("This backup is encrypted — enter the password first", "error");
      obj = JSON.parse(await decrypt(obj.data, password));
    }
    if (obj.settings) Settings.import(obj.settings);
    for (const store of ["accounts", "chats", "templates", "ignoreList", "folders", "promptTemplates", "scheduledMessages"]) {
      if (obj[store]) await DB.putMany(store, obj[store]);
    }
    toast("Workspace imported — reloading", "success");
    setTimeout(() => location.reload(), 800);
  });
}

async function exportAccount() {
  const acc = State.activeAccount;
  if (!acc) return toast("No active account", "error");
  const data = {
    account: acc,
    chats: await DB.getByIndex("chats", "accountId", acc.id),
    templates: await DB.getByIndex("templates", "accountId", acc.id),
    ignoreList: await DB.getByIndex("ignoreList", "accountId", acc.id),
  };
  exportJSON(data, `account-${acc.firstName || acc.id}.json`);
}

/* --------------------- Account Health (#18) --------------------- */
function panelHealth() {
  const body = el("div");
  const render = () => {
    clear(body);
    for (const acc of State.accounts) {
      const conn = State.connection.get(acc.id) || { status: "disconnected" };
      body.append(el("div.list-row", {}, [
        el("div.avatar.sm", { style: { background: avatarStyle(acc.id) } }, [initials(acc.firstName || acc.username || "?")]),
        el("div.lr-body", {}, [
          el("div.lr-title", { text: acc.firstName || acc.phoneNumber }),
          el("div.lr-sub", { text: `${conn.status} · reconnects: ${conn.reconnects || 0} · ping: ${conn.ping ?? "—"} ms` }),
        ]),
        el("span.conn-chip", { class: conn.status }, [el("span.dot"), conn.status]),
      ]));
    }
  };
  render();
  const off = Bus.on(EV.CONNECTION, render);
  openModal({ title: "Account Health", body, onClose: off });
}

/* --------------------- Per-chat prompt (#5 override) --------------------- */
function panelChatPrompt(ctx) {
  const chat = State.chats.find((c) => c.id === ctx.chatId);
  if (!chat) return;
  const aiToggle = toggle(chat.aiEnabled !== false, (v) => updateChat(chat.id, { aiEnabled: v }));
  const notify = select([
    { value: "all", label: "All messages" }, { value: "mentions", label: "Mentions only" }, { value: "none", label: "Nothing" },
  ], chat.notify || "all", (v) => updateChat(chat.id, { notify: v }));
  const prompt = el("textarea", { placeholder: "Leave blank to use the account default", value: chat.customPrompt || "" });

  const m = openModal({
    title: chat.title,
    body: el("div", {}, [
      el("div.toggle-row", {}, [el("div.tr-label", { text: "AI auto-reply in this chat" }), aiToggle]),
      field("Notifications", notify),
      field("Per-chat system prompt (override)", prompt),
      el("div", { style: { display: "flex", gap: "8px" } }, [
        el("button.btn", { text: chat.isPinned ? "Unpin" : "Pin", onclick: () => { updateChat(chat.id, { isPinned: !chat.isPinned }); m.close(); } }),
        el("button.btn", { text: chat.isMuted ? "Unmute" : "Mute", onclick: () => { updateChat(chat.id, { isMuted: !chat.isMuted }); m.close(); } }),
        el("button.btn", { text: chat.isArchived ? "Unarchive" : "Archive", onclick: () => { updateChat(chat.id, { isArchived: !chat.isArchived }); m.close(); } }),
      ]),
    ]),
    footer: [el("button.btn.primary", { text: "Save", onclick: async () => { await updateChat(chat.id, { customPrompt: prompt.value.trim() || null }); toast("Saved", "success"); m.close(); } })],
  });
}

/* --------------------- Shortcuts (#16) --------------------- */
function panelShortcuts() {
  const rows = [
    ["Ctrl + K", "Quick chat switcher"],
    ["Ctrl + N", "New account / login"],
    ["Ctrl + F", "Global search"],
    ["Ctrl + 1 / 2 / 3", "Switch account"],
    ["Ctrl + Shift + A", "Toggle AI auto-reply"],
    ["Esc", "Close modal / clear search"],
    ["?", "Show this help"],
    ["Enter", "Send message"],
    ["Shift + Enter", "New line"],
  ];
  openModal({
    title: "Keyboard Shortcuts",
    body: el("div", {}, rows.map(([k, d]) =>
      el("div.shortcut-row", {}, [el("span", { text: d }), el("span.kbd", { text: k })])
    )),
  });
}

/* ----------------------------- Helpers ----------------------------- */
function opts(csv) {
  return csv.split(",").map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
}
export function applyAppearance() {
  const s = Settings.all();
  document.documentElement.setAttribute("data-theme", s.theme);
  document.documentElement.style.setProperty("--accent", s.accent);
  const scale = s.fontSize === "small" ? 0.92 : s.fontSize === "large" ? 1.12 : 1;
  document.documentElement.style.setProperty("--font-scale", scale);
  let radius = s.bubbleStyle === "square" ? 4 : s.bubbleStyle === "custom" ? s.bubbleRadius : 12;
  document.documentElement.style.setProperty("--bubble-radius", radius + "px");
  document.querySelector(".app")?.classList.toggle("compact", !!s.compact);
}

function downloadFile(content, filename, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function exportJSON(data, filename) {
  downloadFile(JSON.stringify(data, null, 2), filename);
  toast("Exported", "success");
}
function exportCSV(rows, filename) {
  if (!rows.length) return toast("Nothing to export", "info");
  const cols = ["timestamp", "chatId", "senderName", "isOutgoing", "isAiGenerated", "text"];
  const csv = [cols.join(",")].concat(
    rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))
  ).join("\n");
  downloadFile(csv, filename, "text/csv");
  toast("Exported CSV", "success");
}
function importJSON(onData) {
  importRaw((raw) => onData(JSON.parse(raw)));
}
function importRaw(onRaw) {
  const inp = el("input", { type: "file", accept: ".json", style: { display: "none" } });
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    try { onRaw(await file.text()); }
    catch (e) { toast(`Import failed: ${e.message}`, "error"); }
  };
  document.body.append(inp);
  inp.click();
  inp.remove();
}

/* lightweight AES-GCM encryption for encrypted backups (#19) */
async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
async function encrypt(text, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return { salt: [...salt], iv: [...iv], ct: [...new Uint8Array(ct)] };
}
async function decrypt(payload, password) {
  const salt = new Uint8Array(payload.salt);
  const iv = new Uint8Array(payload.iv);
  const key = await deriveKey(password, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, new Uint8Array(payload.ct));
  return new TextDecoder().decode(pt);
}
