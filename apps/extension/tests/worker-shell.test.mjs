import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../dist/apps/extension/src/background/worker.js", import.meta.url), "utf8");
const deviceId = "7a3b0f7a-7781-4ff1-9c67-50cb8569da51";
const policyKeyId = "a".repeat(64);
function fixture() {
  let listener, alarmListener, navigationListener, localAccessLevel, sessionAccessLevel;
  const local = {}, session = {}, messages = [];
  const chrome = {
    runtime: { getURL: path => `chrome-extension://synthetic-id/${path}`, getManifest: () => ({ version: "0.1.0" }), onMessage: { addListener: fn => { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: {
      local: { get: async keys => Object.fromEntries(keys.filter(k => k in local).map(k => [k, local[k]])), set: async value => Object.assign(local, value), remove: async keys => keys.forEach(k => delete local[k]), setAccessLevel: async value => { localAccessLevel = value.accessLevel; } },
      session: { get: async keys => Object.fromEntries(keys.filter(k => k in session).map(k => [k, session[k]])), set: async value => Object.assign(session, value), remove: async keys => keys.forEach(k => delete session[k]), setAccessLevel: async value => { sessionAccessLevel = value.accessLevel; } },
    },
    tabs: { query: (_, callback) => callback([{ id: 1 }]) }, webNavigation: { onCommitted: { addListener: fn => { navigationListener = fn; }, removeListener() {} } },
    alarms: { create() {}, clear: async () => true, onAlarm: { addListener: fn => { alarmListener = fn; }, removeListener() {} } },
  };
  vm.runInNewContext(workerSource, { chrome, console, URL, crypto: globalThis.crypto, TextEncoder, TextDecoder, AbortSignal, fetch: async () => new Response("{}", { status: 200 }), Response, setTimeout, clearTimeout });
  return { local, session, messages, alarmListener, get localAccessLevel() { return localAccessLevel; }, get sessionAccessLevel() { return sessionAccessLevel; }, navigate(details) { navigationListener?.(details); }, send(message, url = "chrome-extension://synthetic-id/options/index.html") { return new Promise(resolve => listener(message, { url, tab: { id: 1 } }, resolve)); } };
}
test("worker restricts credentials to Options, stores device ID locally and token in session only", async () => {
  const f = fixture();
  const token = `ss_dev_${"x".repeat(48)}`;
  assert.equal((await f.send({ type: "SET_DEVICE_CREDENTIAL", token, deviceId, policyKeyId })).ok, true);
  assert.equal(f.localAccessLevel, "TRUSTED_CONTEXTS"); assert.equal(f.sessionAccessLevel, "TRUSTED_CONTEXTS");
  assert.equal(f.session.deviceCredential, token); assert.equal(f.local.shadowshieldProvisionedDeviceId, deviceId);
  assert.equal(JSON.stringify(f.local).includes(token), false);
  assert.equal((await f.send({ type: "SET_DEVICE_CREDENTIAL", token: `ss_dev_${"y".repeat(48)}`, deviceId, policyKeyId }, "http://localhost:4173/")).ok, false);
  assert.equal(f.session.deviceCredential, token);
});
test("worker requires explicit domain opt-in and keeps it restricted to Options", async () => {
  const f = fixture();
  for (const token of ["", "x", ` ${"x".repeat(64)}`, "x".repeat(513)]) assert.equal((await f.send({ type: "SET_DEVICE_CREDENTIAL", token, deviceId, policyKeyId })).ok, false);
  const token = `ss_dev_${"z".repeat(48)}`;
  assert.equal((await f.send({ type: "SET_DEVICE_CREDENTIAL", token, deviceId, policyKeyId })).ok, true);
  assert.equal(f.local.shadowshieldDomainObservationEnabled, undefined);
  assert.equal(JSON.stringify(await f.send({ type: "GET_DOMAIN_OBSERVATION" })), JSON.stringify({ enabled: false }));
  f.navigate({ tabId: 1, frameId: 0, documentId: "doc-before-opt-in", url: "https://chatgpt.com/?q=customer%40example.invalid", transitionType: "link" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.local.shadowshieldSanitizedEventQueue?.length ?? 0, 0);
  assert.equal(JSON.stringify(await f.send({ type: "SET_DOMAIN_OBSERVATION", enabled: true })), JSON.stringify({ ok: true, enabled: true }));
  assert.equal(JSON.stringify(await f.send({ type: "GET_DOMAIN_OBSERVATION" })), JSON.stringify({ enabled: true }));
  assert.equal(f.local.shadowshieldDomainObservationEnabled, true);
  f.navigate({ tabId: 1, frameId: 0, documentId: "doc-after-opt-in", url: "https://chatgpt.com/?q=customer%40example.invalid", transitionType: "link" });
  await new Promise(resolve => setTimeout(resolve, 10));
  const observed = f.local.shadowshieldSanitizedEventQueue.map(item => item.event);
  assert.ok(observed.some(event => event.kind === "SITE_VISIT" && event.siteId === "CHATGPT"));
  assert.ok(observed.some(event => event.kind === "DEVICE_HEARTBEAT"));
  assert.doesNotMatch(JSON.stringify(observed), /customer|example\.invalid|chatgpt\.com|q=/i);
  assert.equal(JSON.stringify(await f.send({ type: "SET_DOMAIN_OBSERVATION", enabled: false }, "http://localhost:4173/")), JSON.stringify({ ok: false }));
  assert.equal(JSON.stringify(await f.send({ type: "GET_DOMAIN_OBSERVATION" }, "http://localhost:4173/")), JSON.stringify({ enabled: false }));
  const status = await f.send({ type: "GET_CONNECTION_STATUS" }); assert.equal(typeof status.connected, "boolean"); assert.equal(typeof status.message, "string");
});
test("page scripts cannot analyze drafts or enqueue telemetry from an unapproved origin", async () => {
  const f = fixture();
  assert.equal(JSON.stringify(await f.send({ type: "ANALYZE_LOCAL", text: "hello" }, "http://localhost:4174/")), JSON.stringify({ ok: false, error: "UNTRUSTED_ORIGIN" }));
  assert.equal(JSON.stringify(await f.send({ type: "ENQUEUE_EVENT", event: {} }, "http://localhost:4174/")), JSON.stringify({ ok: false, queued: false }));
});

test("custom protected terms stay local, increment policy revision, and apply only on supported pages", async () => {
  const f = fixture();
  assert.equal(JSON.stringify(await f.send({ type: "GET_CUSTOM_TERMS" })), JSON.stringify({ terms: [], revision: 1 }));
  assert.equal((await f.send({ type: "SET_CUSTOM_TERMS", terms: [" Project Atlas "] })).revision, 2);
  assert.equal(JSON.stringify(f.local.shadowshieldLocalCustomTerms), JSON.stringify(["Project Atlas"]));
  const analysis = await f.send({ type: "ANALYZE_LOCAL", text: "internal note on project atlas" }, "https://chatgpt.com/");
  assert.equal(analysis.ok, true);
  assert.equal(analysis.analysis.decision.action, "WARN");
  assert.equal(analysis.analysis.decision.policyRevision, 2);
  assert.equal(analysis.analysis.detection.categoryCounts.CUSTOM_PROTECTED_TERM, 1);
  assert.equal(JSON.stringify(await f.send({ type: "GET_CUSTOM_TERMS" }, "https://chatgpt.com/")), JSON.stringify({ terms: [], revision: 1 }));
  assert.equal((await f.send({ type: "SET_CUSTOM_TERMS", terms: ["xx"] })).ok, false);
  assert.equal((await f.send({ type: "SET_CUSTOM_TERMS", terms: ["Project Atlas", "project atlas"] })).ok, false);
  assert.equal((await f.send({ type: "SET_CUSTOM_TERMS", terms: Array.from({ length: 101 }, (_, i) => `term ${i}`) })).ok, false);
});

test("policy simulation returns aggregates from synthetic samples without returning sample text", async () => {
  const f = fixture();
  const result = await f.send({ type: "SIMULATE_POLICY" });
  assert.equal(result.ok, true);
  assert.equal(result.sampleCount, 5);
  assert.ok(result.actions.BLOCK >= 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
});
