import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../dist/apps/extension/src/background/worker.js", import.meta.url), "utf8");
function fixture() {
  let listener, accessLevel;
  const session = {};
  const chrome = {
    runtime: { getURL: path => `chrome-extension://synthetic-id/${path}`, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { session: { setAccessLevel: async value => { accessLevel = value.accessLevel; }, set: async value => Object.assign(session, value) } },
    tabs: { query: (_, fn) => fn([{ id: 1 }]) },
  };
  vm.runInNewContext(worker, { chrome, console, URL, crypto: globalThis.crypto, TextEncoder, TextDecoder });
  return { session, get accessLevel() { return accessLevel; }, send(message, url = "chrome-extension://synthetic-id/options/index.html") {
    return new Promise(resolve => { listener(message, { url, tab: { id: 1 } }, resolve); });
  } };
}
test("worker restricts credential storage and accepts entries from its own Options page", async () => {
  const f = fixture(); assert.equal(f.accessLevel, "TRUSTED_CONTEXTS");
  const saved = await f.send({ type: "SET_DEVICE_CREDENTIAL", token: "synthetic-token-only-for-testing" });
  assert.equal(saved.ok, true); assert.equal(f.session.deviceCredential, "synthetic-token-only-for-testing");
  assert.equal((await f.send({ type: "SET_DEVICE_CREDENTIAL", token: "synthetic-overwrite-token" }, "http://localhost:4173/")).ok, false);
  assert.equal(f.session.deviceCredential, "synthetic-token-only-for-testing");
});
test("worker rejects malformed credentials and reports the missing transport truthfully", async () => {
  const f = fixture();
  for (const token of ["", "x", " token with whitespace ", "x".repeat(513)]) assert.equal((await f.send({ type: "SET_DEVICE_CREDENTIAL", token })).ok, false);
  const status = await f.send({ type: "GET_CONNECTION_STATUS" }); assert.equal(status.connected, false); assert.match(status.message, /not configured/);
  const enqueue = await f.send({ type: "ENQUEUE_EVENT", event: {} }); assert.equal(enqueue.queued, false);
});
