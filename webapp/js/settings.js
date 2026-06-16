/**
 * App-wide settings stored in localStorage (feature #15 theme, #13 notifications,
 * #16 shortcuts prefs, etc.). These are lightweight, synchronous preferences —
 * heavier per-account data lives in IndexedDB.
 */

const KEY = "tg-ai-settings";

const DEFAULTS = {
  // appearance
  theme: "dark", // dark | light
  accent: "#2ea6ff",
  bubbleStyle: "rounded", // rounded | square | custom
  bubbleRadius: 12,
  fontSize: "medium", // small | medium | large
  compact: false,

  // notifications
  notifications: true,
  sound: true,
  dnd: { enabled: false, from: "23:00", to: "07:00", manual: false },

  // general
  activeAccountId: null,
  setupComplete: false,
  invisibleMode: false, // bonus #23: read without marking as read
  sendOnEnter: true,
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(obj) {
  localStorage.setItem(KEY, JSON.stringify(obj));
}

export const Settings = {
  all() {
    return read();
  },
  get(key) {
    return read()[key];
  },
  set(key, value) {
    const s = read();
    s[key] = value;
    write(s);
    return s;
  },
  patch(partial) {
    const s = { ...read(), ...partial };
    write(s);
    return s;
  },
  reset() {
    write({ ...DEFAULTS });
    return { ...DEFAULTS };
  },
  export() {
    return read();
  },
  import(obj) {
    write({ ...DEFAULTS, ...obj });
  },
};

export const SETTINGS_DEFAULTS = DEFAULTS;
