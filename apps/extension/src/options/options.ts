namespace ShadowShield.Options {
  const input = document.querySelector<HTMLInputElement>("#credential")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  document.querySelector<HTMLButtonElement>("#connect")!.addEventListener("click", () => {
    const token = input.value;
    if (!token.trim()) { status.textContent = "Enter the provisioned device credential."; return; }
    chrome.runtime.sendMessage({ type: "SET_DEVICE_CREDENTIAL", token }, (response) => {
      input.value = "";
      status.textContent = response?.ok ? "Credential saved for this browser session. Service connection is not configured yet." : "Could not save credential for this session.";
    });
  });
  chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATUS" }, (response) => {
    status.textContent = response?.message ?? "Dashboard connection unavailable";
  });
}
