namespace ShadowShield.Options {
  const input = document.querySelector<HTMLInputElement>("#credential")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  const connect = document.querySelector<HTMLButtonElement>("#connect")!;
  connect.addEventListener("click", () => {
    if (connect.disabled) return;
    const token = input.value;
    if (!token.trim()) { status.textContent = "Enter the provisioned device credential."; return; }
    input.value = ""; connect.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: "SET_DEVICE_CREDENTIAL", token }, (response) => {
        connect.disabled = false;
        status.textContent = !chrome.runtime.lastError && response?.ok ? "Credential saved for this browser session. Service connection is not configured yet." : "Could not save credential for this session.";
      });
    } catch { connect.disabled = false; status.textContent = "Could not save credential for this session."; }
  });
  chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATUS" }, (response) => {
    status.textContent = !chrome.runtime.lastError && response?.message || "Dashboard connection unavailable";
  });
}
