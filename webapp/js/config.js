/**
 * Global configuration & constants.
 *
 * Values carried over from the original Python userbot (userbot.py):
 *   - Telegram API_ID / API_HASH
 *   - The AutoGLM (OpenAI-compatible) AI endpoint + default system prompt
 *
 * Everything here is just *defaults*. The user can override any of it from the
 * in-app settings UI (stored in IndexedDB / localStorage).
 */

export const APP = {
  name: "Telegram AI Userbot Workspace",
  version: "1.0.0",
  // Bump this to force the IndexedDB schema to upgrade.
  dbVersion: 1,
  dbName: "tg-ai-userbot",
};

/**
 * Telegram MTProto credentials.
 * These come from https://my.telegram.org/apps and are baked in from the
 * original userbot so the user can log in immediately. They can be changed in
 * Settings → Connection.
 */
export const TELEGRAM = {
  apiId: 36319482,
  apiHash: "ed3143bea8b6df50b5ae7191dfaae1cf",
  // gramjs connection options. WebSocket transport is used automatically in the
  // browser build.
  connection: {
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS: true,
  },
  // gramjs version loaded from the CDN (see index.html import map).
  gramjsVersion: "2.26.22",
};

/**
 * Default AI provider configuration (AutoGLM proxy used by the Python bot).
 * This is an OpenAI-compatible streaming endpoint.
 */
export const AI_DEFAULTS = {
  apiUrl:
    "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions",
  // The original bot used an X-Authorization bearer token instead of the
  // standard Authorization header. We support both auth styles (see ai.js).
  apiKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjozNTM4MywiZGV2aWNlX2lkIjoiMzliNTExN2Q4NDhiYzE2NjQ5NTI4ZDZkODU4YWVjYTMwMTE3M2Q5ZWIyYWM5NTAzNjZlNmYxNzFkMjEyMmFlMyIsInNvdXJjZV9pZCI6ImF1dG9jbGF3YWNjZXNzX3Rva2VuIiwiZ3VpZCI6IiIsImlzX2d1ZXN0IjpmYWxzZSwicG93ZXIiOjAsImV4cCI6MTc4MTY5MzI0NiwiaWF0IjoxNzgxNjA2ODQ2LCJqdGkiOiJyLm1hbnN1cnhvbjAxQGdtYWlsLmNvbSJ9.2cXwHhuwlkR0rDqmTEVJ2H-IIb8Xxje9W5QIAWknwHc",
  // Auth header style: "x-authorization" (AutoGLM) or "authorization" (OpenAI).
  authStyle: "x-authorization",
  model: "auto",
  temperature: 0.7,
  maxTokens: 1000,
  stream: true,
  // Extra headers required by the AutoGLM proxy.
  extraHeaders: {
    "X-Request-Model": "zai_auto",
    "X-Product": "autoclaw",
  },
};

/**
 * Default AI system prompt (a cleaned-up, English-friendly version of the
 * Uzbek persona from the original bot, with template variables).
 */
export const DEFAULT_SYSTEM_PROMPT = `You are the personal Telegram assistant for {{user_name}}.
You read and answer messages on their behalf in the chat "{{chat_name}}".
Write naturally, like a real person — warm, concise and human. Avoid stiff, robotic phrasing.

Rules:
- Never reveal private information about {{user_name}}.
- Never say that you are an AI, a bot, or a userbot. Behave like an ordinary person.
- In group chats, only respond when you are addressed or mentioned.
- Always respond in private (DM) chats.
- Reply in the same language the other person used (English, Russian, Uzbek, ...).
- Keep replies short and to the point. Do not spam.
- Current date/time: {{date}} {{time}}. Unread in this chat: {{unread_count}}.`;

/**
 * Default writing style (feature #6).
 */
export const DEFAULT_STYLE = {
  tone: "friendly", // formal | casual | friendly | professional | witty
  language: "auto", // auto | en | ru | uz | ...
  length: "auto", // short | medium | long | auto
  emoji: "minimal", // none | minimal | normal | lots
  signature: "",
  format: "plain", // plain | markdown | html
};

/**
 * Default trigger / filter rules (feature #8).
 */
export const DEFAULT_RULES = {
  // Quiet hours — don't auto-reply between these times (24h "HH:MM").
  quietHours: { enabled: false, from: "23:00", to: "07:00" },
  // Skip messages that contain only media and no text.
  skipMediaOnly: true,
  // In groups, only reply when mentioned or replied to.
  groupRequireMention: true,
  // Random "human" delay before the typing indicator shows (ms).
  responseDelay: { min: 1000, max: 3000 },
  // Keyword → template auto-responses. [{ keyword, templateId | text }]
  keywordTriggers: [],
};

export const ACCENT_COLORS = [
  "#2ea6ff", // Telegram blue (default)
  "#4fae4e", // green
  "#e0823d", // orange
  "#c0509b", // pink
  "#8e7cff", // purple
  "#d24c4c", // red
  "#43a0c9", // teal
];

export const FOLDER_ICONS = ["💼", "👥", "👨‍👩‍👧", "🤖", "⭐", "📌", "🏠", "💬", "🔥", "🛒"];
