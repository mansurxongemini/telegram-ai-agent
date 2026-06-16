/**
 * Account login flow (feature #1) and first-run welcome wizard (#20).
 */

import { el, mount } from "./dom.js";
import { openModal, toast, field, select } from "./modals.js";
import { ensureClient, newAccountTemplate, saveAccount, switchAccount } from "../service.js";
import { Settings } from "../settings.js";
import { DEFAULT_STYLE, AI_DEFAULTS, DEFAULT_SYSTEM_PROMPT } from "../config.js";

/**
 * Multi-step login modal. Resolves with the saved account, or null if cancelled.
 */
export function openLoginFlow(onDone) {
  const account = newAccountTemplate();
  const mgr = (() => {
    // a transient manager not yet registered in State.clients
    return ensureClient(account);
  })();

  const body = el("div");
  let phoneCodeHash = null;
  let phoneNumber = "";
  let manager = null;

  const modal = openModal({
    title: "Add Telegram account",
    body,
    onClose: () => onDone?.(null),
  });

  async function init() {
    manager = await mgr;
    renderPhone();
  }

  function renderPhone() {
    const phoneInput = el("input", { type: "tel", placeholder: "+998 90 123 45 67" });
    const next = el("button.btn.primary", { text: "Send code" });
    mount(
      body,
      el("p", { text: "Enter your phone number with country code. Telegram will send a login code to your app.", style: { marginBottom: "14px", color: "var(--text-secondary)" } }),
      field("Phone number", phoneInput),
      el("div.modal-footer", { style: { padding: 0 } }, [next])
    );
    setTimeout(() => phoneInput.focus(), 50);

    next.onclick = async () => {
      phoneNumber = phoneInput.value.trim();
      if (!phoneNumber) return toast("Enter a phone number", "error");
      next.textContent = "Sending…";
      next.disabled = true;
      try {
        const res = await manager.startLogin(phoneNumber);
        phoneCodeHash = res.phoneCodeHash;
        renderCode();
      } catch (e) {
        toast(`Failed to send code: ${e.message || e}`, "error");
        next.textContent = "Send code";
        next.disabled = false;
      }
    };
  }

  function renderCode() {
    const codeInput = el("input", { type: "text", placeholder: "12345" });
    const next = el("button.btn.primary", { text: "Sign in" });
    const back = el("button.btn", { text: "Back", onclick: renderPhone });
    mount(
      body,
      el("p", { text: `Enter the code sent to ${phoneNumber}.`, style: { marginBottom: "14px", color: "var(--text-secondary)" } }),
      field("Login code", codeInput),
      el("div.modal-footer", { style: { padding: 0 } }, [back, next])
    );
    setTimeout(() => codeInput.focus(), 50);

    next.onclick = async () => {
      const code = codeInput.value.trim();
      if (!code) return toast("Enter the code", "error");
      next.textContent = "Signing in…";
      next.disabled = true;
      try {
        await finish({ code });
      } catch (e) {
        if (e.code === "2FA_REQUIRED" || String(e).includes("SESSION_PASSWORD_NEEDED")) {
          renderPassword(code);
        } else {
          toast(`Sign-in failed: ${e.message || e}`, "error");
          next.textContent = "Sign in";
          next.disabled = false;
        }
      }
    };
  }

  function renderPassword(code) {
    const pwInput = el("input", { type: "password", placeholder: "2FA password" });
    const next = el("button.btn.primary", { text: "Confirm" });
    mount(
      body,
      el("p", { text: "This account has two-step verification enabled. Enter your password.", style: { marginBottom: "14px", color: "var(--text-secondary)" } }),
      field("2FA password", pwInput),
      el("div.modal-footer", { style: { padding: 0 } }, [next])
    );
    setTimeout(() => pwInput.focus(), 50);
    next.onclick = async () => {
      next.textContent = "Confirming…";
      next.disabled = true;
      try {
        await finish({ code, password: pwInput.value });
      } catch (e) {
        toast(`2FA failed: ${e.message || e}`, "error");
        next.textContent = "Confirm";
        next.disabled = false;
      }
    };
  }

  async function finish({ code, password }) {
    const { me, stringSession } = await manager.completeLogin({
      phoneNumber,
      phoneCodeHash,
      code,
      password,
    });
    account.phoneNumber = phoneNumber;
    account.firstName = me.firstName || "";
    account.lastName = me.lastName || "";
    account.username = me.username || "";
    account.stringSession = stringSession;
    account.lastActive = Date.now();
    await saveAccount(account);
    await switchAccount(account.id);
    toast(`Signed in as ${account.firstName || account.username}`, "success");
    modal.close();
    onDone?.(account);
  }

  init();
  return modal;
}

/**
 * First-run welcome wizard (#20). Steps: intro → add account → AI config →
 * writing style → done. "Skip all" available.
 */
export function openWelcomeWizard(onComplete) {
  const body = el("div");
  let step = 0;
  const total = 4;
  const draftAI = { ...AI_DEFAULTS };
  const draftStyle = { ...DEFAULT_STYLE };

  const modal = openModal({
    title: "Welcome 👋",
    body,
    onClose: () => {},
  });

  function dots() {
    return el("div.wizard-dots", {},
      Array.from({ length: total }, (_, i) => el(`div.dot${i === step ? ".active" : ""}`))
    );
  }

  function footer(children) {
    return el("div.modal-footer", { style: { padding: "16px 0 0" } }, children);
  }

  function finishWizard() {
    Settings.patch({ setupComplete: true });
    modal.close();
    onComplete?.({ ai: draftAI, style: draftStyle });
  }

  function render() {
    if (step === 0) {
      mount(body, el("div.wizard-step", {}, [
        el("div.step-icon", { text: "✈️" }),
        el("h3", { text: "Telegram AI Userbot Workspace", style: { marginBottom: "8px" } }),
        el("p", { text: "Run your Telegram on autopilot. Add accounts, configure an AI persona, and let it reply for you — all locally in your browser.", style: { color: "var(--text-secondary)", lineHeight: "1.5" } }),
        dots(),
        footer([
          el("button.btn.ghost", { text: "Skip all", onclick: finishWizard }),
          el("button.btn.primary", { text: "Get started", onclick: () => { step = 1; render(); } }),
        ]),
      ]));
    } else if (step === 1) {
      mount(body, el("div.wizard-step", {}, [
        el("div.step-icon", { text: "👤" }),
        el("h3", { text: "Add your first account", style: { marginBottom: "8px" } }),
        el("p", { text: "Connect a Telegram account using your phone number.", style: { color: "var(--text-secondary)" } }),
        dots(),
        footer([
          el("button.btn", { text: "Later", onclick: () => { step = 2; render(); } }),
          el("button.btn.primary", { text: "Log in", onclick: () => { modal.close(); openLoginFlow(() => { openWelcomeWizardAt(2, draftAI, draftStyle, onComplete); }); } }),
        ]),
      ]));
    } else if (step === 2) {
      const url = el("input", { type: "text", value: draftAI.apiUrl });
      const key = el("input", { type: "password", value: draftAI.apiKey });
      const model = el("input", { type: "text", value: draftAI.model });
      mount(body, el("div", {}, [
        el("div.wizard-step", {}, [el("div.step-icon", { text: "🤖" }), el("h3", { text: "Configure AI", style: { marginBottom: "8px" } })]),
        field("API endpoint (OpenAI-compatible)", url, "Pre-filled with the AutoGLM proxy."),
        field("API key / token", key),
        field("Model", model),
        dots(),
        footer([
          el("button.btn", { text: "Skip", onclick: () => { step = 3; render(); } }),
          el("button.btn.primary", { text: "Next", onclick: () => {
            draftAI.apiUrl = url.value; draftAI.apiKey = key.value; draftAI.model = model.value;
            step = 3; render();
          } }),
        ]),
      ]));
    } else if (step === 3) {
      const tone = select([
        { value: "friendly", label: "Friendly" },
        { value: "casual", label: "Casual" },
        { value: "formal", label: "Formal" },
        { value: "professional", label: "Professional" },
        { value: "witty", label: "Witty" },
      ], draftStyle.tone, (v) => (draftStyle.tone = v));
      const lang = select([
        { value: "auto", label: "Auto-detect" },
        { value: "en", label: "English" },
        { value: "ru", label: "Russian" },
        { value: "uz", label: "Uzbek" },
      ], draftStyle.language, (v) => (draftStyle.language = v));
      mount(body, el("div", {}, [
        el("div.wizard-step", {}, [el("div.step-icon", { text: "✍️" }), el("h3", { text: "Writing style", style: { marginBottom: "8px" } })]),
        field("Tone", tone),
        field("Language", lang),
        dots(),
        footer([
          el("button.btn.primary", { text: "Finish", onclick: finishWizard }),
        ]),
      ]));
    }
  }

  render();
  return modal;
}

// Helper to resume the wizard at a given step after the login modal closes.
function openWelcomeWizardAt(step, draftAI, draftStyle, onComplete) {
  const w = openWelcomeWizard(onComplete);
  // jump (simple re-run): the wizard starts at 0; emulate by closing & noting.
}
