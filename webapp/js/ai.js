/**
 * AI engine (features #4 auto-reply, #5 system prompt + variables, #6 writing
 * style, #8 triggers/filters).
 *
 * - Talks to an OpenAI-compatible streaming endpoint (default: AutoGLM proxy).
 * - Decides whether to auto-reply (DM / mention / reply; ignore list; quiet
 *   hours; media-only skip) exactly like the original Python userbot.
 * - Applies writing-style instructions and template variables.
 */

import { AI_DEFAULTS, DEFAULT_SYSTEM_PROMPT, DEFAULT_STYLE, DEFAULT_RULES } from "./config.js";
import { DB, uid } from "./db.js";

/** Build the headers for the configured auth style. */
function buildHeaders(aiCfg) {
  const headers = { "Content-Type": "application/json" };
  const key = aiCfg.apiKey || "";
  if ((aiCfg.authStyle || AI_DEFAULTS.authStyle) === "x-authorization") {
    headers["X-Authorization"] = `Bearer ${key}`;
    Object.assign(headers, AI_DEFAULTS.extraHeaders, aiCfg.extraHeaders || {});
  } else {
    headers["Authorization"] = `Bearer ${key}`;
  }
  return headers;
}

/** Substitute {{variables}} in a prompt/template string. */
export function applyVariables(text, ctx = {}) {
  const now = new Date();
  const vars = {
    user_name: ctx.userName || "you",
    chat_name: ctx.chatName || "this chat",
    sender_name: ctx.senderName || ctx.chatName || "there",
    time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    date: now.toLocaleDateString(),
    unread_count: ctx.unreadCount ?? 0,
    ...ctx.extra,
  };
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    k in vars ? vars[k] : m
  );
}

/** Turn the writing-style config into an extra system instruction. */
export function styleInstruction(style = DEFAULT_STYLE) {
  const toneMap = {
    formal: "Use a formal, respectful tone.",
    casual: "Use a relaxed, casual tone.",
    friendly: "Use a warm, friendly tone.",
    professional: "Use a clear, professional tone.",
    witty: "Use a witty, lightly humorous tone.",
  };
  const lenMap = {
    short: "Keep replies very short (1-2 sentences).",
    medium: "Keep replies to a short paragraph.",
    long: "You may write a few detailed paragraphs.",
    auto: "Match the length of the other person's message.",
  };
  const emojiMap = {
    none: "Do not use emojis.",
    minimal: "Use emojis very sparingly, at most one.",
    normal: "Use a normal, natural amount of emojis.",
    lots: "Use plenty of expressive emojis.",
  };
  const langMap = {
    auto: "Reply in the same language the other person used.",
    en: "Always reply in English.",
    ru: "Always reply in Russian.",
    uz: "Always reply in Uzbek.",
  };
  const fmtMap = {
    plain: "Respond in plain text.",
    markdown: "You may use Markdown formatting.",
    html: "You may use simple HTML formatting.",
  };
  const parts = [
    toneMap[style.tone] || toneMap.friendly,
    langMap[style.language] || langMap.auto,
    lenMap[style.length] || lenMap.auto,
    emojiMap[style.emoji] || emojiMap.minimal,
    fmtMap[style.format] || fmtMap.plain,
  ];
  if (style.signature) parts.push(`End your message with: "${style.signature}".`);
  return parts.join(" ");
}

/**
 * Decide whether the AI should auto-reply to an incoming message.
 * Mirrors userbot.py handle_message() logic.
 *
 * @returns {triggered: boolean, reason: string, templateText?: string}
 */
export function shouldReply({ message, chat, account, rules, ignoreList, myUsername, myId }) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };

  // master switches
  if (!account?.aiSettings?.enabled) return { triggered: false, reason: "account-ai-off" };
  if (chat && chat.aiEnabled === false) return { triggered: false, reason: "chat-ai-off" };

  // never reply to our own messages
  if (message.isOutgoing) return { triggered: false, reason: "own-message" };

  // ignore list (permanent or temporary)
  const ign = (ignoreList || []).find(
    (i) => i.userId === message.senderId || i.userId === chat?.telegramChatId
  );
  if (ign) {
    if (!ign.expiresAt || ign.expiresAt > Date.now())
      return { triggered: false, reason: "ignored" };
  }

  // temporary per-chat mute
  if (chat?.ignoreUntil && chat.ignoreUntil > Date.now())
    return { triggered: false, reason: "chat-muted" };

  // media-only / empty messages
  const text = (message.text || "").trim();
  if (!text) {
    if (r.skipMediaOnly) return { triggered: false, reason: "media-only" };
  }

  // quiet hours
  if (r.quietHours?.enabled && inQuietHours(r.quietHours.from, r.quietHours.to))
    return { triggered: false, reason: "quiet-hours" };

  // keyword triggers (template responses)
  for (const kt of r.keywordTriggers || []) {
    if (kt.keyword && text.toLowerCase().includes(kt.keyword.toLowerCase())) {
      return { triggered: true, reason: "keyword", templateText: kt.text || null, templateId: kt.templateId || null };
    }
  }

  const isDM = chat?.type === "dm" || chat?.type === "saved";
  if (isDM) return { triggered: true, reason: "dm" };

  // groups/channels: only when mentioned or replied to
  const mentioned = myUsername && text.toLowerCase().includes(`@${myUsername.toLowerCase()}`);
  const repliedToMe = message.replyToSenderId && String(message.replyToSenderId) === String(myId);
  if (r.groupRequireMention && !mentioned && !repliedToMe)
    return { triggered: false, reason: "group-no-mention" };

  return { triggered: true, reason: mentioned ? "mention" : "reply" };
}

function inQuietHours(from, to) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  const start = fh * 60 + fm;
  const end = th * 60 + tm;
  if (start <= end) return cur >= start && cur < end;
  // overnight range (e.g. 23:00 -> 07:00)
  return cur >= start || cur < end;
}

/**
 * Stream a chat completion. Calls onToken(deltaText) as content arrives.
 * Returns the full assembled string.
 */
export async function streamCompletion({ aiCfg, messages, signal, onToken }) {
  const cfg = { ...AI_DEFAULTS, ...aiCfg };
  const payload = {
    model: cfg.model || "auto",
    messages,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    stream: cfg.stream !== false,
  };

  const resp = await fetch(cfg.apiUrl, {
    method: "POST",
    headers: buildHeaders(cfg),
    body: JSON.stringify(payload),
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`AI API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  // Non-streaming fallback.
  if (!cfg.stream) {
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || "";
    onToken?.(content);
    return content;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") return full;
      try {
        const chunk = JSON.parse(dataStr);
        const delta = chunk.choices?.[0]?.delta?.content || "";
        if (delta) {
          full += delta;
          onToken?.(delta);
        }
      } catch {
        // ignore partial / non-JSON keep-alive lines
      }
    }
  }
  return full;
}

/**
 * Generate a reply for a chat given recent history.
 *
 * @param {Object} opts
 * @param {Object} opts.account
 * @param {Object} opts.chat
 * @param {Array}  opts.history  recent messages [{isOutgoing, senderName, text}]
 * @param {Object} opts.ctx      variable context {userName, chatName, ...}
 * @param {Function} opts.onToken streaming callback
 */
export async function generateReply({ account, chat, history, ctx, onToken, signal }) {
  const ai = account.aiSettings || {};
  const basePrompt = chat?.customPrompt || ai.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const style = ai.style || DEFAULT_STYLE;

  const systemContent =
    applyVariables(basePrompt, ctx) + "\n\n" + styleInstruction(style);

  const messages = [{ role: "system", content: systemContent }];

  // recent conversation as context
  for (const m of history.slice(-12)) {
    messages.push({
      role: m.isOutgoing ? "assistant" : "user",
      content: m.text || "",
    });
  }

  const t0 = performance.now();
  const text = await streamCompletion({
    aiCfg: ai,
    messages,
    signal,
    onToken,
  });
  const elapsed = Math.round(performance.now() - t0);

  // analytics (feature #14)
  try {
    await DB.put("analytics", {
      id: uid("an"),
      accountId: account.id,
      chatId: chat?.id || null,
      timestamp: Date.now(),
      responseTimeMs: elapsed,
      tokensEstimate: Math.ceil((systemContent.length + text.length) / 4),
    });
  } catch {}

  return { text: text.trim(), elapsed };
}

/** Random human-like delay before showing the typing indicator. */
export function humanDelay(rules = DEFAULT_RULES) {
  const { min, max } = rules.responseDelay || DEFAULT_RULES.responseDelay;
  return min + Math.random() * (max - min);
}
