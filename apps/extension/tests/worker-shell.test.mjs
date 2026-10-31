import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const workerSource = await readFile(new URL("../dist/apps/extension/src/background/worker.js", import.meta.url), "utf8");
const deviceId = "7a3b0f7a-7781-4ff1-9c67-50cb8569da51";
const policyKeyId = "a".repeat(64);
function fixture({ fetchImpl } = {}) {
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
  vm.runInNewContext(workerSource, { chrome, console, URL, crypto: globalThis.crypto, TextEncoder, TextDecoder, AbortSignal, atob: globalThis.atob, fetch: fetchImpl ?? (async () => new Response("{}", { status: 200 })), Response, setTimeout, clearTimeout });
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

test("policy-key rotation accepts a valid new signature and preserves the previous trust on invalid replacement", async () => {
  const canonical = value => {
    const sort = input => Array.isArray(input) ? input.map(sort) : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])])) : input;
    return JSON.stringify(sort(value));
  };
  const signedPolicy = async (revision, invalidate = false) => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const keyId = Buffer.from(await crypto.subtle.digest("SHA-256", publicBytes)).toString("hex");
    const keyDocument = { algorithm: "ECDSA_P256_SHA256", keyId, publicKey: Buffer.from(publicBytes).toString("base64") };
    const payload = {
      contractVersion: "v2", revision, defaultFindingAction: "WARN", allowWarnOverride: true,
      updatedAt: new Date().toISOString(), protectedTerms: [],
      rules: [{ id: "POLICY.PRIVATE_KEY", category: "SECRET_PRIVATE_KEY", minimumSeverity: "LOW", action: "BLOCK", enabled: true }],
    };
    const unsigned = {
      algorithm: "ECDSA_P256_SHA256", keyId,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      payload,
    };
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(canonical(unsigned))));
    if (invalidate) signature[0] ^= 0xff;
    return { keyId, keyDocument, bundle: { ...unsigned, signature: Buffer.from(signature).toString("base64") } };
  };

  const previousResponse = await signedPolicy(1);
  let activeResponse = await signedPolicy(2);
  const f = fixture({ fetchImpl: async url => {
    if (url.endsWith("/policy/public-key")) return new Response(JSON.stringify(activeResponse.keyDocument), { status: 200 });
    if (url.endsWith("/policy/bundle")) return new Response(JSON.stringify(activeResponse.bundle), { status: 200 });
    return new Response("{}", { status: 404 });
  } });
  const token = `ss_dev_${"r".repeat(48)}`;
  f.local.shadowshieldPolicyKeyId = previousResponse.keyId;
  f.local.shadowshieldSignedPolicyBundle = previousResponse.bundle;
  f.local.shadowshieldPolicyPublicKey = previousResponse.keyDocument;
  f.local.shadowshieldSignedPolicyRevision = 1;
  assert.equal((await f.send({ type: "SET_DEVICE_CREDENTIAL", token, deviceId, policyKeyId: previousResponse.keyId })).ok, true);
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await f.send({ type: "GET_POLICY_SYNC_STATUS" });
    if (!/Verifying signed owner policy/i.test(status.message)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.local.shadowshieldPolicyKeyId, previousResponse.keyId);
  const rotation = await f.send({ type: "ROTATE_POLICY_KEY", keyId: activeResponse.keyId });
  assert.equal(rotation.ok, true, rotation.message);
  assert.equal(f.local.shadowshieldPolicyKeyId, activeResponse.keyId);
  assert.equal(f.local.shadowshieldSignedPolicyBundle.keyId, activeResponse.keyId);
  assert.equal(f.local.shadowshieldSignedPolicyRevision, 2);
  assert.equal(f.session.deviceCredential, token);

  const priorKey = f.local.shadowshieldPolicyKeyId;
  const priorBundle = JSON.stringify(f.local.shadowshieldSignedPolicyBundle);
  activeResponse = await signedPolicy(3, true);
  const rejected = await f.send({ type: "ROTATE_POLICY_KEY", keyId: activeResponse.keyId });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /previous verified policy remains in force/i);
  assert.equal(f.local.shadowshieldPolicyKeyId, priorKey);
  assert.equal(JSON.stringify(f.local.shadowshieldSignedPolicyBundle), priorBundle);
  assert.equal(f.local.shadowshieldSignedPolicyRevision, 2);
  assert.equal(f.session.deviceCredential, token);
});

