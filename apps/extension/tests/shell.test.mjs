import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const optionsScript = await readFile(new URL("../dist/options/options.js", import.meta.url), "utf8");
const bootstrap = await readFile(new URL("../dist/content/bootstrap.js", import.meta.url), "utf8");
const statusScript = await readFile(new URL("../dist/content/site-status.js", import.meta.url), "utf8");

function optionsFixture({ throws = false } = {}) {
  let connect, changeObservation;
  const messages = [];
  const listeners = new Map();
  const element = (initial = {}) => ({ value: "", checked: false, disabled: false, textContent: "", addEventListener: (event, fn) => { const list = listeners.get(initial.id) ?? {}; list[event] = fn; listeners.set(initial.id, list); }, ...initial });
  const input = element({ id: "credential" }), deviceId = element({ id: "device-id" }), policyKeyId = element({ id: "policy-key-id" });
  const observation = element({ id: "observe-domains" }), status = element({ id: "status" }), button = element({ id: "connect" });
  const nodes = new Map([
    ["#owner-origin", element({ id: "owner-origin", value: "http://127.0.0.1:8787" })],
    ["#save-owner-origin", element({ id: "save-owner-origin" })], ["#owner-origin-status", element({ id: "owner-origin-status" })],
    ["#credential", input], ["#device-id", deviceId], ["#policy-key-id", policyKeyId], ["#policy-status", element({ id: "policy-status" })],
    ["#sync-policy", element({ id: "sync-policy" })], ["#rotate-policy-key", element({ id: "rotate-policy-key" })],
    ["#observe-domains", observation], ["#status", status], ["#connect", button],
    ["#custom-terms", element({ id: "custom-terms" })], ["#save-custom-terms", element({ id: "save-custom-terms" })], ["#custom-terms-status", element({ id: "custom-terms-status" })],
    ["#simulate-policy", element({ id: "simulate-policy" })], ["#simulation-result", element({ id: "simulation-result" })],
  ]);
  const runtime = { sendMessage: (message, callback) => { if (throws && message.type === "SET_DEVICE_CREDENTIAL") throw new Error("disconnected"); messages.push({ message, callback }); } };
  const context = vm.createContext({ document: { querySelector: selector => nodes.get(selector) ?? null }, chrome: { runtime, permissions: { request: (_permissions, callback) => callback(true) } }, URL });
  vm.runInContext(optionsScript, context);
  connect = listeners.get("connect").click;
  changeObservation = listeners.get("observe-domains").change;
  return { input, deviceId, policyKeyId, observation, status, button, messages, runtime, connect: () => connect(), changeObservation: () => changeObservation() };
}
test("Options loads domain-observation consent and reverts a failed opt-in update", () => {
  const f = optionsFixture();
  const load = f.messages.find(item => item.message.type === "GET_DOMAIN_OBSERVATION");
  load.callback({ enabled: false }); assert.equal(f.observation.checked, false);
  f.observation.checked = true; f.changeObservation();
  const update = f.messages.find(item => item.message.type === "SET_DOMAIN_OBSERVATION");
  assert.equal(update.message.enabled, true); assert.equal(f.observation.disabled, true);
  update.callback({ ok: false });
  assert.equal(f.observation.disabled, false); assert.equal(f.observation.checked, false);
});
test("Options rejects blank entry, immediately clears credentials, prevents duplicate save and handles failure", () => {
  const f = optionsFixture(); assert.ok(f.messages.some(item => item.message.type === "GET_CONNECTION_STATUS"));
  f.input.value = "  "; f.connect(); assert.equal(f.messages.filter(item => item.message.type === "SET_DEVICE_CREDENTIAL").length, 0);
  f.input.value = `ss_dev_${"x".repeat(48)}`; f.deviceId.value = "7a3b0f7a-7781-4ff1-9c67-50cb8569da51"; f.policyKeyId.value = "a".repeat(64); f.connect(); assert.equal(f.input.value, ""); assert.equal(f.deviceId.value, ""); assert.equal(f.button.disabled, true);
  f.connect(); const credentialMessage = f.messages.find(item => item.message.type === "SET_DEVICE_CREDENTIAL");
  assert.ok(credentialMessage); assert.equal(credentialMessage.message.deviceId, "7a3b0f7a-7781-4ff1-9c67-50cb8569da51");
  f.runtime.lastError = { message: "disconnected" }; credentialMessage.callback(undefined);
  assert.equal(f.button.disabled, false); assert.match(f.status.textContent, /Could not save/); assert.doesNotMatch(f.status.textContent, /ss_dev_/);
});
test("Options handles synchronous messaging failure without leaving the credential in the field", () => {
  const f = optionsFixture({ throws: true }); f.input.value = `ss_dev_${"x".repeat(48)}`; f.deviceId.value = "7a3b0f7a-7781-4ff1-9c67-50cb8569da51"; f.policyKeyId.value = "a".repeat(64); f.connect();
  assert.equal(f.input.value, ""); assert.equal(f.button.disabled, false); assert.match(f.status.textContent, /Could not save/);
});
test("runtime bootstrap rejects altered origins before constructing an adapter", () => {
  for (const origin of ["http://127.0.0.1:4173", "http://localhost:8787", "https://localhost:4173", "http://localhost:4174"]) {
    const modes = [];
    const context = vm.createContext({ window: { location: { origin, hostname: new URL(origin).hostname } }, document: { readyState: "complete" }, ShadowShield: { Content: { setCoverage: mode => modes.push(mode), ProviderAdapter: { siteForLocation: () => null }, SandboxAdapter: class { constructor() { throw new Error("must not attach"); } } } } });
    vm.runInContext(bootstrap, context); assert.deepEqual(modes, ["UNSUPPORTED"]);
  }
});
test("document_start status waits for an HTML root instead of crashing", () => {
  let onReady;
  const document = { documentElement: null, addEventListener: (_, fn) => { onReady = fn; } };
  const context = vm.createContext({ document, chrome: { runtime: { sendMessage: () => {} } } }); vm.runInContext(statusScript, context);
  context.ShadowShield.Content.setCoverage("UNPROTECTED", "Initializing");
  document.documentElement = { dataset: {} }; onReady(); assert.equal(document.documentElement.dataset.shadowshieldCoverage, "UNPROTECTED");
});
