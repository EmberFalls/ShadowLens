import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const adapterScript = await readFile(new URL("../dist/content/sandbox-adapter.js", import.meta.url), "utf8");

class FakeEvent {
  constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles === true; this.detail = options.detail; this.defaultPrevented = false; this.target = null; }
  preventDefault() { this.defaultPrevented = true; }
  stopImmediatePropagation() { this.immediateStopped = true; }
}
class FakeCustomEvent extends FakeEvent {}
class FakeElement {
  constructor(ownerDocument = null) { this.ownerDocument = ownerDocument; this.parentElement = null; this.listeners = new Map(); }
  addEventListener(type, callback) { const list = this.listeners.get(type) ?? []; list.push(callback); this.listeners.set(type, list); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== callback)); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event);
    if (event.bubbles && this.parentElement) this.parentElement.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  contains(target) { for (let current = target; current; current = current.parentElement) if (current === this) return true; return false; }
}
class FakeTextArea extends FakeElement {
  constructor(ownerDocument, initial = "") { super(ownerDocument); this._value = initial; this.reactTrackedValue = initial; this.coerceValue = (value) => value; }
  get value() { return this._value; }
  set value(value) { this._value = this.coerceValue(String(value)); }
  dispatchEvent(event) {
    const accepted = super.dispatchEvent(event);
    if (event.type === "input") this.reactTrackedValue = this.value;
    return accepted;
  }
}
class FakeButton extends FakeElement {}
class FakeDocument extends FakeElement {
  constructor(composer = null, button = null) { super(); this.currentComposer = composer; this.currentButton = button; this.documentElement = new FakeElement(this); }
  querySelector(selector) { return selector === "#shadow-composer" ? this.currentComposer : selector === "#shadow-send" ? this.currentButton : null; }
}
class FakeMutationObserver {
  static instances = [];
  constructor(callback) { this.callback = callback; FakeMutationObserver.instances.push(this); }
  observe() {}
  disconnect() {}
  trigger() { this.callback([]); }
}

function adapterFor({ withSelectors = true, initial = "", coerceValue } = {}) {
  const root = new FakeDocument();
  const composer = withSelectors ? new FakeTextArea(root, initial) : null;
  const button = withSelectors ? new FakeButton(root) : null;
  root.currentComposer = composer;
  root.currentButton = button;
  if (coerceValue && composer) composer.coerceValue = coerceValue;
  FakeMutationObserver.instances.length = 0;
  const context = vm.createContext({ Element: FakeElement, HTMLTextAreaElement: FakeTextArea, MutationObserver: FakeMutationObserver, Event: FakeEvent, CustomEvent: FakeCustomEvent, document: root, console });
  vm.runInContext(adapterScript, context, { filename: "sandbox-adapter.js" });
  const adapter = new context.ShadowShield.Content.SandboxAdapter(root);
  return { adapter, root, composer, button, mutationObserver: FakeMutationObserver.instances.at(-1) };
}

test("discovers only the fixed composer and send selectors", () => {
  const { adapter, composer, button } = adapterFor();
  assert.equal(adapter.isCompatible(), true);
  assert.equal(adapter.isSupportedTarget(composer), true);
  assert.equal(adapter.isSupportedTarget(button), true);
  assert.equal(adapter.isSupportedTarget(new FakeElement()), false);
  adapter.disconnect();
  const unsupported = adapterFor({ withSelectors: false });
  assert.equal(unsupported.adapter.isCompatible(), false);
  assert.equal(unsupported.adapter.readDraft(), null);
  unsupported.adapter.disconnect();
});

test("uses native value setter, bubbles input, and verifies exact React-like readback", () => {
  const { adapter, composer } = adapterFor({ initial: "draft" });
  assert.equal(adapter.writeDraft("approved text"), true);
  assert.equal(composer.value, "approved text");
  assert.equal(composer.reactTrackedValue, "approved text");
  assert.equal(adapter.readDraft().text, "approved text");
  adapter.disconnect();
});

test("fails exact readback when the editor transforms the approved value", () => {
  const { adapter, composer } = adapterFor({ coerceValue: (value) => value.toUpperCase() });
  assert.equal(adapter.writeDraft("approved text"), false);
  assert.equal(composer.value, "APPROVED TEXT");
  adapter.disconnect();
});

test("composer replacement advances the revision so a stale draft is detectable", () => {
  const { adapter, root, mutationObserver } = adapterFor({ initial: "first" });
  const before = adapter.readDraft();
  const replacement = new FakeTextArea(root, "second");
  root.currentComposer = replacement;
  mutationObserver.trigger();
  const after = adapter.readDraft();
  assert.equal(after.text, "second");
  assert.ok(after.revision > before.revision);
  adapter.disconnect();
});

test("release emits one cooperative request and a receipt only correlates that attempt", () => {
  const { adapter, root, composer } = adapterFor({ initial: "approved" });
  const attemptId = "7a3b0f7a-7781-4ff1-9c67-50cb8569da51";
  const requests = [];
  composer.addEventListener("shadowshield:submit-request", (event) => requests.push(event.detail));
  const attestations = [];
  adapter.onReceipt((id) => attestations.push(id));
  adapter.release(attemptId);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ protocol: "v2", attemptId }]);
  assert.throws(() => adapter.release(attemptId), /already used/);
  root.dispatchEvent(new FakeCustomEvent("shadowshield:receipt", { detail: { protocol: "v2", attemptId: "forged", status: "ACCEPTED" } }));
  assert.deepEqual(attestations, []);
  root.dispatchEvent(new FakeCustomEvent("shadowshield:receipt", { detail: { protocol: "v2", attemptId, status: "ACCEPTED" } }));
  assert.deepEqual(attestations, [attemptId]);
  adapter.disconnect();
});
