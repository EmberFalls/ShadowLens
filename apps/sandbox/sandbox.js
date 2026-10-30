const composer = document.querySelector("#shadow-composer");
const receive = document.querySelector("#shadow-received");
const empty = document.querySelector("#empty");
const coverage = document.querySelector("#coverage");
let nextAttempt = 1;

function updateCoverage() {
  const guarded = document.documentElement.dataset.shadowshieldCoverage === "SANDBOX_GUARDED";
  coverage.textContent = guarded ? "SANDBOX GUARDED · local review active" : "UNPROTECTED · no guard detected";
}
updateCoverage();
new MutationObserver(updateCoverage).observe(document.documentElement, { attributes: true, attributeFilter: ["data-shadowshield-coverage"] });

function appendReceived(text, attemptId) {
  const item = document.createElement("li");
  item.textContent = text;
  receive.append(item);
  empty.hidden = true;
  document.dispatchEvent(new CustomEvent("shadowshield:receipt", { detail: { protocol: "v2", attemptId, status: "ACCEPTED" } }));
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
  appendReceived(composer.value, detail.attemptId);
  composer.value = "";
});
document.querySelector("#clear").addEventListener("click", () => {
  receive.replaceChildren();
  empty.hidden = false;
});
