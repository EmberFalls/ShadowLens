import test from "node:test";
import assert from "node:assert/strict";
import { DomainObserver, createHeartbeatEvent, siteForNavigation } from "../dist/apps/extension/src/background/domain-observer.js";

const deviceId = "7a3b0f7a-7781-4ff1-9c67-50cb8569da51";
const eventId = "e97307de-d5cc-4ced-a0fd-2f22c4e155af";
const now = new Date("2026-10-30T12:34:56.000Z");
const commit = (url, overrides = {}) => ({ tabId: 2, frameId: 0, documentId: "document-1", url, transitionType: "link", ...overrides });

test("maps only exact registry hosts and the exact local sandbox origin", () => {
  assert.deepEqual(siteForNavigation("https://chatgpt.com/?q=private"), { siteId: "CHATGPT", supportStatus: "UNSUPPORTED" });
  assert.equal(siteForNavigation("https://evilchatgpt.com/"), null);
  assert.equal(siteForNavigation("https://chatgpt.com.evil.example/"), null);
  assert.equal(siteForNavigation("https://sub.chatgpt.com/"), null);
  assert.equal(siteForNavigation("http://localhost:4173/" )?.siteId, "SANDBOX");
  assert.equal(siteForNavigation("http://localhost:8787/api/v1/health"), null);
});

test("emits metadata only, strips query and fragment, and marks unguarded AI tools unsupported", async () => {
  const events = [];
  const observer = new DomainObserver({ enabled: true, getDeviceId: () => deviceId, enqueue: (event) => events.push(event), now: () => now, makeEventId: () => eventId });
  assert.equal(await observer.onCommitted(commit("https://chatgpt.com/?access_token=synthetic-secret#private")), true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    contractVersion: "v2", eventId, clientObservedAt: now.toISOString(), deviceId,
    kind: "SITE_VISIT", siteId: "CHATGPT", supportStatus: "UNSUPPORTED", reasonCodes: ["UNSUPPORTED_AI_SITE_SEEN"],
  });
  assert.equal(JSON.stringify(events[0]).includes("synthetic-secret"), false);
  assert.equal(Object.hasOwn(events[0], "url"), false);
});

test("ignores subframes, disabled observation and invalid device IDs", async () => {
  const events = [];
  const observer = new DomainObserver({ enabled: false, getDeviceId: () => deviceId, enqueue: (event) => events.push(event) });
  assert.equal(await observer.onCommitted(commit("https://chatgpt.com/")), false);
  observer.setEnabled(true);
  assert.equal(await observer.onCommitted(commit("https://chatgpt.com/", { frameId: 3, documentId: "frame-doc" })), false);
  const invalidDevice = new DomainObserver({ enabled: true, getDeviceId: () => "employee-name", enqueue: (event) => events.push(event) });
  assert.equal(await invalidDevice.onCommitted(commit("https://chatgpt.com/")), false);
  assert.equal(events.length, 0);
});

test("deduplicates document IDs across same-document route transitions", async () => {
  const events = [];
  const observer = new DomainObserver({ enabled: true, getDeviceId: () => deviceId, enqueue: (event) => events.push(event), now: () => now, makeEventId: () => eventId });
  assert.equal(await observer.onCommitted(commit("https://claude.ai/new")), true);
  assert.equal(await observer.onCommitted(commit("https://claude.ai/project/123?prompt=secret")), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].siteId, "CLAUDE");
});

test("does not dedupe separate documents for a repeated site visit", async () => {
  const events = [];
  let next = 0;
  const observer = new DomainObserver({ enabled: true, getDeviceId: () => deviceId, enqueue: (event) => events.push(event), now: () => now, makeEventId: () => `event-${++next}` });
  assert.equal(await observer.onCommitted(commit("https://gemini.google.com/", { documentId: "doc-a" })), true);
  assert.equal(await observer.onCommitted(commit("https://gemini.google.com/", { documentId: "doc-b" })), true);
  assert.equal(events.length, 2);
});

test("heartbeat is category-free server-observed metadata and makes no stale assertion", () => {
  const heartbeat = createHeartbeatEvent({ deviceId, extensionVersion: "0.1.0", now, makeEventId: () => eventId });
  assert.deepEqual(heartbeat, { contractVersion: "v2", eventId, clientObservedAt: now.toISOString(), deviceId, kind: "DEVICE_HEARTBEAT", extensionVersion: "0.1.0" });
  assert.equal(Object.hasOwn(heartbeat, "observation"), false);
});
