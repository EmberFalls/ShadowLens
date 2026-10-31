import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { analyze, verifyRedaction } from "../dist/packages/engine/src/index.js";
import { DEFAULT_POLICY } from "../dist/packages/engine/src/default-policy.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
const validateEvent = ajv.compile(JSON.parse(await readFile(new URL("../../../packages/contracts/schemas/event.schema.json", import.meta.url), "utf8")));

const stateScript = await readFile(new URL("../dist/content/gate-state.js", import.meta.url), "utf8");
const gateScript = await readFile(new URL("../dist/content/gate.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture({ text = "Hello", deferred = false, missingReceipt = false, verify = true, throwTransport = false } = {}) {
  const listeners = new Map(), timers = new Map(), pending = [], events = [], releases = [], reviews = [], receipts = new Set();
  let now = 0, timerId = 0, revision = 1, draft = text;
  const composer = {}, button = {};
  const window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const adapter = {
    siteId: "SANDBOX", coverageMode: "SANDBOX_GUARDED", coverageLabel: () => "Guard active",
    isSendTarget: target => target === button, isComposerTarget: target => target === composer,
    readDraft: () => ({ text: draft, revision }), writeDraft: value => { draft = value; revision++; return true; },
    release: id => { releases.push(draft); if (!missingReceipt) for (const receipt of receipts) receipt(id); },
    onReceipt: fn => { receipts.add(fn); return () => receipts.delete(fn); },
  };
  const context = vm.createContext({ window, crypto: { randomUUID }, console,
    setTimeout: (fn, delay) => { timers.set(++timerId, { at: now + delay, fn }); return timerId; }, clearTimeout: id => timers.delete(id),
    chrome: { runtime: { sendMessage: (message, callback) => {
      if (message.type === "ENQUEUE_EVENT") {
        const complete = { ...message.event, deviceId: "7a3b0f7a-7781-4ff1-9c67-50cb8569da51" };
        assert.equal(validateEvent(complete), true, JSON.stringify(validateEvent.errors));
        events.push(message.event); if (throwTransport) throw new Error("offline"); callback({ ok: false }); return;
      }
      if (message.type === "ANALYZE_LOCAL") {
        if (deferred) { pending.push(callback); return; }
        try { callback({ ok: true, analysis: analyze({ text: message.text, policy: DEFAULT_POLICY }) }); }
        catch (error) { callback({ ok: false, error: error.code }); }
      }
      if (message.type === "VERIFY_REDACTION" && verify !== "timeout") callback({ ok: true, verification: verify ? verifyRedaction({ ...message, policy: DEFAULT_POLICY }) : { safe: false } });
    } } },
  });
  vm.runInContext(stateScript, context);
  context.ShadowShield.Content.showReview = (analysis, preview) => {
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const review = { analysis, preview, result, resolve, cancel: () => resolve({ approved: false, acknowledgeWarning: false }) };
    reviews.push(review); return review;
  };
  vm.runInContext(gateScript, context);
  const gate = new context.ShadowShield.Content.ProtectedGate(adapter);
  const gesture = ({ type = "click", target = type === "click" ? button : composer, isTrusted = true, ...extra } = {}) => {
    const event = { type, target, isTrusted, key: "Enter", prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}, ...extra };
    listeners.get(type)?.(event); return event;
  };
  return { gate, adapter, gesture, pending, releases, reviews, events, receipts, composer, button, listeners,
    edit(value) { draft = value; revision++; listeners.get("input")?.({ target: composer }); },
    async tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); },
  };
}

test("IME, Shift+Enter, synthetic clicks and editor clicks do not start analysis", () => {
  const f = fixture({ deferred: true });
  for (const extra of [{ isComposing: true }, { shiftKey: true }, { keyCode: 229 }]) f.gesture({ type: "keydown", ...extra });
  f.gesture({ target: f.composer });
  const synthetic = f.gesture({ isTrusted: false });
  assert.equal(synthetic.prevented, true); assert.equal(f.pending.length, 0); assert.equal(f.releases.length, 0);
});
test("duplicate clicks start one attempt and ALLOW releases once", async () => {
  const f = fixture({ deferred: true });
  f.gesture(); f.gesture(); assert.equal(f.pending.length, 1);
  f.pending[0]({ ok: true, analysis: analyze({ text: "Hello", policy: DEFAULT_POLICY }) }); await flush();
  assert.deepEqual(f.releases, ["Hello"]); assert.equal(f.events[0].disposition, "PAGE_ATTESTED");
});
test("BLOCK never writes to receiver and resets for a later safe send", async () => {
  const f = fixture({ text: "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----" });
  f.gesture(); await flush(); assert.deepEqual(f.releases, []); assert.equal(f.events[0].disposition, "BLOCKED");
  f.edit("Hello"); f.gesture(); await flush(); assert.deepEqual(f.releases, ["Hello"]);
});
test("verified REDACT sends exactly the preview and telemetry contains no raw draft", async () => {
  const f = fixture({ text: "Email person@shop.invalid" }); f.gesture(); await flush();
  assert.equal(f.reviews[0].preview, "Email [REDACTED_PII]");
  f.reviews[0].resolve({ approved: true, acknowledgeWarning: false }); await flush();
  assert.deepEqual(f.releases, ["Email [REDACTED_PII]"]);
  assert.equal(JSON.stringify(f.events).includes("person@shop.invalid"), false);
  assert.equal(f.events[0].kind, "SUBMISSION"); assert.equal(f.events[0].reasonCodes.includes("PAGE_ACK_RECEIVED"), true);
});
test("residual redaction and verifier timeout never release", async () => {
  for (const verify of [false, "timeout"]) {
    const f = fixture({ text: "person@shop.invalid", verify }); f.gesture(); await flush();
    f.reviews[0].resolve({ approved: true, acknowledgeWarning: false }); await flush();
    if (verify === "timeout") await f.tick(2500);
    assert.deepEqual(f.releases, []); assert.equal(f.events[0].disposition, "FAILED_SAFE");
    assert.equal(f.events[0].decisionAction, null); assert.equal(f.events[0].aggregateTier, "NOT_EVALUATED");
  }
});
test("cancellation and editing during review invalidate consent", async () => {
  for (const edit of [true, false]) {
    const f = fixture({ text: "person@shop.invalid" }); f.gesture(); await flush();
    if (edit) f.edit("New draft"); else f.reviews[0].resolve({ approved: false, acknowledgeWarning: false });
    await flush(); assert.equal(f.releases.length, 0); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].disposition, edit ? "FAILED_SAFE" : "CANCELLED");
  }
});
test("a cancelled scan cannot complete a new attempt with a late response", async () => {
  const f = fixture({ deferred: true }); f.gesture(); f.edit("Second draft"); f.gesture();
  f.pending[0]({ ok: true, analysis: analyze({ text: "Hello", policy: DEFAULT_POLICY }) }); await flush();
  assert.equal(f.releases.length, 0);
  f.pending[1]({ ok: true, analysis: analyze({ text: "Second draft", policy: DEFAULT_POLICY }) }); await flush();
  assert.deepEqual(f.releases, ["Second draft"]);
});
test("scan timeout fails closed, ignores late result and allows another attempt", async () => {
  const f = fixture({ deferred: true }); f.gesture(); await f.tick(2500);
  assert.equal(f.events[0].reasonCodes[0], "SCANNER_TIMEOUT");
  f.pending[0]({ ok: true, analysis: analyze({ text: "Hello", policy: DEFAULT_POLICY }) }); await flush();
  assert.equal(f.releases.length, 0); f.gesture(); assert.equal(f.pending.length, 2);
});
test("invalid policy, oversized input and malformed analysis fail closed", async () => {
  for (const error of ["INVALID_POLICY", "INPUT_TOO_LONG"]) {
    const f = fixture({ deferred: true }); f.gesture(); f.pending[0]({ ok: false, error }); await flush();
    assert.equal(f.events[0].reasonCodes[0], error); assert.equal(f.releases.length, 0);
  }
  const f = fixture({ deferred: true }); f.gesture(); f.pending[0]({ ok: true, analysis: {} }); await flush();
  assert.equal(f.events[0].disposition, "FAILED_SAFE"); assert.equal(f.releases.length, 0);
});
test("missing receipt yields one unverified event, removes listener and never retries", async () => {
  const f = fixture({ missingReceipt: true }); f.gesture(); await flush(); await f.tick(350);
  assert.equal(f.events[0].disposition, "RELEASED_UNVERIFIED"); assert.equal(f.receipts.size, 0);
  await f.tick(10000); assert.equal(f.events.length, 1); assert.deepEqual(f.releases, ["Hello"]);
});
test("offline telemetry cannot prevent local protection or release", async () => {
  const f = fixture({ throwTransport: true }); f.gesture(); await flush();
  assert.deepEqual(f.releases, ["Hello"]); assert.equal(f.events.length, 1);
});
test("write mismatch and a silently changed revision both prevent release", async () => {
  const mismatch = fixture(); mismatch.adapter.writeDraft = () => false; mismatch.gesture(); await flush();
  assert.equal(mismatch.events[0].reasonCodes[0], "RELEASE_WRITE_MISMATCH"); assert.equal(mismatch.releases.length, 0);
  const stale = fixture({ deferred: true }); stale.gesture();
  stale.adapter.readDraft = () => ({ text: "Hello", revision: 99 });
  stale.pending[0]({ ok: true, analysis: analyze({ text: "Hello", policy: DEFAULT_POLICY }) }); await flush();
  assert.equal(stale.events[0].reasonCodes[0], "EDITOR_CHANGED"); assert.equal(stale.releases.length, 0);
});
test("forged warning consent without acknowledgement fails closed", async () => {
  const f = fixture({ text: "CONFIDENTIAL project" }); f.gesture(); await flush();
  f.reviews[0].resolve({ approved: true, acknowledgeWarning: false }); await flush();
  assert.equal(f.releases.length, 0); assert.equal(f.events[0].disposition, "FAILED_SAFE");
});
test("destroy cancels pending work and prevents late release", async () => {
  const f = fixture({ deferred: true }); f.gesture(); f.gate.destroy();
  f.pending[0]({ ok: true, analysis: analyze({ text: "Hello", policy: DEFAULT_POLICY }) }); await flush();
  assert.equal(f.releases.length, 0); assert.equal(f.listeners.size, 0);
});
