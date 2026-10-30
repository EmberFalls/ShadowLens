import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const optionsScript = await readFile(new URL("../dist/options/options.js", import.meta.url), "utf8");
const bootstrap = await readFile(new URL("../dist/content/bootstrap.js", import.meta.url), "utf8");
const statusScript = await readFile(new URL("../dist/content/site-status.js", import.meta.url), "utf8");

function optionsFixture({ throws = false } = {}) {
  let connect;
  const input = { value: "" }, status = {}, button = { disabled: false, addEventListener: (_, fn) => { connect = fn; } }, messages = [];
  const runtime = { sendMessage: (message, callback) => { if (throws && message.type === "SET_DEVICE_CREDENTIAL") throw new Error("disconnected"); messages.push({ message, callback }); } };
  const context = vm.createContext({ document: { querySelector: selector => selector === "#credential" ? input : selector === "#status" ? status : button }, chrome: { runtime } });
  vm.runInContext(optionsScript, context);
  return { input, status, button, messages, runtime, connect: () => connect() };
}
test("Options rejects blank entry, immediately clears credentials, prevents duplicate save and handles failure", () => {
  const f = optionsFixture(); assert.equal(f.messages[0].message.type, "GET_CONNECTION_STATUS");
  f.input.value = "  "; f.connect(); assert.equal(f.messages.length, 1);
  f.input.value = "synthetic-device-token"; f.connect(); assert.equal(f.input.value, ""); assert.equal(f.button.disabled, true);
  f.connect(); assert.equal(f.messages.length, 2);
  assert.equal(f.messages[1].message.type, "SET_DEVICE_CREDENTIAL");
  f.runtime.lastError = { message: "disconnected" }; f.messages[1].callback(undefined);
  assert.equal(f.button.disabled, false); assert.match(f.status.textContent, /Could not save/); assert.doesNotMatch(f.status.textContent, /synthetic-device-token/);
});
test("Options handles synchronous messaging failure without leaving the credential in the field", () => {
  const f = optionsFixture({ throws: true }); f.input.value = "synthetic-device-token"; f.connect();
  assert.equal(f.input.value, ""); assert.equal(f.button.disabled, false); assert.match(f.status.textContent, /Could not save/);
});
test("runtime bootstrap rejects altered origins before constructing an adapter", () => {
  for (const origin of ["http://127.0.0.1:4173", "http://localhost:8787", "https://localhost:4173", "http://localhost:4174"]) {
    const modes = [];
    const context = vm.createContext({ window: { location: { origin } }, document: { readyState: "complete" }, ShadowShield: { Content: { setCoverage: mode => modes.push(mode), SandboxAdapter: class { constructor() { throw new Error("must not attach"); } } } } });
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
