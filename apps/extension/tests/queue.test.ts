import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PrivacySafeQueue,
  QUEUE_STORAGE_KEY,
  QUARANTINE_STORAGE_KEY,
  MAX_QUEUE_EVENTS,
  MAX_QUEUE_AGE_MS,
  type StorageArea,
} from "../dist/apps/extension/src/background/queue.js";
import { EventApiClient, retryDelayMs } from "../dist/apps/extension/src/background/api-client.js";

const DEVICE_ID = "6bde3d14-92bb-461b-89f9-7bacb7fb846c";
const TOKEN = "ss_dev_test_queue_credential_with_more_than_32_chars";
const BASE_TIME = Date.parse("2026-10-31T08:00:00Z");

function makeSubmission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: "v2", eventId: randomUUID(), clientObservedAt: "2026-10-31T08:00:00Z",
    kind: "SUBMISSION", siteId: "SANDBOX", coverageMode: "SANDBOX_GUARDED",
    decisionAction: "ALLOW", disposition: "PAGE_ATTESTED", aggregateTier: "NONE", scoreBand: "ZERO",
    categoryCounts: {}, policyRevision: 1, engineVersion: "0.1.0", lengthBand: "1_99",
    reasonCodes: ["PAGE_ACK_RECEIVED"], ...overrides,
  };
}

function memoryStorage(initial: Record<string, unknown> = {}): StorageArea & { values: Record<string, unknown> } {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, structuredClone(values[key])]));
    },
    async set(items) { Object.assign(values, structuredClone(items)); },
  };
}

test("event serializer binds enrollment ID and rejects prompt, URL, and malformed event data", async () => {
  const storage = memoryStorage(); const queue = new PrivacySafeQueue(storage, () => BASE_TIME);
  const clean = makeSubmission();
  assert.equal((await queue.enqueue(clean, DEVICE_ID)).queued, true);
  assert.equal((await queue.enqueue({
    contractVersion: "v2", eventId: randomUUID(), clientObservedAt: "2026-10-31T08:00:00.000Z",
    deviceId: DEVICE_ID, kind: "SITE_VISIT", siteId: "CHATGPT", supportStatus: "UNSUPPORTED",
    reasonCodes: ["UNSUPPORTED_AI_SITE_SEEN"],
  }, DEVICE_ID)).queued, true);
  assert.equal((await queue.enqueue({
    contractVersion: "v2", eventId: randomUUID(), clientObservedAt: "2026-10-31T08:00:00Z",
    deviceId: DEVICE_ID, kind: "DEVICE_HEARTBEAT", extensionVersion: "0.1.0",
  }, DEVICE_ID)).queued, true);
  assert.equal((await queue.enqueue(makeSubmission({ rawText: "RAW_PROMPT_SENTINEL" }), DEVICE_ID)).queued, false);
  assert.equal((await queue.enqueue(makeSubmission({ url: "https://chatgpt.com/?prompt=URL_SENTINEL" }), DEVICE_ID)).queued, false);
  assert.equal((await queue.enqueue(makeSubmission({ deviceId: "7a3b0f7a-7781-4ff1-9c67-50cb8569da51" }), DEVICE_ID)).queued, false);
  assert.equal((await queue.enqueue(makeSubmission({ disposition: "BLOCKED", decisionAction: "ALLOW" }), DEVICE_ID)).queued, false);
  const persisted = JSON.stringify(storage.values);
  assert.equal(persisted.includes("RAW_PROMPT_SENTINEL"), false);
  assert.equal(persisted.includes("URL_SENTINEL"), false);
  assert.equal(persisted.includes(TOKEN), false);
  const persistedQueue = storage.values[QUEUE_STORAGE_KEY] as Array<{ event: { deviceId: string } }>;
  assert.equal(persistedQueue[0].event.deviceId, DEVICE_ID);
});

test("queue survives worker restart and duplicate enqueue retains one event", async () => {
  const storage = memoryStorage(); const event = makeSubmission();
  const first = new PrivacySafeQueue(storage, () => BASE_TIME);
  assert.equal((await first.enqueue(event, DEVICE_ID)).queued, true);
  const restarted = new PrivacySafeQueue(storage, () => BASE_TIME + 1_000);
  assert.equal((await restarted.enqueue(event, DEVICE_ID)).queued, true);
  assert.equal((await restarted.batch()).length, 1);
});

test("uncertain network result retries the same UUID and duplicate acknowledgement clears it", async () => {
  const storage = memoryStorage(); const firstQueue = new PrivacySafeQueue(storage, () => BASE_TIME);
  const event = makeSubmission(); await firstQueue.enqueue(event, DEVICE_ID);
  let serverAccepted = false; const sentIds: string[][] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { events: Array<{ eventId: string }> };
    sentIds.push(body.events.map((item) => item.eventId));
    if (!serverAccepted) { serverAccepted = true; throw new TypeError("connection dropped after commit"); }
    return new Response(JSON.stringify({ accepted: 0, duplicates: body.events.length, rejected: 0 }), { status: 200 });
  };
  const restarted = new PrivacySafeQueue(storage, () => BASE_TIME + 2_000);
  const client = new EventApiClient(restarted, async () => ({ token: TOKEN, deviceId: DEVICE_ID }), fakeFetch);
  assert.equal(await client.flushOneBatch(), "retry");
  assert.equal((await restarted.batch()).length, 1);
  assert.equal(await client.flushOneBatch(), "sent");
  assert.deepEqual(sentIds[0], sentIds[1]);
  assert.equal((await restarted.batch()).length, 0);
});

test("401 preserves queued events and requires reconnect", async () => {
  const queue = new PrivacySafeQueue(memoryStorage(), () => BASE_TIME);
  await queue.enqueue(makeSubmission(), DEVICE_ID);
  const client = new EventApiClient(queue, async () => ({ token: TOKEN, deviceId: DEVICE_ID }), async () => new Response("", { status: 401 }));
  assert.equal(await client.flushOneBatch(), "reconnect");
  assert.equal((await queue.batch()).length, 1);
});

test("422 quarantines IDs only; 503 and network failures retain queued events", async () => {
  const storage = memoryStorage(); const queue = new PrivacySafeQueue(storage, () => BASE_TIME);
  const event = makeSubmission(); await queue.enqueue(event, DEVICE_ID);
  const badRequest = new EventApiClient(queue, async () => ({ token: TOKEN, deviceId: DEVICE_ID }), async () => new Response("", { status: 422 }));
  assert.equal(await badRequest.flushOneBatch(), "quarantined");
  assert.equal((await queue.batch()).length, 0);
  const quarantine = storage.values[QUARANTINE_STORAGE_KEY] as Array<{ eventId: string }>;
  assert.equal(quarantine[0].eventId, event.eventId);
  assert.equal(JSON.stringify(quarantine).includes("PAGE_ACK"), false);

  await queue.enqueue(makeSubmission(), DEVICE_ID);
  for (const failedFetch of [
    async () => new Response("", { status: 503 }),
    async () => { throw new TypeError("offline"); },
  ]) {
    const client = new EventApiClient(queue, async () => ({ token: TOKEN, deviceId: DEVICE_ID }), failedFetch as typeof fetch);
    assert.equal(await client.flushOneBatch(), "retry");
    assert.equal((await queue.batch()).length, 1);
  }
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(4), 240_000);
  assert.equal(retryDelayMs(100), 30_000 * 2 ** 9);
});

test("queue ages out after 24 hours and rejects new events at its 500-event cap", async () => {
  let now = BASE_TIME; const queue = new PrivacySafeQueue(memoryStorage(), () => now);
  for (let index = 0; index < MAX_QUEUE_EVENTS; index++) assert.equal((await queue.enqueue(makeSubmission(), DEVICE_ID)).queued, true);
  assert.equal((await queue.enqueue(makeSubmission(), DEVICE_ID)).reason, "QUEUE_FULL");
  now += MAX_QUEUE_AGE_MS + 1;
  assert.equal((await queue.enqueue(makeSubmission(), DEVICE_ID)).queued, true);
  assert.equal((await queue.batch()).length, 1);
});

test("sender caps each batch at 25 and removes only IDs covered by a complete acknowledgement", async () => {
  const queue = new PrivacySafeQueue(memoryStorage(), () => BASE_TIME);
  for (let index = 0; index < 26; index++) await queue.enqueue(makeSubmission(), DEVICE_ID);
  let itemCount = 0;
  const client = new EventApiClient(queue, async () => ({ token: TOKEN, deviceId: DEVICE_ID }), async (_url, init) => {
    itemCount = (JSON.parse(String(init?.body)) as { events: unknown[] }).events.length;
    return new Response(JSON.stringify({ accepted: 25, duplicates: 0, rejected: 0 }), { status: 200 });
  });
  assert.equal(await client.flushOneBatch(), "sent");
  assert.equal(itemCount, 25);
  assert.equal((await queue.batch()).length, 1);
});

