import { test, expect, chromium } from "@playwright/test";
import { resolve, dirname, basename } from "node:path";
import { cp } from "node:fs/promises";

let context, page, worker, extensionId;
const received = () => page.locator("#shadow-received li");

// CDP inspection allows the test to examine a closed root without changing the product
// to an open root. Real approvals use mouse input; script clicks remain untrusted.
async function reviewNode(selector) {
  const session = await context.newCDPSession(page);
  const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  function find(node) {
    if (node.attributes?.includes("shadowshield-review-host")) return node;
    for (const child of [...node.children ?? [], ...node.shadowRoots ?? []]) { const result = find(child); if (result) return result; }
  }
  const host = find(root);
  if (!host?.shadowRoots?.length) { await session.detach(); return null; }
  const { object } = await session.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId });
  const { result } = await session.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(selector) { return this.querySelector(selector); }", arguments: [{ value: selector }] });
  if (!result.objectId) { await session.detach(); return null; }
  return { session, objectId: result.objectId };
}
async function reviewValue(selector, fn = "function() { return this.textContent; }") {
  const node = await reviewNode(selector);
  if (!node) return null;
  try { return (await node.session.send("Runtime.callFunctionOn", { objectId: node.objectId, functionDeclaration: fn, returnByValue: true })).result.value; }
  finally { await node.session.detach(); }
}
async function trustedReviewClick(selector) {
  const node = await reviewNode(selector);
  expect(node).not.toBeNull();
  try {
    const { result } = await node.session.send("Runtime.callFunctionOn", { objectId: node.objectId, functionDeclaration: "function() { const r = this.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }", returnByValue: true });
    await page.mouse.click(result.value.x, result.value.y);
  } finally { await node.session.detach(); }
}

test.beforeAll(async ({}, info) => {
  const extension = resolve("apps/extension/dist");
  let executablePath = process.env.SHADOWLENS_CHROMIUM_EXECUTABLE;
  // On this Windows sandbox, activation of cached Chrome assemblies fails outside
  // the workspace. Stage an unchanged copy; never alter the signed browser files.
  if (!executablePath && process.platform === "win32") {
    const source = dirname(chromium.executablePath());
    const target = resolve("apps/extension/.browser-runtime", basename(dirname(source)), basename(source));
    await cp(source, target, { recursive: true });
    executablePath = resolve(target, basename(chromium.executablePath()));
  }
  context = await chromium.launchPersistentContext(info.outputPath("profile"), { channel: "chromium", executablePath, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  worker.on("console", message => console.error("Extension worker console:", message.type(), message.text()));
  worker.on("pageerror", error => console.error("Extension worker error:", error.message));
  extensionId = new URL(worker.url()).host;
  page = await context.newPage();
  page.on("pageerror", error => console.error("Sandbox runtime error:", error.message));
});
test.afterAll(async () => { await context?.close(); });
test.beforeEach(async () => {
  await page.goto("http://localhost:4173");
  await expect(page.locator("#coverage")).toContainText("SANDBOX GUARDED");
});

test("ALLOW delivers exactly once; editor clicks and Shift+Enter do not send", async () => {
  await page.locator("#shadow-composer").fill("Hello local sandbox");
  await page.locator("#shadow-composer").click();
  await expect(received()).toHaveCount(0);
  await page.locator("#shadow-composer").press("Shift+Enter");
  await expect(received()).toHaveCount(0);
  await page.locator("#shadow-composer").fill("Hello local sandbox");
  await page.locator("#shadow-composer").press("Enter");
  await expect(received()).toHaveText(["Hello local sandbox"]);
});
test("REDACT previews and delivers the exact approved string with the real engine", async ({}, info) => {
  await page.locator("#shadow-composer").fill("Contact person@shop.invalid");
  await page.locator("#shadow-send").click();
  await expect(page.locator("#shadowshield-review-host")).toHaveCount(1);
  expect(await reviewValue(".preview")).toBe("Contact [REDACTED_PII]");
  expect(await page.locator("#shadowshield-review-host").evaluate(el => el.shadowRoot)).toBeNull();
  await reviewValue(".approve", "function() { this.click(); return true; }");
  await expect(received()).toHaveCount(0);
  await trustedReviewClick(".approve");
  await expect(received()).toHaveText(["Contact [REDACTED_PII]"]);
  await expect(page.locator("#shadowshield-review-host")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("redacted-receiver.png"), fullPage: true });
});
test("WARN requires separate trusted acknowledgement and trusted approval", async () => {
  await page.locator("#shadow-composer").fill("CONFIDENTIAL project notes");
  await page.locator("#shadow-send").click();
  await expect(page.locator("#shadowshield-review-host")).toHaveCount(1);
  await trustedReviewClick(".approve");
  await expect(received()).toHaveCount(0);
  await reviewValue(".ack", "function() { this.click(); return true; }");
  await trustedReviewClick(".approve");
  await expect(received()).toHaveCount(0);
  await trustedReviewClick(".ack");
  await trustedReviewClick(".approve");
  await expect(received()).toHaveText(["CONFIDENTIAL project notes"]);
});
test("BLOCK never reaches the receiver and the next clean attempt works", async () => {
  await page.locator("#shadow-composer").fill("-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----");
  await page.locator("#shadow-send").click();
  await expect(received()).toHaveCount(0);
  await page.locator("#shadow-composer").fill("Clean next attempt");
  await page.locator("#shadow-send").click();
  await expect(received()).toHaveText(["Clean next attempt"]);
});
test("editing while reviewing cancels consent and preserves the new draft", async () => {
  await page.locator("#shadow-composer").fill("Contact person@shop.invalid");
  await page.locator("#shadow-send").click();
  await expect(page.locator("#shadowshield-review-host")).toHaveCount(1);
  await page.locator("#shadow-composer").fill("Changed draft");
  await expect(page.locator("#shadowshield-review-host")).toHaveCount(0);
  await expect(received()).toHaveCount(0);
  await expect(page.locator("#shadow-composer")).toHaveValue("Changed draft");
});
test("cancel and Escape never release; duplicate send gestures open one review", async () => {
  await page.locator("#shadow-composer").fill("Contact person@shop.invalid");
  await page.locator("#shadow-send").dblclick();
  await expect(page.locator("#shadowshield-review-host")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#shadowshield-review-host")).toHaveCount(0);
  await expect(received()).toHaveCount(0);
});
test("oversized input fails closed without releasing the original", async () => {
  await page.locator("#shadow-composer").fill("x".repeat(250001));
  await page.locator("#shadow-send").click();
  await page.waitForTimeout(150);
  await expect(received()).toHaveCount(0);
  await expect(page.locator("#shadow-composer")).toHaveValue("x".repeat(250001));
});
test("origin scope excludes API/dashboard and altered sandbox hosts", async () => {
  const other = await context.newPage();
  await context.route("http://127.0.0.1:8787/**", route => route.fulfill({ contentType: "text/html", body: '<textarea id="shadow-composer"></textarea><button id="shadow-send">Send</button>' }));
  for (const path of ["dashboard", "api/v1/health"]) {
    await other.goto(`http://127.0.0.1:8787/${path}`);
    expect(await other.locator("html").getAttribute("data-shadowshield-coverage")).toBeNull();
  }
  await other.close();
  await context.unroute("http://127.0.0.1:8787/**");
});
test("Options stores a synthetic credential only in trusted session storage and clears the field", async () => {
  const options = await context.newPage();
  const consoleMessages = [];
  const collectConsole = message => consoleMessages.push(message.text());
  options.on("console", collectConsole); worker.on("console", collectConsole); page.on("console", collectConsole);
  await options.goto(`chrome-extension://${extensionId}/options/index.html`);
  await options.locator("#device-id").fill("7a3b0f7a-7781-4ff1-9c67-50cb8569da51");
  await options.locator("#credential").fill("synthetic-device-credential-1234");
  await options.locator("#connect").click();
  await expect(options.locator("#credential")).toHaveValue("");
  await expect(options.locator("#status")).toContainText(/Credential saved|Connected|unavailable|reconnect/i);
  expect(await worker.evaluate(async () => (await chrome.storage.session.get("deviceCredential")).deviceCredential)).toBe("synthetic-device-credential-1234");
  expect(await worker.evaluate(async () => (await chrome.storage.local.get("shadowshieldProvisionedDeviceId")).shadowshieldProvisionedDeviceId)).toBe("7a3b0f7a-7781-4ff1-9c67-50cb8569da51");
  expect(JSON.stringify(await worker.evaluate(async () => await chrome.storage.local.get(null)))).not.toContain("synthetic-device-credential-1234");
  expect(await page.content()).not.toContain("synthetic-device-credential-1234");
  expect(await options.content()).not.toContain("synthetic-device-credential-1234");
  expect(consoleMessages.join("\n")).not.toContain("synthetic-device-credential-1234");
  options.off("console", collectConsole); worker.off("console", collectConsole); page.off("console", collectConsole);
  await options.close();
});

test("opt-in domain observation queues a redacted site visit, never the secret URL", async () => {
  await page.bringToFront();
  await worker.evaluate(async () => { await chrome.storage.local.set({ shadowshieldProvisionedDeviceId: "7a3b0f7a-7781-4ff1-9c67-50cb8569da51" }); });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/index.html`);
  await expect(options.locator("#observe-domains")).not.toBeChecked();
  await options.locator("#observe-domains").check();
  await expect(options.locator("#observe-domains")).toBeChecked();
  await options.close();
  const sentinel = "synthetic-private-query-value";
  await context.route("https://chatgpt.com/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>synthetic site</title>" }));
  await page.goto(`https://chatgpt.com/?prompt=${sentinel}`);
  await expect.poll(async () => worker.evaluate(async () => (await chrome.storage.local.get("shadowshieldSanitizedEventQueue")).shadowshieldSanitizedEventQueue?.length ?? 0)).toBeGreaterThan(0);
  const queued = await worker.evaluate(async () => (await chrome.storage.local.get("shadowshieldSanitizedEventQueue")).shadowshieldSanitizedEventQueue);
  const visit = queued.find(entry => entry.event.kind === "SITE_VISIT").event;
  expect(visit.siteId).toBe("CHATGPT"); expect(visit.supportStatus).toBe("UNSUPPORTED");
  expect(JSON.stringify(visit)).not.toContain(sentinel); expect(JSON.stringify(visit)).not.toContain("prompt"); expect(Object.hasOwn(visit, "url")).toBe(false);
  await context.unroute("https://chatgpt.com/**");
});

test("popup renders active-tab coverage and disconnected status, then opens Settings", async () => {
  await page.bringToFront();
  const popupCreated = context.waitForEvent("page");
  await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup/index.html"), active: false }));
  const popup = await popupCreated;
  await expect(popup.locator("#coverage")).toContainText("Guard active");
  await expect(popup.locator("#connection")).toContainText(/not configured|unavailable|reconnect/i);
  await expect(popup.locator("#indicator")).toHaveClass(/active/);
  const optionsCreated = context.waitForEvent("page");
  await popup.locator("#open-options").click();
  const options = await optionsCreated;
  await expect(options).toHaveURL(`chrome-extension://${extensionId}/options/index.html`);
  await expect(options.locator("#status")).toContainText(/not configured|unavailable|reconnect/i);
  await options.close(); await popup.close();
});

test("lost composer compatibility displays UNPROTECTED and returns when restored", async () => {
  await page.locator("#shadow-send").evaluate(button => { button.id = "missing-send"; });
  await expect(page.locator("#coverage")).toContainText("UNPROTECTED");
  await page.locator("#missing-send").evaluate(button => { button.id = "shadow-send"; });
  await expect(page.locator("#coverage")).toContainText("SANDBOX GUARDED");
});

test("synthetic page clicks cannot authorize a send", async () => {
  await page.locator("#shadow-composer").fill("Hello synthetic test");
  await page.locator("#shadow-send").evaluate(button => button.click());
  await expect(received()).toHaveCount(0);
  await expect(page.locator("#shadowshield-review-host")).toHaveCount(0);
});
