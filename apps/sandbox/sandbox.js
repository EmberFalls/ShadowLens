const composer = document.querySelector("#shadow-composer");
const receive = document.querySelector("#shadow-received");
const empty = document.querySelector("#empty");
const coverage = document.querySelector("#coverage");
let nextAttempt = 1;

/**
 * Cooperative sandbox fixture for the A1 adapter. attemptId is an opaque
 * correlation ID, never an authorization token.
 * @typedef {{ protocol: "v2", attemptId: string }} SandboxSubmitRequestV2
 * @typedef {{ protocol: "v2", attemptId: string, status: "ACCEPTED" }} SandboxReceiptV2
 */
const acceptedAttempts = new Set();

function updateCoverage() {
  const guarded = document.documentElement.dataset.shadowshieldCoverage === "SANDBOX_GUARDED";
  coverage.textContent = guarded ? "SANDBOX GUARDED · local review active" : "UNPROTECTED · synthetic examples only";
}
updateCoverage();
new MutationObserver(updateCoverage).observe(document.documentElement, { attributes: true, attributeFilter: ["data-shadowshield-coverage"] });

function appendReceived(text, attemptId) {
  const item = document.createElement("li");
  item.textContent = text;
  receive.append(item);
  empty.hidden = true;
}

function emitReceipt(attemptId) {
  /** @type {SandboxReceiptV2} */
  const receipt = { protocol: "v2", attemptId, status: "ACCEPTED" };
  document.dispatchEvent(new CustomEvent("shadowshield:receipt", { detail: receipt }));
}

function onNormalSend(event) {
  event.preventDefault();
  appendReceived(composer.value, `unprotected-${nextAttempt++}`);
  composer.value = "";
}
document.querySelector("#shadow-send").addEventListener("click", onNormalSend);
composer.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) onNormalSend(event);
});
composer.addEventListener("shadowshield:submit-request", (event) => {
  const detail = event.detail;
  if (detail?.protocol !== "v2" || typeof detail.attemptId !== "string" || !detail.attemptId) return;
  // Correlation prevents accidental duplicate delivery; this page event is
  // still directly forgeable and never grants authorization.
  if (acceptedAttempts.has(detail.attemptId)) return;
  acceptedAttempts.add(detail.attemptId);
  appendReceived(composer.value, detail.attemptId);
  composer.value = "";
  emitReceipt(detail.attemptId);
});
document.querySelector("#clear").addEventListener("click", () => {
  receive.replaceChildren();
  empty.hidden = false;
});
