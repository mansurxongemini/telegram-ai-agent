/**
 * Generic modal + toast + confirm helpers used by every feature panel.
 */

import { el, mount, clear } from "./dom.js";

const modalRoot = () => document.getElementById("modal-root");
const toastRoot = () => document.getElementById("toast-root");

let escStack = [];

/**
 * Open a modal.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {Node|Node[]} opts.body
 * @param {Node[]} [opts.footer]  buttons
 * @param {boolean} [opts.wide]
 * @returns {{close: Function, el: HTMLElement}}
 */
export function openModal({ title, body, footer = [], wide = false, onClose }) {
  const root = modalRoot();
  const modal = el(`div.modal${wide ? ".wide" : ""}`, {}, [
    el("div.modal-header", {}, [
      el("h2", { text: title }),
      el("button.icon-btn", { text: "✕", onclick: () => close() }),
    ]),
    el("div.modal-body", {}, Array.isArray(body) ? body : [body]),
    footer.length ? el("div.modal-footer", {}, footer) : null,
  ]);
  const overlay = el("div.modal-overlay", {
    onclick: (e) => {
      if (e.target === overlay) close();
    },
  }, [modal]);

  root.append(overlay);

  function close() {
    overlay.remove();
    escStack = escStack.filter((f) => f !== close);
    onClose?.();
  }
  escStack.push(close);

  return { close, el: modal, overlay };
}

export function closeTopModal() {
  const fn = escStack[escStack.length - 1];
  if (fn) {
    fn();
    return true;
  }
  return false;
}

export function closeAllModals() {
  while (escStack.length) escStack.pop()();
}

/** Confirmation dialog returning a promise<boolean>. */
export function confirmDialog({ title, message, confirmText = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: el("p", { text: message, style: { lineHeight: "1.5" } }),
      footer: [
        el("button.btn", { text: "Cancel", onclick: () => { m.close(); resolve(false); } }),
        el(`button.btn.${danger ? "danger" : "primary"}`, {
          text: confirmText,
          onclick: () => { m.close(); resolve(true); },
        }),
      ],
      onClose: () => resolve(false),
    });
  });
}

/** Prompt dialog returning a promise<string|null>. */
export function promptDialog({ title, label, value = "", placeholder = "", type = "text" }) {
  return new Promise((resolve) => {
    const input = el("input", { type, value, placeholder });
    const m = openModal({
      title,
      body: el("div.field", {}, [label ? el("label", { text: label }) : null, input]),
      footer: [
        el("button.btn", { text: "Cancel", onclick: () => { m.close(); resolve(null); } }),
        el("button.btn.primary", { text: "OK", onclick: () => { m.close(); resolve(input.value); } }),
      ],
      onClose: () => resolve(null),
    });
    setTimeout(() => input.focus(), 50);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { m.close(); resolve(input.value); }
    });
  });
}

let toastTimer = new WeakMap();
export function toast(message, type = "info", duration = 3000) {
  const t = el(`div.toast.${type}`, { text: message });
  toastRoot().append(t);
  const timer = setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .2s";
    setTimeout(() => t.remove(), 220);
  }, duration);
  toastTimer.set(t, timer);
  return t;
}

/** Reusable toggle switch component. */
export function toggle(checked, onChange) {
  const input = el("input", { type: "checkbox", checked, onchange: (e) => onChange(e.target.checked) });
  return el("label.switch", {}, [input, el("span.slider")]);
}

/** Reusable labelled field. */
export function field(label, control, hint) {
  return el("div.field", {}, [
    label ? el("label", { text: label }) : null,
    control,
    hint ? el("div.hint", { text: hint }) : null,
  ]);
}

export function select(options, value, onChange) {
  const sel = el("select", { onchange: (e) => onChange(e.target.value) },
    options.map((o) =>
      el("option", { value: o.value, selected: o.value === value, text: o.label })
    )
  );
  return sel;
}

/** A modal whose body can host multiple tabs. */
export function tabbedBody(tabs) {
  const content = el("div.tab-content");
  const tabBar = el("div.tabs");
  const render = (idx) => {
    [...tabBar.children].forEach((c, i) => c.classList.toggle("active", i === idx));
    clear(content);
    const out = tabs[idx].render();
    content.append(...(Array.isArray(out) ? out : [out]));
  };
  tabs.forEach((t, i) => {
    tabBar.append(el("button.tab", { text: t.label, onclick: () => render(i) }));
  });
  const wrap = el("div", {}, [tabBar, content]);
  render(0);
  return wrap;
}
