namespace ShadowShield.Options {
  const input = document.querySelector<HTMLInputElement>("#credential")!;
  const status = document.querySelector<HTMLElement>("#status")!;
  const connect = document.querySelector<HTMLButtonElement>("#connect")!;
  const deviceId = document.querySelector<HTMLInputElement>("#device-id")!;
  const observation = document.querySelector<HTMLInputElement>("#observe-domains")!;
  connect.addEventListener("click", () => {
    if (connect.disabled) return;
    const token = input.value;
    const id = deviceId.value.trim();
    if (!token.trim() || !id) { status.textContent = "Enter the provisioned device ID and bearer token."; return; }
    input.value = ""; deviceId.value = ""; connect.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: "SET_DEVICE_CREDENTIAL", token, deviceId: id }, (response) => {
        connect.disabled = false;
        status.textContent = !chrome.runtime.lastError && response?.ok ? "Credential saved for this browser session." : "Could not save credential for this session.";
        if (response?.ok) chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATUS" }, connection => {
          if (!chrome.runtime.lastError && connection?.message) status.textContent = connection.message;
        });
      });
    } catch { connect.disabled = false; status.textContent = "Could not save credential for this session."; }
  });
  chrome.runtime.sendMessage({ type: "GET_CONNECTION_STATUS" }, (response) => {
    status.textContent = !chrome.runtime.lastError && response?.message || "Dashboard connection unavailable";
  });
  chrome.runtime.sendMessage({ type: "GET_DOMAIN_OBSERVATION" }, response => { observation.checked = !chrome.runtime.lastError && response?.enabled === true; });
  observation.addEventListener("change", () => {
    const requestedState = observation.checked;
    observation.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: "SET_DOMAIN_OBSERVATION", enabled: requestedState }, response => {
        observation.disabled = false;
        if (chrome.runtime.lastError || response?.ok !== true) observation.checked = !requestedState;
      });
    } catch { observation.disabled = false; observation.checked = !requestedState; }
  });
}
