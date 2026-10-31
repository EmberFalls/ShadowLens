import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const adapterScript = await readFile(new URL("../dist/content/provider-adapter.js", import.meta.url), "utf8");

class FakeElement {
  constructor(tagName = "div", attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.parentElement = null;
    this.children = [];
    this.isConnected = true;
    this.shadowRoot = null;
    this.value = "";
    this.isContentEditable = this.attributes.contenteditable === "true";
  }
  matches(selector) {
    if (selector === "*") return true;
    return selector.split(",").some((item) => {
      const normalized = item.trim().toLowerCase();
      return normalized === this.tagName.toLowerCase()
        || normalized === "button[aria-label*='send' i]" && this.tagName === "BUTTON" && /send/i.test(this.attributes["aria-label"] ?? "")
        || normalized === "textarea" && this.tagName === "TEXTAREA"
        || normalized === "input" && this.tagName === "INPUT"
        || normalized === "[contenteditable='true']" && this.attributes.contenteditable === "true"
        || normalized === "[role='textbox']" && this.attributes.role === "textbox"
        || normalized === ".text-input-field_textarea-wrapper" && this.attributes.class === "text-input-field_textarea-wrapper";
    });
  }
  contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
  closest() { return null; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  getClientRects() { return [{}]; }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...items) { this.children.push(...items); for (const item of items) item.parentElement = this; }
  attachShadow() { this.shadowRoot = { append: (...items) => { this.shadowRoot.children = items; } }; return this.shadowRoot; }
  remove() { this.isConnected = false; }
}

class FakeMutationObserver { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} }
class FakeTextarea extends FakeElement {}

function providerAdapter({ recognizedGeminiTextarea = false } = {}) {
  const send = new FakeElement("button", { "aria-label": "Send message" });
  const wrapper = new FakeElement("div", { class: "text-input-field_textarea-wrapper" });
  const unknownEditor = recognizedGeminiTextarea
    ? new FakeTextarea("textarea", { placeholder: "Enter a prompt for Gemini" })
    : new FakeElement("div", { contenteditable: "true", class: "future-provider-editor" });
  if (recognizedGeminiTextarea) wrapper.append(unknownEditor);
  const notices = [];
  const root = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    documentElement: { append: (item) => notices.push(item) },
    addEventListener() {}, removeEventListener() {}, getElementById: () => null,
    querySelectorAll(selector) {
      if (selector === "*") return recognizedGeminiTextarea ? [send, wrapper, unknownEditor] : [send, unknownEditor];
      if (selector.toLowerCase().includes("button[aria-label*='send' i]")) return [send];
      if (recognizedGeminiTextarea && [".text-input-field_textarea-wrapper textarea", "textarea[placeholder*='prompt' i]"].includes(selector)) return [unknownEditor];
      return [];
    },
    createElement: (tagName) => new FakeElement(tagName),
  };
  const context = vm.createContext({
    document: root, Element: FakeElement, HTMLElement: FakeElement,
    HTMLTextAreaElement: FakeTextarea, HTMLInputElement: class extends FakeElement {},
    HTMLButtonElement: class extends FakeElement {}, HTMLFormElement: class extends FakeElement {},
    MutationObserver: FakeMutationObserver, window: { setTimeout: () => 1, clearTimeout() {} }, console,
  });
  vm.runInContext(adapterScript, context, { filename: "provider-adapter.js" });
  return { adapter: new context.ShadowShield.Content.ProviderAdapter(root, "GEMINI"), send, unknownEditor, notices };
}

test("unrecognized provider editor fails closed for Send and Enter shortcuts", () => {
  const { adapter, send, unknownEditor, notices } = providerAdapter();
  assert.equal(adapter.isCompatible(), false);
  assert.equal(adapter.isSendTarget(send), true);
  assert.equal(adapter.readDraft(), null);
  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, composedPath: () => [unknownEditor] };
  assert.equal(adapter.isUninspectableEditorShortcut(enter), true);
  assert.equal(adapter.isUninspectableEditorShortcut({ ...enter, shiftKey: true }), false);
  assert.equal(notices.length, 2);
  assert.match(notices[0].shadowRoot.children[1].textContent, /sending is blocked/i);
  adapter.disconnect();
});

test("Gemini textarea under its current wrapper is recognized as the prompt composer", () => {
  const { adapter, send, unknownEditor, notices } = providerAdapter({ recognizedGeminiTextarea: true });
  unknownEditor.value = "Synthetic prompt";
  assert.equal(adapter.isCompatible(), true);
  assert.equal(adapter.isSendTarget(send), true);
  const draft = adapter.readDraft();
  assert.equal(draft?.text, "Synthetic prompt");
  assert.equal(draft?.revision, 1);
  assert.equal(notices.length, 0);
  adapter.disconnect();
});

